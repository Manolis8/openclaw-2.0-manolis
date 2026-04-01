import OpenAI from 'openai'
import { sendCdpCommand, sendExtensionMessage } from '../index.js'
import { isProviderConnected } from './api-caller.js'
import { createMessage } from './scheduler.js'
import { supabase } from './supabase.js'
import * as gmail from './integrations/gmail.js'
import * as notion from './integrations/notion.js'
import * as slack from './integrations/slack.js'
import * as github from './integrations/github.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const runningTasks = new Set<string>()

type RoleRef = { role: string; name?: string; nth?: number }
type RoleRefMap = Record<string, RoleRef>

const INTERACTIVE_ROLES = new Set([
  'button','link','textbox','checkbox','radio','combobox','listbox',
  'menuitem','menuitemcheckbox','menuitemradio','option','searchbox',
  'slider','spinbutton','switch','tab','treeitem'
])

const tabRoleRefs = new Map<number, { refs: RoleRefMap; lastUrl: string }>()
const currentSnapshotNodes = new Map<number, AriaSnapshotNode[]>()

type StepLog = {
  step: number
  description: string
  action: string
  success: boolean
  errorMsg?: string
}

type AriaSnapshotNode = {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  backendDOMNodeId?: number
  depth: number
}

type RawAXNode = {
  nodeId?: string
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string }
  description?: { value?: string }
  childIds?: string[]
  backendDOMNodeId?: number
}

function axValue(v: unknown): string {
  if (!v || typeof v !== 'object') return ''
  const value = (v as { value?: unknown }).value
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function formatAriaSnapshot(nodes: RawAXNode[], limit: number): AriaSnapshotNode[] {
  const byId = new Map<string, RawAXNode>()
  for (const n of nodes) { if (n.nodeId) byId.set(n.nodeId, n) }
  const referenced = new Set<string>()
  for (const n of nodes) { for (const c of n.childIds ?? []) referenced.add(c) }
  const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) ?? nodes[0]
  if (!root?.nodeId) return []
  const out: AriaSnapshotNode[] = []
  const stack: Array<{ id: string; depth: number }> = [{ id: root.nodeId, depth: 0 }]
  while (stack.length && out.length < limit) {
    const popped = stack.pop()
    if (!popped) break
    const { id, depth } = popped
    const n = byId.get(id)
    if (!n) continue
    const role = axValue(n.role)
    const name = axValue(n.name)
    const value = axValue(n.value)
    const description = axValue(n.description)
    const ref = `e${out.length + 1}`
    out.push({ ref, role: role || 'unknown', name: name || '', ...(value ? { value } : {}), ...(description ? { description } : {}), depth })
    const children = (n.childIds ?? []).filter((c) => byId.has(c))
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child) stack.push({ id: child, depth: depth + 1 })
    }
  }
  return out
}

function buildRoleRefsFromNodes(nodes: AriaSnapshotNode[]): { snapshot: string; refs: RoleRefMap } {
  const refs: RoleRefMap = {}
  const counts = new Map<string, number>()
  const refsByKey = new Map<string, string[]>()
  const lines: string[] = []

  const getKey = (role: string, name?: string) => `${role}:${name ?? ''}`

  for (const node of nodes) {
    if (!INTERACTIVE_ROLES.has(node.role)) continue

    const key = getKey(node.role, node.name)
    const nth = counts.get(key) ?? 0
    counts.set(key, nth + 1)

    const existing = refsByKey.get(key) ?? []
    existing.push(node.ref)
    refsByKey.set(key, existing)

    refs[node.ref] = { role: node.role, name: node.name || undefined, nth }
    lines.push(`[${node.ref}] ${node.role}${node.name ? ` "${node.name}"` : ''}${nth > 0 ? ` (${nth})` : ''}`)
  }

  for (const [ref, data] of Object.entries(refs)) {
    const key = getKey(data.role, data.name)
    const list = refsByKey.get(key) ?? []
    if (list.length <= 1) {
      delete refs[ref].nth
    }
  }

  return { snapshot: lines.join('\n') || '(no interactive elements)', refs }
}

const snapshotRefs = new Map<number, AriaSnapshotNode[]>()
const tabUrls = new Map<number, string>()

async function waitForPageStable(userId: string, tabId: number, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastUrl = ''
  let stableCount = 0
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300))
    const result = await sendCdpCommand(userId, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ url: window.location.href, ready: document.readyState })',
      returnByValue: true
    }, tabId)
    const parsed = JSON.parse(result?.result?.value ?? '{}')
    const url: string = parsed.url || ''
    const ready: string = parsed.ready || ''
    if (url === lastUrl && ready === 'complete') {
      stableCount++
      if (stableCount >= 2) return url
    } else {
      stableCount = 0
      lastUrl = url
    }
  }
  return lastUrl
}

async function waitForText(userId: string, tabId: number, text: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await sendCdpCommand(userId, 'Runtime.evaluate', {
      expression: `document.body.innerText.includes(${JSON.stringify(text)})`,
      returnByValue: true
    }, tabId)
    if (result?.result?.value) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

async function snapshotPage(userId: string, tabId: number): Promise<string> {
  await sendCdpCommand(userId, 'Accessibility.enable', {}, tabId)
  const axTree = await sendCdpCommand(userId, 'Accessibility.getFullAXTree', {}, tabId)
  const rawNodes: RawAXNode[] = axTree?.nodes ?? []
  const nodes = formatAriaSnapshot(rawNodes, 500)
  snapshotRefs.set(tabId, nodes)
  currentSnapshotNodes.set(tabId, nodes)

  const urlResult = await sendCdpCommand(userId, 'Runtime.evaluate', {
    expression: 'window.location.href',
    returnByValue: true
  }, tabId)
  const url = urlResult?.result?.value || 'unknown'
  tabUrls.set(tabId, url)

  const built = buildRoleRefsFromNodes(nodes)
  tabRoleRefs.set(tabId, { refs: built.refs, lastUrl: url })

  return `URL: ${url}\n\nPage elements (use these refs to interact):\n${built.snapshot}`
}

async function resolveRefToCoordinates(
  userId: string,
  tabId: number,
  ref: string
): Promise<{ x: number; y: number; found?: boolean; tag?: string; actualName?: string; backendDOMNodeId?: number }> {
  const stored = tabRoleRefs.get(tabId)
  if (!stored) throw new Error(`No snapshot for tab ${tabId}. Take a snapshot first.`)

  const info = stored.refs[ref]
  if (!info) throw new Error(`Unknown ref "${ref}". Run a new snapshot — refs may be stale.`)

  const axNode = currentSnapshotNodes.get(tabId)?.find(n => n.ref === ref)
  if (axNode?.backendDOMNodeId) {
    try {
      await sendCdpCommand(userId, 'DOM.enable', {}, tabId)
      const resolved = await sendCdpCommand(userId, 'DOM.resolveNode', {
        backendNodeId: axNode.backendDOMNodeId
      }, tabId)
      const domNodeId = resolved?.node?.nodeId
      if (domNodeId) {
        const result = await sendCdpCommand(userId, 'DOM.getBoxModel', {
          nodeId: domNodeId
        }, tabId)
        const quad = result?.model?.border
        if (quad && quad.length >= 8) {
          const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4)
          const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4)
          return { x, y, found: true, backendDOMNodeId: axNode.backendDOMNodeId }
        }
      }
    } catch { /* fall through */ }
  }

  const { role, name, nth = 0 } = info
  const expr = `
    (() => {
      const role = ${JSON.stringify(role)};
      const name = ${JSON.stringify(name ?? '')};
      const nth = ${JSON.stringify(nth)};

      function matchesRole(el) {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit === role;
        const tag = el.tagName.toLowerCase();
        const typeAttr = el.getAttribute('type') || '';
        if (role === 'button') return tag === 'button' || (tag === 'input' && ['button','submit'].includes(typeAttr)) || el.getAttribute('role') === 'button';
        if (role === 'link') return tag === 'a' && el.href;
        if (role === 'textbox') return (tag === 'input' && !['button','checkbox','radio','submit','file'].includes(typeAttr)) || tag === 'textarea' || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';
        if (role === 'checkbox') return tag === 'input' && typeAttr === 'checkbox';
        if (role === 'combobox') return tag === 'select';
        if (role === 'searchbox') return tag === 'input' && typeAttr === 'search';
        return el.getAttribute('role') === role;
      }

      function getAccessibleName(el) {
        const ariaLabel = el.getAttribute('aria-label') || '';
        if (ariaLabel) return ariaLabel.trim();
        const ariaLabelledBy = el.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
          const labelEl = document.getElementById(ariaLabelledBy);
          if (labelEl) return labelEl.textContent?.trim() || '';
        }
        const placeholder = el.getAttribute('placeholder') || '';
        if (placeholder) return placeholder.trim();
        const text = el.textContent?.trim() || '';
        if (text) return text;
        return (el.getAttribute('title') || el.getAttribute('value') || '').trim();
      }

      const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
        if (!matchesRole(el)) return false;
        if (!name) return true;
        const n = getAccessibleName(el);
        return n === name || n.toLowerCase().includes(name.toLowerCase());
      });

      const el = candidates[nth] || candidates[0];
      if (!el) return null;

      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      if (r.bottom < 0 || r.top > window.innerHeight) return null;

      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        found: true,
        tag: el.tagName.toLowerCase(),
        actualName: getAccessibleName(el)
      };
    })()
  `

  const result = await sendCdpCommand(userId, 'Runtime.evaluate', {
    expression: expr, returnByValue: true
  }, tabId)
  const pos = result?.result?.value
  if (!pos?.found) {
    throw new Error(`could not locate element ${ref} (${role} "${name ?? ''}")`)
  }
  return pos
}

async function clickElement(userId: string, tabId: number, ref: string): Promise<void> {
  const { x, y } = await resolveRefToCoordinates(userId, tabId, ref)
  await sendCdpCommand(userId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, tabId)
  await new Promise(r => setTimeout(r, 80))
  await sendCdpCommand(userId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, tabId)
  await new Promise(r => setTimeout(r, 400))
}

async function typeInElement(userId: string, tabId: number, ref: string, text: string): Promise<void> {
  const { x, y, backendDOMNodeId } = await resolveRefToCoordinates(userId, tabId, ref)
  if (backendDOMNodeId) {
    await sendCdpCommand(userId, 'DOM.focus', { backendNodeId: backendDOMNodeId }, tabId).catch(() => {})
  } else {
    await sendCdpCommand(userId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, tabId)
    await new Promise(r => setTimeout(r, 50))
    await sendCdpCommand(userId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, tabId)
    await new Promise(r => setTimeout(r, 100))
  }
  await sendCdpCommand(userId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 }, tabId)
  await sendCdpCommand(userId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 }, tabId)
  await sendCdpCommand(userId, 'Input.insertText', { text }, tabId)
}

const KEY_DEFS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  'Enter': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  'Tab': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  'Escape': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  'Backspace': { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  'Delete': { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  'Space': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
  'Return': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
}

async function pressKey(userId: string, tabId: number, key: string): Promise<void> {
  const def = KEY_DEFS[key] || { key, code: key, windowsVirtualKeyCode: 0 }
  await sendCdpCommand(userId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...def }, tabId)
  await new Promise(r => setTimeout(r, 50))
  await sendCdpCommand(userId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...def }, tabId)
  await new Promise(r => setTimeout(r, 200))
}

async function navigateTab(userId: string, tabId: number, url: string): Promise<number> {
  await sendCdpCommand(userId, 'Page.navigate', { url }, tabId)
  const finalUrl = await waitForPageStable(userId, tabId)
  const resolvedTabId = await resolveTabIdAfterNavigate({ userId, oldTabId: tabId, navigatedUrl: finalUrl })
  if (resolvedTabId !== tabId) {
    console.log(`↗️ Tab ID updated: ${tabId} → ${resolvedTabId}`)
  }
  return resolvedTabId
}

async function resolveTabIdAfterNavigate(opts: {
  userId: string
  oldTabId: number
  navigatedUrl: string
}): Promise<number> {
  let currentTabId = opts.oldTabId
  try {
    await new Promise(r => setTimeout(r, 500))
    const result = await sendExtensionMessage(opts.userId, 'listTabs', {}, 5000)
    const tabs: Array<{ id: number; url: string }> = result?.tabs ?? []
    if (!tabs.length) return currentTabId

    const oldExists = tabs.some(t => t.id === opts.oldTabId)
    if (!oldExists) {
      const byUrl = tabs.filter(t => t.url === opts.navigatedUrl || t.url.startsWith(opts.navigatedUrl))
      const replacement = byUrl.find(t => t.id !== opts.oldTabId) ?? byUrl[0]
      if (replacement) {
        currentTabId = replacement.id
        for (const [map] of [
          [snapshotRefs],
          [currentSnapshotNodes],
          [tabUrls],
          [tabRoleRefs]
        ] as const) {
          const old = (map as Map<number, unknown>).get(opts.oldTabId)
          if (old !== undefined) {
            (map as Map<number, unknown>).set(currentTabId, old)
            ;(map as Map<number, unknown>).delete(opts.oldTabId)
          }
        }
      }
    }
  } catch {
    // best effort — fall back to original tabId
  }
  return currentTabId
}

async function initializeTab(userId: string): Promise<number | null> {
  try {
    const result = await sendExtensionMessage(userId, 'createAndAttachTab', { url: 'about:blank' }, 10000)
    console.log('initializeTab result:', JSON.stringify(result))
    await new Promise(r => setTimeout(r, 1000))
    const tabId = result?.tabId || null
    console.log('Using tabId:', tabId)
    return tabId
  } catch (err) {
    console.error('initializeTab failed:', err)
    return null
  }
}

// ─── Browser tools for the LLM agent loop ───

const browserTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Read the current page as an accessibility tree. Returns interactive elements with stable refs like e1, e2, e3. Always call this first to see what\'s on the page. Call again after any action to see what changed.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate to a URL. Wait for page to stabilize before snapshotting.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL to navigate to' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element by its ref from the last snapshot.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'Element ref from snapshot e.g. e3' } },
        required: ['ref']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into a textbox or input element.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot' },
          text: { type: 'string', description: 'Text to type' },
          submit: { type: 'boolean', description: 'Press Enter after typing' }
        },
        required: ['ref', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_key',
      description: 'Press a keyboard key. Use for Enter, Tab, Escape, ArrowDown etc.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Key name e.g. Enter, Tab, Escape' } },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the page up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'number', description: 'Pixels to scroll, default 300' }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: 'Wait for a condition before continuing. Use after navigation or actions that trigger loading.',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: 'Milliseconds to wait' },
          text: { type: 'string', description: 'Wait until this text appears on page' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_hover',
      description: 'Hover the mouse over an element by its ref from the last snapshot.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'Element ref from snapshot e.g. e3' } },
        required: ['ref']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description: 'Call this when the task is fully done. Provide a one-sentence summary.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'What was accomplished' } },
        required: ['summary']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_failed',
      description: 'Call this if the task cannot be completed. Explain what failed and why.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why the task failed' } },
        required: ['reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_list',
      description: 'List recent emails from Gmail',
      parameters: {
        type: 'object',
        properties: { maxResults: { type: 'number' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_send',
      description: 'Send an email via Gmail',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_read',
      description: 'Get content of a specific email',
      parameters: {
        type: 'object',
        properties: { messageId: { type: 'string' } },
        required: ['messageId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_summarize',
      description: 'Get a summary of recent emails',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notion_create_page',
      description: 'Create a new page in Notion',
      parameters: {
        type: 'object',
        properties: {
          parentId: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['parentId', 'title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notion_list_databases',
      description: 'List Notion databases',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notion_query_database',
      description: 'Query a Notion database',
      parameters: {
        type: 'object',
        properties: { databaseId: { type: 'string' } },
        required: ['databaseId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'slack_send',
      description: 'Send a message to a Slack channel',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          text: { type: 'string' }
        },
        required: ['channel', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'slack_list_channels',
      description: 'List Slack channels',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'slack_read_messages',
      description: 'Read recent messages from a Slack channel',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['channel']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_create_issue',
      description: 'Create a GitHub issue',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['owner', 'repo', 'title', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_list_repos',
      description: 'List GitHub repositories',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_list_issues',
      description: 'List GitHub issues in a repository',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          state: { type: 'string' }
        },
        required: ['owner', 'repo']
      }
    }
  }
]

const AGENT_SYSTEM_PROMPT = `You are Felo, an AI browser agent. You control a real Chrome browser tab to complete tasks.

You have browser tools available. Use them to complete the task:
1. Start with browser_snapshot to see the current page
2. Based on what you see, decide your next action
3. After every click or type, call browser_snapshot again to see what changed
4. Keep acting until the task is done, then call task_complete

Rules:
- Never assume what's on the page — always snapshot first
- Use exact refs from the most recent snapshot (refs change after navigation)
- If you see a login form but the task doesn't require login, the user may already be logged in on another tab — navigate directly to the relevant page
- If an action fails, snapshot again to see the current state and try a different approach
- When the task is done, call task_complete with a one-sentence summary`

// ─── Agent execution loop ───

async function executeBrowserTool(
  toolName: string,
  args: Record<string, any>,
  userId: string,
  tabId: number,
  onProgress: (msg: string) => void
): Promise<{ result: string; newTabId?: number }> {
  switch (toolName) {
    case 'browser_snapshot': {
      onProgress('📸 Reading page...')
      return { result: await snapshotPage(userId, tabId) }
    }
    case 'browser_navigate': {
      onProgress(`🌐 Navigating to ${args.url}...`)
      const newTabId = await navigateTab(userId, tabId, args.url)
      return { result: `Navigated to ${args.url}`, newTabId }
    }
    case 'browser_click': {
      onProgress(`🖱️ Clicking ${args.ref}...`)
      await clickElement(userId, tabId, args.ref)
      await waitForPageStable(userId, tabId, 1000).catch(() => {})
      return { result: `Clicked ${args.ref}` }
    }
    case 'browser_type': {
      onProgress(`⌨️ Typing into ${args.ref}...`)
      await typeInElement(userId, tabId, args.ref, args.text)
      if (args.submit) {
        await pressKey(userId, tabId, 'Enter')
      }
      return { result: `Typed "${args.text}" into ${args.ref}` }
    }
    case 'browser_key': {
      onProgress(`⌨️ Pressing ${args.key}...`)
      await pressKey(userId, tabId, args.key)
      return { result: `Pressed ${args.key}` }
    }
    case 'browser_scroll': {
      const amount = args.amount ?? 300
      const deltaY = args.direction === 'down' ? amount : -amount
      const vp = await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: 'JSON.stringify({x: window.innerWidth/2, y: window.innerHeight/2})',
        returnByValue: true
      }, tabId)
      const center = vp?.result?.value ? JSON.parse(vp.result.value) : { x: 400, y: 300 }
      await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY
      }, tabId)
      await new Promise(r => setTimeout(r, 300))
      return { result: `Scrolled ${args.direction} ${amount}px` }
    }
    case 'browser_wait': {
      if (args.ms) {
        onProgress(`⏳ Waiting ${args.ms}ms...`)
        await new Promise(r => setTimeout(r, Math.min(args.ms, 10000)))
      }
      if (args.text) {
        onProgress(`⏳ Waiting for "${args.text}"...`)
        const found = await waitForText(userId, tabId, args.text, 5000)
        return { result: found ? `Text "${args.text}" appeared` : `Text "${args.text}" not found after 5s` }
      }
      return { result: 'Done waiting' }
    }
    case 'browser_hover': {
      onProgress(`🖱️ Hovering over ${args.ref}...`)
      const { x, y } = await resolveRefToCoordinates(userId, tabId, args.ref)
      await sendCdpCommand(userId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, tabId)
      await new Promise(r => setTimeout(r, 200))
      return { result: `Hovered over ${args.ref}` }
    }
    case 'gmail_list': {
      const connected = await isProviderConnected(userId, 'gmail')
      if (!connected) return { result: 'Gmail not connected. Ask user to connect Gmail.' }
      return { result: JSON.stringify(await gmail.listEmails(userId, { maxResults: args.maxResults || 10 }), null, 2) }
    }
    case 'gmail_send': {
      const connected = await isProviderConnected(userId, 'gmail')
      if (!connected) return { result: 'Gmail not connected. Ask user to connect Gmail.' }
      await gmail.sendEmail(userId, args.to, args.subject, args.body)
      return { result: `Email sent to ${args.to}` }
    }
    case 'gmail_read': {
      const connected = await isProviderConnected(userId, 'gmail')
      if (!connected) return { result: 'Gmail not connected. Ask user to connect Gmail.' }
      return { result: (await gmail.getEmailContent(userId, args.messageId)).slice(0, 2000) }
    }
    case 'gmail_summarize': {
      const connected = await isProviderConnected(userId, 'gmail')
      if (!connected) return { result: 'Gmail not connected. Ask user to connect Gmail.' }
      return { result: await gmail.summarizeEmails(userId) }
    }
    case 'notion_create_page': {
      const connected = await isProviderConnected(userId, 'notion')
      if (!connected) return { result: 'Notion not connected. Ask user to connect Notion.' }
      await notion.createPage(userId, args.parentId, args.title, args.content)
      return { result: `Created Notion page: ${args.title}` }
    }
    case 'notion_list_databases': {
      const connected = await isProviderConnected(userId, 'notion')
      if (!connected) return { result: 'Notion not connected. Ask user to connect Notion.' }
      return { result: JSON.stringify(await notion.listDatabases(userId), null, 2) }
    }
    case 'notion_query_database': {
      const connected = await isProviderConnected(userId, 'notion')
      if (!connected) return { result: 'Notion not connected. Ask user to connect Notion.' }
      return { result: JSON.stringify(await notion.queryDatabase(userId, args.databaseId), null, 2) }
    }
    case 'slack_send': {
      const connected = await isProviderConnected(userId, 'slack')
      if (!connected) return { result: 'Slack not connected. Ask user to connect Slack.' }
      await slack.sendMessage(userId, args.channel, args.text)
      return { result: `Sent message to ${args.channel}` }
    }
    case 'slack_list_channels': {
      const connected = await isProviderConnected(userId, 'slack')
      if (!connected) return { result: 'Slack not connected. Ask user to connect Slack.' }
      return { result: JSON.stringify(await slack.listChannels(userId), null, 2) }
    }
    case 'slack_read_messages': {
      const connected = await isProviderConnected(userId, 'slack')
      if (!connected) return { result: 'Slack not connected. Ask user to connect Slack.' }
      return { result: JSON.stringify(await slack.getMessages(userId, args.channel, args.limit || 10), null, 2) }
    }
    case 'github_create_issue': {
      const connected = await isProviderConnected(userId, 'github')
      if (!connected) return { result: 'GitHub not connected. Ask user to connect GitHub.' }
      return { result: `Created GitHub issue: ${args.title}` }
    }
    case 'github_list_repos': {
      const connected = await isProviderConnected(userId, 'github')
      if (!connected) return { result: 'GitHub not connected. Ask user to connect GitHub.' }
      return { result: JSON.stringify(await github.listRepos(userId), null, 2) }
    }
    case 'github_list_issues': {
      const connected = await isProviderConnected(userId, 'github')
      if (!connected) return { result: 'GitHub not connected. Ask user to connect GitHub.' }
      return { result: JSON.stringify(await github.listIssues(userId, args.owner, args.repo, args.state || 'open'), null, 2) }
    }
    default:
      return { result: `Unknown tool: ${toolName}` }
  }
}

async function runAgentLoop(opts: {
  userId: string
  taskPrompt: string
  tabId: number
  onProgress: (msg: string) => void
}): Promise<{ success: boolean; summary: string; tabId: number }> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: opts.taskPrompt }
  ]

  const MAX_ITERATIONS = 30
  let iterations = 0
  let activeTabId = opts.tabId

  while (iterations < MAX_ITERATIONS) {
    iterations++

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools: browserTools,
      tool_choice: 'required',
      max_tokens: 1000
    })

    const assistantMessage = response.choices[0].message
    messages.push(assistantMessage)

    if (!assistantMessage.tool_calls?.length) {
      return { success: false, summary: 'Agent stopped without completing task', tabId: activeTabId }
    }

    const toolResults: OpenAI.ChatCompletionToolMessageParam[] = []

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== 'function') continue

      const args = JSON.parse(toolCall.function.arguments || '{}')
      let resultStr: string

      if (toolCall.function.name === 'task_complete') {
        opts.onProgress(`✅ Done: ${args.summary}`)
        return { success: true, summary: args.summary, tabId: activeTabId }
      }

      if (toolCall.function.name === 'task_failed') {
        opts.onProgress(`❌ Failed: ${args.reason}`)
        return { success: false, summary: args.reason, tabId: activeTabId }
      }

      try {
        const exec = await executeBrowserTool(toolCall.function.name, args, opts.userId, activeTabId, opts.onProgress)
        resultStr = exec.result
        if (exec.newTabId !== undefined) {
          activeTabId = exec.newTabId
        }
      } catch (err) {
        resultStr = `Error: ${err instanceof Error ? err.message : String(err)}`
        opts.onProgress(`⚠️ ${resultStr}`)
      }

      toolResults.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: resultStr
      })
    }

    messages.push(...toolResults)
  }

  return { success: false, summary: 'Task exceeded maximum iterations', tabId: activeTabId }
}

// ─── Entry point ───

export async function runAgentWithExtension(
  task: string,
  userId: string,
  onStep: (step: string) => Promise<void>,
  taskId?: string
): Promise<string> {
  const taskKey = taskId || `${userId}:${task.slice(0, 50)}`
  if (runningTasks.has(taskKey)) {
    throw new Error(`Task already running for ${taskKey}`)
  }
  runningTasks.add(taskKey)

  const startTime = Date.now()
  const stepsLog: StepLog[] = []
  let status: 'success' | 'error' = 'success'
  let resultSummary = ''

  try {
    await onStep('🔌 Opening browser tab...')
    const tabId = await initializeTab(userId)
    if (!tabId) throw new Error('Failed to open browser tab')

    try {
      const result = await runAgentLoop({
        userId,
        taskPrompt: task,
        tabId,
        onProgress: async (msg) => {
          stepsLog.push({
            step: stepsLog.length + 1,
            description: msg,
            action: msg,
            success: !msg.startsWith('⚠️')
          })
          await onStep(msg)
        }
      })

      status = result.success ? 'success' : 'error'
      resultSummary = result.summary

      if (taskId) {
        await createMessage(userId, taskId, result.success ? `✅ ${resultSummary}` : resultSummary.slice(0, 300))
      }
    } finally {
      try {
        await sendExtensionMessage(userId, 'closeTab', { tabId }, 5000)
        await onStep('🗂️ Browser tab closed')
      } catch {
        // ignore close errors
      }
    }

    return resultSummary
  } catch (err) {
    status = 'error'
    resultSummary = String(err)
    if (taskId) {
      await createMessage(userId, taskId, resultSummary.slice(0, 300))
    }
    return resultSummary
  } finally {
    runningTasks.delete(taskKey)

    const completedAt = new Date().toISOString()
    const durationMs = Date.now() - startTime

    try {
      await supabase.from('task_executions').insert({
        user_id: userId,
        task_id: taskId || null,
        task_prompt: task,
        plan: [],
        status,
        result_summary: resultSummary.slice(0, 1000),
        steps_log: stepsLog,
        started_at: new Date(startTime).toISOString(),
        completed_at: completedAt,
        duration_ms: durationMs
      })
    } catch (insertErr) {
      console.error('Failed to insert task_execution:', insertErr)
    }
  }
}
