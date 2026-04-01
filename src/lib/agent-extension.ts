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

const snapshotRefs = new Map<number, AriaSnapshotNode[]>()

const PLANNER_SYSTEM_PROMPT = `You are a browser automation planner. Given a task, write a numbered list of concrete browser actions to complete it. Each step should be one specific action: navigate, click, type, scroll, wait, verify. Be specific about what to look for. Return ONLY the numbered list, nothing else.`

const EXECUTOR_SYSTEM_PROMPT = `You are Felo, an AI browser agent. You execute tasks in real Chrome tabs on behalf of the user.

Personality:
- Confident and direct. Never say "I'll try" — say what you're doing.
- Never say "I can't do that". If something fails, say what failed and what you'll try instead.
- After completing a task, give ONE sentence summarizing exactly what you did.
- If you notice something interesting while doing a task, mention it briefly at the end.

You have access to a live browser. You can see the page as an accessibility tree — a list of elements with stable refs like [e1], [e2]. Use these refs to interact with elements.

Each action you take will be re-verified before the next one. If a ref disappears after an action, you will re-snapshot and get new refs automatically.

Return ONLY a JSON object with your next action:
{ "action": "click"|"type"|"navigate"|"scroll"|"wait"|"pressKey"|"done"|"failed", "ref": "e1", "text": "...", "url": "...", "key": "Enter", "summary": "..." }
Use "summary" only with "done" or "failed" actions.`

type StepAction = {
  action: 'click' | 'type' | 'navigate' | 'scroll' | 'wait' | 'pressKey' | 'hover' | 'select' | 'done' | 'failed'
  ref?: string
  text?: string
  url?: string
  direction?: 'down' | 'up'
  amount?: number
  ms?: number
  key?: string
  value?: string
  summary?: string
}

async function snapshotPage(userId: string, tabId: number): Promise<string> {
  await sendCdpCommand(userId, 'Accessibility.enable', {}, tabId)
  const axTree = await sendCdpCommand(userId, 'Accessibility.getFullAXTree', {}, tabId)
  const rawNodes: RawAXNode[] = axTree?.nodes ?? []
  const nodes = formatAriaSnapshot(rawNodes, 500)
  snapshotRefs.set(tabId, nodes)
  const urlResult = await sendCdpCommand(userId, 'Runtime.evaluate', {
    expression: 'window.location.href',
    returnByValue: true
  }, tabId)
  const url = urlResult?.result?.value || 'unknown'
  const lines = nodes.map((n) => {
    let line = `[${n.ref}] ${n.role} "${n.name}"`
    if (n.value) line += ` value:"${n.value}"`
    if (n.description) line += ` description:"${n.description}"`
    line += ` (depth:${n.depth})`
    return line
  })
  return `URL: ${url}\n\nPage elements (use these refs to interact):\n${lines.join('\n')}`
}

async function decomposePlan(task: string): Promise<string[]> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: task }
    ],
    max_tokens: 500
  })
  const text = response.choices[0].message.content || ''
  return text
    .split('\n')
    .map(l => l.replace(/^\d+[\.\)\s]+/, '').trim())
    .filter(l => l.length > 0)
}

function filterInteractiveSnapshot(snapshot: string): string {
  const lines = snapshot.split('\n')
  const header = []
  const interactive: string[] = []
  for (const line of lines) {
    if (line.startsWith('URL:')) { header.push(line); continue }
    if (!line.startsWith('[')) { header.push(line); continue }
    if (/\b(button|textbox|combobox|link|tab|menuitem|checkbox|radio|slider|switch|searchbox|spinbutton|listbox|option)\b/.test(line)) {
      interactive.push(line)
    }
  }
  return [...header, ...interactive].join('\n')
}

async function planStep(
  stepDesc: string,
  snapshot: string,
  userId: string,
  tabId: number,
  plan: string[],
  stepNumber: number,
  totalSteps: number
): Promise<StepAction> {
  const filtered = filterInteractiveSnapshot(snapshot)
  const planText = plan.map((s, i) => `${i + 1}. ${s}`).join('\n')
  const userMessage = `Current task plan:\n${planText}\n\nCurrent step: ${stepNumber} of ${totalSteps}\nCurrent step description: ${stepDesc}\n\nCurrent page snapshot:\n${filtered}`
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: EXECUTOR_SYSTEM_PROMPT },
      { role: 'user', content: userMessage }
    ],
    max_tokens: 300
  })
  const raw = response.choices[0].message.content || '{}'
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  return JSON.parse(cleaned) as StepAction
}

function resolveRefToSelector(ref: string, tabSnapshots: AriaSnapshotNode[] | undefined): string | null {
  const node = tabSnapshots?.find(n => n.ref === ref)
  if (!node) return null
  const name = node.name
  if (name) return `[data-ax-name="${name}"]`
  return null
}

async function resolveElementBox(
  userId: string,
  tabId: number,
  node: AriaSnapshotNode
): Promise<{ x: number; y: number } | null> {
  if (node.backendDOMNodeId == null) return null
  try {
    await sendCdpCommand(userId, 'DOM.enable', {}, tabId)
    const resolved = await sendCdpCommand(userId, 'DOM.resolveNode', {
      backendNodeId: node.backendDOMNodeId
    }, tabId)
    const domNodeId = resolved?.node?.nodeId
    if (!domNodeId) return null
    const box = await sendCdpCommand(userId, 'DOM.getBoxModel', {
      nodeId: domNodeId
    }, tabId)
    if (box?.model?.content) {
      const c = box.model.content
      return { x: (c[0] + c[2] + c[4] + c[6]) / 4, y: (c[1] + c[3] + c[5] + c[7]) / 4 }
    }
  } catch { /* fall through */ }
  try {
    const rect = await sendCdpCommand(userId, 'Runtime.evaluate', {
      expression: `(() => {
        const nodes = document.querySelectorAll('*');
        for (const el of nodes) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const label = el.getAttribute('aria-label') || el.textContent?.trim() || '';
            if (label === ${JSON.stringify(node.name)}) return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()`,
      returnByValue: true
    }, tabId)
    if (rect?.result?.value) return rect.result.value
  } catch { /* fall through */ }
  return null
}

type RefActionFn = (box: { x: number; y: number }) => Promise<void>

async function doWithRefRetry(
  userId: string,
  tabId: number,
  ref: string,
  action: RefActionFn,
  reSnapshot: () => Promise<void>
): Promise<string> {
  let node = snapshotRefs.get(tabId)?.find(n => n.ref === ref)
  if (!node) {
    await reSnapshot()
    node = snapshotRefs.get(tabId)?.find(n => n.ref === ref)
  }
  if (!node) return `Error: ref ${ref} not found`

  let box = await resolveElementBox(userId, tabId, node)
  if (!box) {
    await reSnapshot()
    node = snapshotRefs.get(tabId)?.find(n => n.ref === ref) || node
    box = await resolveElementBox(userId, tabId, node)
  }
  if (!box) return `Error: could not locate element ${ref} (${node.name})`

  await action(box)
  return node.name || ref
}

async function executeStepAction(
  action: StepAction,
  userId: string,
  tabId: number
): Promise<string> {
  const reSnapshot = () => snapshotPage(userId, tabId).then(() => {})

  switch (action.action) {
    case 'navigate': {
      await sendCdpCommand(userId, 'Page.navigate', { url: action.url }, tabId)
      await new Promise(r => setTimeout(r, 2000))
      await snapshotPage(userId, tabId)
      return `Navigated to ${action.url}`
    }

    case 'click': {
      if (!action.ref) return 'Error: click requires a ref'
      const result = await doWithRefRetry(userId, tabId, action.ref, async (box) => {
        await sendCdpCommand(userId, 'DOM.enable', {}, tabId)
        const node = snapshotRefs.get(tabId)?.find(n => n.ref === action.ref)
        if (node?.backendDOMNodeId != null) {
          try {
            const resolved = await sendCdpCommand(userId, 'DOM.resolveNode', {
              backendNodeId: node.backendDOMNodeId
            }, tabId)
            if (resolved?.node?.nodeId) {
              await sendCdpCommand(userId, 'DOM.focus', { nodeId: resolved.node.nodeId }, tabId)
            }
          } catch { /* proceed without focus */ }
        }
        await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1
        }, tabId)
        await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1
        }, tabId)
      }, reSnapshot)
      if (result.startsWith('Error:')) return result
      await new Promise(r => setTimeout(r, 300))
      await snapshotPage(userId, tabId)
      return `Clicked ${result}`
    }

    case 'type': {
      if (!action.ref || !action.text) return 'Error: type requires ref and text'
      const result = await doWithRefRetry(userId, tabId, action.ref, async (box) => {
        await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1
        }, tabId)
        await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1
        }, tabId)
        await sendCdpCommand(userId, 'Input.insertText', { text: action.text }, tabId)
      }, reSnapshot)
      if (result.startsWith('Error:')) return result
      await new Promise(r => setTimeout(r, 300))
      await snapshotPage(userId, tabId)
      return `Typed "${action.text}" into ${result}`
    }

    case 'scroll': {
      const dir = action.direction || 'down'
      const amount = action.amount || 300
      const deltaY = dir === 'down' ? amount : -amount
      const vp = await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: 'JSON.stringify({x: window.innerWidth/2, y: window.innerHeight/2})',
        returnByValue: true
      }, tabId)
      const center = vp?.result?.value ? JSON.parse(vp.result.value) : { x: 400, y: 300 }
      await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY
      }, tabId)
      await new Promise(r => setTimeout(r, 300))
      await snapshotPage(userId, tabId)
      return `Scrolled ${dir} ${amount}px`
    }

    case 'pressKey': {
      if (!action.key) return 'Error: pressKey requires a key'
      const keyDef: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
        'Enter': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        'Tab': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
        'Escape': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        'Backspace': { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
        'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
        'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
        'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
        'Delete': { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
        'Space': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }
      }
      const def = keyDef[action.key] || { key: action.key, code: action.key, windowsVirtualKeyCode: 0 }
      await sendCdpCommand(userId, 'Input.dispatchKeyEvent', {
        type: 'keyDown', ...def
      }, tabId)
      await sendCdpCommand(userId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', ...def
      }, tabId)
      await new Promise(r => setTimeout(r, 200))
      await snapshotPage(userId, tabId)
      return `Pressed ${action.key}`
    }

    case 'hover': {
      if (!action.ref) return 'Error: hover requires a ref'
      const result = await doWithRefRetry(userId, tabId, action.ref, async (box) => {
        await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: box.x, y: box.y
        }, tabId)
      }, reSnapshot)
      if (result.startsWith('Error:')) return result
      await new Promise(r => setTimeout(r, 200))
      await snapshotPage(userId, tabId)
      return `Hovered over ${result}`
    }

    case 'select': {
      if (!action.ref || !action.value) return 'Error: select requires ref and value'
      const node = snapshotRefs.get(tabId)?.find(n => n.ref === action.ref)
      const name = node?.name || ''
      const escapedVal = action.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const result = await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: `
          (() => {
            const name = ${JSON.stringify(name)};
            const val = '${escapedVal}';
            const el = [...document.querySelectorAll('select')]
              .find(e => e.getAttribute('aria-label') === name || e.options[0]?.textContent?.includes(name));
            if (!el) {
              const selects = document.querySelectorAll('select');
              if (selects.length === 1) { selects[0].value = val; selects[0].dispatchEvent(new Event('change', {bubbles:true})); return 'selected'; }
              return 'not found';
            }
            el.value = val;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'selected';
          })()
        `,
        returnByValue: true
      }, tabId)
      await new Promise(r => setTimeout(r, 300))
      await snapshotPage(userId, tabId)
      return result?.result?.value === 'selected'
        ? `Selected "${action.value}" in ${name || action.ref}`
        : `Error: select element not found for ${action.ref}`
    }

    case 'wait': {
      const ms = Math.min(Number(action.ms) || 1000, 3000)
      await new Promise(r => setTimeout(r, ms))
      return `Waited ${ms}ms`
    }

    case 'done':
      return 'DONE'

    default:
      return `Unknown action: ${action.action}`
  }
}

const SYSTEM_PROMPT = `You are an expert browser automation agent controlling a real Chrome browser and integrations.
Rules:
- Always navigate first then snapshot to see the page
- The snapshot shows page elements with refs like [e1], [e2] — use the role and name to identify elements
- Use CSS selectors or text content derived from snapshot refs to interact with elements
- The user is already logged into their accounts — do not try to log in
- For Gmail/Slack/Notion/GitHub tasks, use the API tools instead of browser automation
- Complete tasks in minimum steps
- Call done when you have the result`

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate to a URL in the user real Chrome browser',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'snapshot',
      description: 'Get the current page content and accessibility tree',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element by snapshot ref (e.g. e3)',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot like e3' }
        },
        required: ['ref']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description: 'Type text into an input field by snapshot ref',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot like e5' },
          text: { type: 'string' }
        },
        required: ['ref', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'extract',
      description: 'Extract specific data from the current page',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string' }
        },
        required: ['instruction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page down or up',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['down', 'up'] },
          amount: { type: 'number', description: 'Pixels to scroll (default 300)' }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for page to load',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number' }
        },
        required: ['ms']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pressKey',
      description: 'Press a keyboard key (Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Delete, Space)',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name to press' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'hover',
      description: 'Hover the mouse over an element by snapshot ref',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot like e3' }
        },
        required: ['ref']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'select',
      description: 'Select an option in a dropdown by snapshot ref and value',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Select element ref from snapshot' },
          value: { type: 'string', description: 'Option value to select' }
        },
        required: ['ref', 'value']
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
        properties: {
          maxResults: { type: 'number' }
        }
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
        properties: {
          messageId: { type: 'string' }
        },
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
        properties: {
          databaseId: { type: 'string' }
        },
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
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Task complete — return the final result',
      parameters: {
        type: 'object',
        properties: {
          result: { type: 'string' }
        },
        required: ['result']
      }
    }
  }
]

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

async function executeTool(
  name: string,
  args: Record<string, any>,
  userId: string,
  tabId: number
): Promise<string> {
  switch (name) {
    case 'navigate': {
      await sendCdpCommand(userId, 'Page.navigate', { url: args.url }, tabId)
      await new Promise(r => setTimeout(r, 2000))
      await snapshotPage(userId, tabId)
      return `Navigated to ${args.url}`
    }
    case 'snapshot': {
      return await snapshotPage(userId, tabId)
    }
    case 'click': {
      if (!args.ref) return 'Error: click requires a ref'
      const reSnapshot = () => snapshotPage(userId, tabId).then(() => {})
      const result = await doWithRefRetry(userId, tabId, args.ref, async (box) => {
        await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1
        }, tabId)
        await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1
        }, tabId)
      }, reSnapshot)
      if (result.startsWith('Error:')) return result
      await new Promise(r => setTimeout(r, 300))
      await snapshotPage(userId, tabId)
      return `Clicked ${result}`
    }
    case 'type': {
      if (!args.ref || !args.text) return 'Error: type requires ref and text'
      const reSnapshot = () => snapshotPage(userId, tabId).then(() => {})
      const result = await doWithRefRetry(userId, tabId, args.ref, async (box) => {
        await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1
        }, tabId)
        await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1
        }, tabId)
        await sendCdpCommand(userId, 'Input.insertText', { text: args.text }, tabId)
      }, reSnapshot)
      if (result.startsWith('Error:')) return result
      await new Promise(r => setTimeout(r, 300))
      await snapshotPage(userId, tabId)
      return `Typed "${args.text}" into ${result}`
    }
    case 'extract': {
      const snapshot = await snapshotPage(userId, tabId)
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Extract the requested data from the page accessibility snapshot. Be specific and structured.' },
          { role: 'user', content: `${args.instruction}\n\n${snapshot.slice(0, 6000)}` }
        ],
        max_tokens: 800
      })
      return response.choices[0].message.content || 'Nothing extracted'
    }
    case 'scroll': {
      const dir = args.direction || 'down'
      const amount = args.amount || 300
      const deltaY = dir === 'down' ? amount : -amount
      const vp = await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: 'JSON.stringify({x: window.innerWidth/2, y: window.innerHeight/2})',
        returnByValue: true
      }, tabId)
      const center = vp?.result?.value ? JSON.parse(vp.result.value) : { x: 400, y: 300 }
      await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY
      }, tabId)
      await new Promise(r => setTimeout(r, 300))
      await snapshotPage(userId, tabId)
      return `Scrolled ${dir} ${amount}px`
    }
    case 'wait': {
      const ms = Math.min(Number(args.ms) || 1000, 3000)
      await new Promise(r => setTimeout(r, ms))
      return `Waited ${ms}ms`
    }
    case 'pressKey': {
      if (!args.key) return 'Error: pressKey requires a key'
      const keyDef: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
        'Enter': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        'Tab': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
        'Escape': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        'Backspace': { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
        'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
        'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
        'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
        'Delete': { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
        'Space': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }
      }
      const def = keyDef[args.key] || { key: args.key, code: args.key, windowsVirtualKeyCode: 0 }
      await sendCdpCommand(userId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...def }, tabId)
      await sendCdpCommand(userId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...def }, tabId)
      await new Promise(r => setTimeout(r, 200))
      await snapshotPage(userId, tabId)
      return `Pressed ${args.key}`
    }
    case 'hover': {
      if (!args.ref) return 'Error: hover requires a ref'
      const reSnapshot = () => snapshotPage(userId, tabId).then(() => {})
      const hoverResult = await doWithRefRetry(userId, tabId, args.ref, async (box) => {
        await sendCdpCommand(userId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: box.x, y: box.y
        }, tabId)
      }, reSnapshot)
      if (hoverResult.startsWith('Error:')) return hoverResult
      await new Promise(r => setTimeout(r, 200))
      await snapshotPage(userId, tabId)
      return `Hovered over ${hoverResult}`
    }
    case 'select': {
      if (!args.ref || !args.value) return 'Error: select requires ref and value'
      const node = snapshotRefs.get(tabId)?.find(n => n.ref === args.ref)
      const name = node?.name || ''
      const escapedVal = args.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const selectResult = await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: `
          (() => {
            const name = ${JSON.stringify(name)};
            const val = '${escapedVal}';
            const el = [...document.querySelectorAll('select')]
              .find(e => e.getAttribute('aria-label') === name || e.options[0]?.textContent?.includes(name));
            if (!el) {
              const selects = document.querySelectorAll('select');
              if (selects.length === 1) { selects[0].value = val; selects[0].dispatchEvent(new Event('change', {bubbles:true})); return 'selected'; }
              return 'not found';
            }
            el.value = val;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'selected';
          })()
        `,
        returnByValue: true
      }, tabId)
      await new Promise(r => setTimeout(r, 300))
      await snapshotPage(userId, tabId)
      return selectResult?.result?.value === 'selected'
        ? `Selected "${args.value}" in ${name || args.ref}`
        : `Error: select element not found for ${args.ref}`
    }
    case 'gmail_list': {
      const connected = await isProviderConnected(userId, 'gmail')
      if (!connected) return 'Gmail not connected. Ask user to connect Gmail.'
      try {
        const result = await gmail.listEmails(userId, { maxResults: args.maxResults || 10 })
        return JSON.stringify(result, null, 2)
      } catch (err) {
        return `Gmail error: ${String(err)}`
      }
    }
    case 'gmail_send': {
      const connected = await isProviderConnected(userId, 'gmail')
      if (!connected) return 'Gmail not connected. Ask user to connect Gmail.'
      try {
        await gmail.sendEmail(userId, args.to, args.subject, args.body)
        return `Email sent to ${args.to}`
      } catch (err) {
        return `Gmail error: ${String(err)}`
      }
    }
    case 'gmail_read': {
      const connected = await isProviderConnected(userId, 'gmail')
      if (!connected) return 'Gmail not connected. Ask user to connect Gmail.'
      try {
        const content = await gmail.getEmailContent(userId, args.messageId)
        return content.slice(0, 2000)
      } catch (err) {
        return `Gmail error: ${String(err)}`
      }
    }
    case 'gmail_summarize': {
      const connected = await isProviderConnected(userId, 'gmail')
      if (!connected) return 'Gmail not connected. Ask user to connect Gmail.'
      try {
        return await gmail.summarizeEmails(userId)
      } catch (err) {
        return `Gmail error: ${String(err)}`
      }
    }
    case 'notion_create_page': {
      const connected = await isProviderConnected(userId, 'notion')
      if (!connected) return 'Notion not connected. Ask user to connect Notion.'
      try {
        await notion.createPage(userId, args.parentId, args.title, args.content)
        return `Created Notion page: ${args.title}`
      } catch (err) {
        return `Notion error: ${String(err)}`
      }
    }
    case 'notion_list_databases': {
      const connected = await isProviderConnected(userId, 'notion')
      if (!connected) return 'Notion not connected. Ask user to connect Notion.'
      try {
        const result = await notion.listDatabases(userId)
        return JSON.stringify(result, null, 2)
      } catch (err) {
        return `Notion error: ${String(err)}`
      }
    }
    case 'notion_query_database': {
      const connected = await isProviderConnected(userId, 'notion')
      if (!connected) return 'Notion not connected. Ask user to connect Notion.'
      try {
        const result = await notion.queryDatabase(userId, args.databaseId)
        return JSON.stringify(result, null, 2)
      } catch (err) {
        return `Notion error: ${String(err)}`
      }
    }
    case 'slack_send': {
      const connected = await isProviderConnected(userId, 'slack')
      if (!connected) return 'Slack not connected. Ask user to connect Slack.'
      try {
        await slack.sendMessage(userId, args.channel, args.text)
        return `Sent message to ${args.channel}`
      } catch (err) {
        return `Slack error: ${String(err)}`
      }
    }
    case 'slack_list_channels': {
      const connected = await isProviderConnected(userId, 'slack')
      if (!connected) return 'Slack not connected. Ask user to connect Slack.'
      try {
        const result = await slack.listChannels(userId)
        return JSON.stringify(result, null, 2)
      } catch (err) {
        return `Slack error: ${String(err)}`
      }
    }
    case 'slack_read_messages': {
      const connected = await isProviderConnected(userId, 'slack')
      if (!connected) return 'Slack not connected. Ask user to connect Slack.'
      try {
        const result = await slack.getMessages(userId, args.channel, args.limit || 10)
        return JSON.stringify(result, null, 2)
      } catch (err) {
        return `Slack error: ${String(err)}`
      }
    }
    case 'github_create_issue': {
      const connected = await isProviderConnected(userId, 'github')
      if (!connected) return 'GitHub not connected. Ask user to connect GitHub.'
      try {
        const result = await github.createIssue(userId, args.owner, args.repo, args.title, args.body)
        return `Created GitHub issue: ${args.title}`
      } catch (err) {
        return `GitHub error: ${String(err)}`
      }
    }
    case 'github_list_repos': {
      const connected = await isProviderConnected(userId, 'github')
      if (!connected) return 'GitHub not connected. Ask user to connect GitHub.'
      try {
        const result = await github.listRepos(userId)
        return JSON.stringify(result, null, 2)
      } catch (err) {
        return `GitHub error: ${String(err)}`
      }
    }
    case 'github_list_issues': {
      const connected = await isProviderConnected(userId, 'github')
      if (!connected) return 'GitHub not connected. Ask user to connect GitHub.'
      try {
        const result = await github.listIssues(userId, args.owner, args.repo, args.state || 'open')
        return JSON.stringify(result, null, 2)
      } catch (err) {
        return `GitHub error: ${String(err)}`
      }
    }
    case 'done': {
      return `DONE:${args.result}`
    }
    default:
      return `Unknown tool: ${name}`
  }
}

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
  let planSteps: string[] = []
  let status: 'success' | 'error' = 'success'
  let resultSummary = ''

  try {
    await onStep('📋 Planning steps...')
    planSteps = await decomposePlan(task)
    let currentStep = 0

    for (let i = 0; i < planSteps.length; i++) {
      await onStep(`  ${i + 1}. ${planSteps[i]}`)
    }

    await onStep('🔌 Opening browser tab...')
    const tabId = await initializeTab(userId)
    if (!tabId) throw new Error('Failed to open browser tab')

    try {
      while (currentStep < planSteps.length) {
        const stepDesc = planSteps[currentStep]
        await onStep(`📋 Step ${currentStep + 1}/${planSteps.length}: ${stepDesc}`)

        let retries = 0
        let stepSucceeded = false

        while (retries <= 2 && !stepSucceeded) {
          try {
            const snapshot = await snapshotPage(userId, tabId)
            const action = await planStep(stepDesc, snapshot, userId, tabId, planSteps, currentStep + 1, planSteps.length)

            if (action.action === 'done' || action.action === 'failed') {
              resultSummary = action.summary || (action.action === 'done' ? 'Task completed' : 'Task failed')
              stepsLog.push({
                step: currentStep + 1,
                description: stepDesc,
                action: action.action,
                success: action.action === 'done'
              })
              stepSucceeded = true
              if (action.action === 'failed') {
                throw new Error(resultSummary)
              }
              break
            }

            const result = await executeStepAction(action, userId, tabId)

            if (result.startsWith('Error:')) {
              throw new Error(result)
            }

            stepsLog.push({
              step: currentStep + 1,
              description: stepDesc,
              action: `${action.action}${action.ref ? ` ref=${action.ref}` : ''}${action.text ? ` text="${action.text}"` : ''}${action.url ? ` url=${action.url}` : ''}${action.key ? ` key=${action.key}` : ''}`,
              success: true
            })

            await onStep(`  ✓ ${result}`)
            stepSucceeded = true
            currentStep++
          } catch (err) {
            retries++
            const errorMsg = String(err)
            stepsLog.push({
              step: currentStep + 1,
              description: stepDesc,
              action: `retry ${retries}`,
              success: false,
              errorMsg: errorMsg.slice(0, 500)
            })

            if (retries > 2) {
              throw new Error(`Step ${currentStep + 1} failed after 2 retries: ${stepDesc} — ${errorMsg}`)
            }
            await onStep(`  ⚠️ Retry ${retries}/2 for step ${currentStep + 1}...`)
            await new Promise(r => setTimeout(r, 1000))
          }
        }
      }

      resultSummary = resultSummary || 'Task completed'
      if (taskId) {
        await createMessage(userId, taskId, `✅ ${resultSummary}`)
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
        plan: planSteps,
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
