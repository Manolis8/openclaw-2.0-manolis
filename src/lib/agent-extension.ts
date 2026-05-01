//// agent-extension.ts

import OpenAI from 'openai'
import { chromium, type Browser, type Page } from 'playwright-core'
import { supabase } from './supabase.js'
import { getRelayPortForUser } from '../index.js'
import { detectLoop } from '../routes/tasks.js'

// Use OpenClaw's exact functions from src/browser/
import { snapshotRoleViaPlaywright } from '../browser/pw-tools-core.snapshot.js'
import { typeViaPlaywright, clickViaPlaywright, hoverViaPlaywright, selectOptionViaPlaywright } from '../browser/pw-tools-core.interactions.js'


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const runningTasks = new Set<string>()

// ─── Types (from OpenClaw pw-session.ts) ─────────────────────────────────────



// ─── State ───────────────────────────────────────────────────────────────────



type ConnectedBrowser = { browser: Browser; port: number }
const connections = new Map<string, ConnectedBrowser>()
const targetIds = new Map<string, string>() // userId → targetId

// ─── Browser connection ───────────────────────────────────────────────────────

async function deriveRelayToken(gatewayToken: string, port: number): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(gatewayToken),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`openclaw-extension-relay-v1:${port}`))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function getBrowser(userId: string): Promise<{ browser: Browser; page: Page; cdpUrl: string; targetId: string }> {
  const port = getRelayPortForUser(userId)
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  const relayToken = await deriveRelayToken(token, port)
  const cdpUrl = `ws://127.0.0.1:${port}/cdp`

  let conn = connections.get(userId)
  if (!conn || conn.port !== port) {
    try { if (conn) conn.browser.close().catch(() => {}) } catch {}
    const browser = await chromium.connectOverCDP(cdpUrl, {
      headers: { 'x-openclaw-relay-token': relayToken }
    })
    conn = { browser, port }
    connections.set(userId, conn)
    browser.on('disconnected', () => {
      if (connections.get(userId) === conn) {
        connections.delete(userId)
        targetIds.delete(userId)
      }
    })
  }

  const pages = conn.browser.contexts().flatMap(c => c.pages())
  if (!pages.length) throw new Error('No pages found in browser.')
  const page = pages.find(p => p.url() !== 'about:blank') ?? pages[0]

  // Get and cache targetId
  let targetId = targetIds.get(userId) || ''
  if (!targetId) {
    try {
      const session = await page.context().newCDPSession(page)
      const info = await session.send('Target.getTargetInfo') as any
      targetId = String(info?.targetInfo?.targetId || '').trim()
      await session.detach().catch(() => {})
      if (targetId) targetIds.set(userId, targetId)
    } catch {}
  }

  return { browser: conn.browser, page, cdpUrl: `http://127.0.0.1:${port}`, targetId }
}

// ─── Page state (from OpenClaw pw-session.ts) ────────────────────────────────





// ─── AI-friendly errors (from OpenClaw pw-tools-core.shared.ts) ─────────────

function toAIFriendlyError(error: unknown, ref: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('strict mode violation')) {
    const countMatch = message.match(/resolved to (\d+) elements/)
    const count = countMatch ? countMatch[1] : 'multiple'
    return `Selector "${ref}" matched ${count} elements. Use a more specific ref or call browser_snapshot for fresh refs.`
  }
  if (message.includes('intercepts pointer events') || message.includes('not receive pointer events')) {
    return `Element "${ref}" is not interactable (hidden or covered). Call browser_dismiss_cookie first, then browser_snapshot.`
  }
  if (message.includes('outside of the viewport') || message.includes('element is outside')) {
    return `Element "${ref}" is outside the viewport. Call browser_scroll_to_ref with ref="${ref}" to scroll it into view, then click it.`
  }
  if (message.includes('Timeout') || message.includes('timeout')) {
    return `Element "${ref}" not found or not visible. Run a new browser_snapshot to get current page elements.`
  }
  if (message.includes('Unknown ref')) {
    return `Ref "${ref}" no longer exists. Call browser_snapshot to get fresh refs.`
  }
  return `Error on "${ref}": ${message}. Call browser_snapshot to see current page state.`
}

// ─── Snapshot (from OpenClaw pw-role-snapshot.ts buildRoleSnapshotFromAriaSnapshot) ─

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem'
])

const CONTENT_ROLES = new Set([
  'heading', 'cell', 'gridcell', 'columnheader', 'rowheader',
  'listitem', 'article', 'region', 'main', 'navigation'
])


const EFFICIENT_SNAPSHOT_MAX_CHARS = 12000
const INTERACTIVE_SNAPSHOT_MAX_CHARS = 8000




async function snapshotPage(userId: string, tabKey: string, interactiveOnly = false): Promise<string> {
  const { page, cdpUrl, targetId } = await getBrowser(userId)
  const url = page.url()

  try {
    // Use OpenClaw's exact snapshotRoleViaPlaywright with role mode
    // This uses Playwright's native ariaSnapshot which includes [ref=eN] tags
    const result = await snapshotRoleViaPlaywright({
      cdpUrl,
      targetId: targetId || undefined,
      refsMode: 'role',
      options: { interactive: interactiveOnly, compact: true }
    })

    const text = `URL: ${url}\n${result.snapshot}`
    console.log(`[snapshot:openclaw] url=${url} refs=${Object.keys(result.refs).length} chars=${text.length} interactive=${interactiveOnly}`)
    return text
  } catch (err) {
    console.log(`[snapshot:openclaw:failed] ${err}`)
    // Fallback to ariaSnapshot
    const ariaRaw = await (page.locator(':root') as any).ariaSnapshot()
    const { buildRoleSnapshotFromAriaSnapshot } = await import('../browser/pw-role-snapshot.js')
    const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(String(ariaRaw ?? ''))
    return `URL: ${url}\n${snapshot}`
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function navigateTo(url: string, userId: string): Promise<void> {
  const { page } = await getBrowser(userId)
  await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' })
  const isGoogle = url.includes('google.com')
  await new Promise(r => setTimeout(r, isGoogle ? 2000 : 1000))

}

async function clickRef(userId: string, ref: string): Promise<void> {
  const { page, cdpUrl, targetId } = await getBrowser(userId)

  // Try OpenClaw's clickViaPlaywright first
  try {
    await clickViaPlaywright({
      cdpUrl,
      targetId: targetId || undefined,
      ref,
      timeoutMs: 8000
    })
    await new Promise(r => setTimeout(r, 800))
    return
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[clickRef] aria click failed for ${ref}: ${msg} — trying JS fallback`)
  }

  // Fallback: scroll into view then click
  try {
    const { page: p } = await getBrowser(userId)
    const locator = p.locator(`button, a, [role="button"]`).filter({ hasText: /.+/ }).last()
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 })
    await locator.click({ timeout: 5000 })
    await new Promise(r => setTimeout(r, 300))
    return
  } catch {}

  // Last resort: press Enter — works for most confirmation dialogs
  const { page: p2 } = await getBrowser(userId)
  await p2.keyboard.press('Enter')
  await new Promise(r => setTimeout(r, 300))
}

async function typeViaCDP(userId: string, text: string, selector?: string): Promise<void> {
  const port = getRelayPortForUser(userId)
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  const relayToken = await deriveRelayToken(token, port)
  const res = await fetch(`http://127.0.0.1:${port}/type-input`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openclaw-relay-token': relayToken
    },
    body: JSON.stringify({ text, selector }),
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
    throw new Error(`typeViaCDP failed: ${err.error}`)
  }
}

async function typeInRef(userId: string, ref: string, text: string): Promise<void> {
  const { cdpUrl, targetId } = await getBrowser(userId)

  // Try OpenClaw's typeViaPlaywright first
  try {
    await typeViaPlaywright({
      cdpUrl,
      targetId: targetId || undefined,
      ref,
      text,
      slowly: true,
      timeoutMs: 5000
    })
    await new Promise(r => setTimeout(r, 300))
    return
  } catch (err) {
    console.log(`[typeInRef] playwright failed: ${err instanceof Error ? err.message.slice(0, 100) : err} — trying CDP`)
  }

  // Fallback: type via CDP Input.insertText — works for dialogs, React inputs, any input
  await typeViaCDP(userId, text)
  await new Promise(r => setTimeout(r, 300))
}

async function pressKey(key: string, userId: string): Promise<void> {
  const { page } = await getBrowser(userId)
  await page.keyboard.press(key)
}

async function scrollPage(direction: 'up' | 'down', amount = 300, userId: string): Promise<void> {
  const { page } = await getBrowser(userId)
  const delta = direction === 'down' ? amount : -amount
  await page.evaluate(`window.scrollBy(0, ${delta})`)
  await new Promise(r => setTimeout(r, 300))
}

// From OpenClaw waitForViaPlaywright
async function waitForCondition(userId: string, opts: {
  timeMs?: number
  text?: string
  selector?: string
  url?: string
}): Promise<void> {
  const { page } = await getBrowser(userId)
  const timeout = 20000
  if (opts.timeMs) await page.waitForTimeout(Math.max(0, opts.timeMs))
  if (opts.text) await page.getByText(opts.text).first().waitFor({ state: 'visible', timeout }).catch(() => {})
  if (opts.selector) await page.locator(opts.selector).first().waitFor({ state: 'visible', timeout }).catch(() => {})
  if (opts.url) await page.waitForURL(opts.url, { timeout }).catch(() => {})
}

// From OpenClaw evaluateViaPlaywright — safe JS evaluation
async function evaluatePage(userId: string, fn: string): Promise<unknown> {
  const { page } = await getBrowser(userId)
  const timeout = 15000
  try {
    return await page.evaluate(new Function(`
      "use strict";
      try {
        var candidate = eval("(" + ${JSON.stringify(fn)} + ")");
        var result = typeof candidate === "function" ? candidate() : candidate;
        if (result && typeof result.then === "function") {
          return Promise.race([result, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ${timeout}))]);
        }
        return result;
      } catch(e) { throw new Error("eval error: " + e.message); }
    `) as any)
  } catch (err) {
    throw new Error(`evaluate failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// From OpenClaw selectOptionViaPlaywright
async function selectOption(userId: string, ref: string, values: string[]): Promise<void> {
  const { cdpUrl, targetId } = await getBrowser(userId)
  await selectOptionViaPlaywright({
    cdpUrl,
    targetId: targetId || undefined,
    ref,
    values,
    timeoutMs: 8000
  })
}

// From OpenClaw hoverViaPlaywright
async function hoverRef(userId: string, ref: string): Promise<void> {
  const { cdpUrl, targetId } = await getBrowser(userId)
  await hoverViaPlaywright({
    cdpUrl,
    targetId: targetId || undefined,
    ref,
    timeoutMs: 8000
  })
}

async function readPage(userId: string): Promise<string> {
  const { page } = await getBrowser(userId)
  const content = await page.evaluate(() => {
    // Read-only — never remove or modify DOM elements
    const main = document.querySelector('main,article,[role="main"]') as HTMLElement | null
    const text = (main || document.body).innerText
    return text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000)
  }).catch(() => '')
  return `Page content:\n${content}`
}

async function dismissCookie(userId: string, tabKey: string): Promise<string> {
  const { page } = await getBrowser(userId)
  const dismissed = await page.evaluate(() => {
    const SELECTORS = [
      '#onetrust-reject-all-handler', '#onetrust-accept-btn-handler',
      '.onetrust-close-btn-handler', '[aria-label="Reject all"]', '[aria-label="Accept all"]',
      'button[id*="reject"]', 'button[id*="decline"]', 'button[id*="accept"]', 'button[id*="close"]',
      'button[class*="reject"]', 'button[class*="decline"]', 'button[class*="cookie"]',
      '.cookie-banner button', '.cookie-notice button', '.cc-dismiss', '.cc-btn',
      '[id*="cookie"] button', '[class*="cookie"] button', '[id*="consent"] button', '[id*="gdpr"] button',
    ]
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel) as HTMLElement | null
      if (el && el.offsetParent !== null) { el.click(); return `Clicked: ${sel}` }
    }
    const overlays = [
      '#onetrust-consent-sdk', '.onetrust-pc-dark-filter',
      '[id*="cookie-banner"]', '[class*="cookie-banner"]', '.cc-window', '#CybotCookiebotDialog',
    ]
    let removed = 0
    for (const sel of overlays) {
      document.querySelectorAll(sel).forEach(el => { el.remove(); removed++ })
    }
    return removed > 0 ? `Removed ${removed} overlay elements` : 'No cookie popup found'
  })
  await new Promise(r => setTimeout(r, 800))
  const snapshot = await snapshotPage(userId, tabKey)
  return `Cookie handled: ${dismissed}\n\nPage after:\n${snapshot}`
}

async function readGoogleSearchResults(userId: string): Promise<string> {
  await new Promise(r => setTimeout(r, 1500))
  const { page } = await getBrowser(userId)
  return await page.evaluate(() => {
    const results: string[] = []
    document.querySelectorAll('.g, .Gx5Zad, .tF2Cxc').forEach(el => {
      const title = el.querySelector('h3')
      const snippet = el.querySelector('.VwiC3b, .MUxGbd, .yXK7lf, .lEBKkf')
      if (title) {
        const t = (title as HTMLElement).innerText?.trim()
        const s = snippet ? (snippet as HTMLElement).innerText?.trim() : ''
        if (t && t.length > 10 && !t.includes('Skip to main')) {
          results.push(s ? `• ${t} — ${s}` : `• ${t}`)
        }
      }
    })
    if (results.length === 0) {
      document.querySelectorAll('h3').forEach(el => {
        const t = (el as HTMLElement).innerText?.trim()
        if (t && t.length > 10 && !t.includes('Skip') && !t.includes('Accessibility')) {
          results.push(`• ${t}`)
        }
      })
    }
    return results.slice(0, 15).join('\n') || 'No results found'
  }).catch(() => 'Failed to read search results')
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const browserTools: OpenAI.Chat.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'browser_navigate', description: 'Navigate to a URL. Always use full https:// URLs. For Google search: https://www.google.com/search?q=your+query', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_snapshot', description: 'Get interactive elements on current page with refs like e1, e2. Use when you need to click something. After navigate you get content automatically.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'browser_read', description: 'Extract all readable text from current page. Use to read articles, news, page content.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'browser_click', description: 'Click element by ref from last snapshot. Ref must come from browser_snapshot.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'browser_type', description: 'Type text into input element by ref.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] } } },
  { type: 'function', function: { name: 'browser_key', description: 'Press keyboard key: Enter, Tab, Escape, ArrowDown, ArrowUp.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: {
    name: 'browser_scroll_to_ref',
    description: 'Scroll a specific element into view using its ref. Use this when browser_click fails with "outside viewport" error. Get the ref from browser_snapshot first, then use this to scroll it into view, then click it.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The ref of the element to scroll into view e.g. e12' }
      },
      required: ['ref']
    }
  }},
  { type: 'function', function: {
    name: 'browser_page_scroll',
    description: 'Scroll the page up or down by pixels and get a fresh snapshot. Use when you need to see more of the page.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number', description: 'Pixels to scroll, default 600' }
      },
      required: ['direction']
    }
  }},
  { type: 'function', function: {
    name: 'browser_hover',
    description: 'Hover over an element by ref. Use to trigger dropdown menus or tooltips.',
    parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] }
  }},
  { type: 'function', function: {
    name: 'browser_select',
    description: 'Select option(s) in a dropdown/select element by ref.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        values: { type: 'array', items: { type: 'string' }, description: 'Values to select' }
      },
      required: ['ref', 'values']
    }
  }},
  { type: 'function', function: {
    name: 'browser_wait_for',
    description: 'Wait for a condition: text to appear, selector to be visible, or URL to match. Use after clicking buttons that trigger loading.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Wait for this text to appear on page' },
        selector: { type: 'string', description: 'CSS selector to wait for' },
        url: { type: 'string', description: 'URL pattern to wait for' },
        ms: { type: 'number', description: 'Wait this many milliseconds' }
      }
    }
  }},
  { type: 'function', function: {
    name: 'browser_evaluate',
    description: 'Run JavaScript in the page. Use for reading data, checking state, or doing things impossible with refs. Return value is shown to you.',
    parameters: {
      type: 'object',
      properties: {
        fn: { type: 'string', description: 'JS function body to execute e.g. "() => document.title"' }
      },
      required: ['fn']
    }
  }},
  { type: 'function', function: { name: 'browser_dismiss_cookie', description: 'Dismiss cookie/consent popups. Call immediately when element says blocked by overlay.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'browser_wait', description: 'Wait milliseconds for page to load.', parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } } },
  { type: 'function', function: {
    name: 'draft_content',
    description: 'Use this BEFORE posting anything on social media, sending emails, or any publishing action. Write the content draft and show it to the user for approval BEFORE opening any website. The user will confirm or cancel. Only after confirmation should you navigate to the platform and post.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The full content to be posted or sent' },
        platform: { type: 'string', description: 'Where this will be posted e.g. Twitter/X, LinkedIn, Gmail' },
        action: { type: 'string', description: 'What will happen after approval e.g. Post tweet, Send email, Publish post' }
      },
      required: ['content', 'platform', 'action']
    }
  }},
  { type: 'function', function: {
    name: 'ask_permission',
    description: 'Ask user permission before doing something irreversible. Call this ONLY before: clicking Post, Send, Submit, Publish, Buy, Purchase, Book, Delete buttons. Do NOT call for creating repos, filling forms, reading, navigating, or any reversible action.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Short description of what you are about to do. e.g. "Post on LinkedIn"' },
        details: { type: 'string', description: 'The exact content or details of the action. e.g. the full post text, email body, item being deleted' },
        platform: { type: 'string', description: 'The platform or site. e.g. "LinkedIn", "Gmail", "Twitter"' }
      },
      required: ['action', 'details']
    }
  }},
  { type: 'function', function: { name: 'task_complete', description: 'Mark task done with full detailed result. For news/research: minimum 5 items with details. Never vague.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
  { type: 'function', function: { name: 'task_failed', description: 'Mark task failed after exhausting all approaches.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
]

// ─── System prompt (OpenClaw style — short and precise) ──────────────────────

const SYSTEM_PROMPT = `You are Unclawned, a browser automation agent controlling the user's real Chrome browser.

## Critical Rules
- User is already logged into all accounts — never call task_failed for authentication
- ONLY do what the user asked — nothing more, nothing less
- Never post, share, or interact with content unless explicitly asked
- Always end with task_complete or task_failed
- This task is already pre-approved — never call ask_permission for the main task action

## How To Act
You receive an EXECUTION PLAN. Follow it step by step.
Think one step at a time. After every click call browser_snapshot to see what changed.
Never use a ref from a previous snapshot — always get fresh refs after any action.

## Finding Elements
- browser_snapshot returns ALL interactive elements with refs
- If element not visible — use browser_page_scroll then browser_snapshot
- After any scroll — use refs from the NEW snapshot only

## Confirmation Input Pattern — Critical
Many actions require typing a confirmation text to enable a submit button.
When you see BOTH a textbox AND a button in a dialog:
- The button is DISABLED until you type the correct text in the textbox
- ALWAYS type into the textbox FIRST before attempting to click the button
- The textbox ref will be different from the button ref — use browser_snapshot to find both
- After typing — wait briefly then click the button
- If button click has no effect — it means your typed text did not match exactly
- Re-read what text is required and type it precisely

## Multi-Step Dialogs
Many destructive actions have multiple confirmation stages:
Stage 1: Click initial delete/remove button → new dialog appears
Stage 2: Click "I understand" or "proceed" button → text input appears
Stage 3: Type exact confirmation text in textbox → submit button enables
Stage 4: Click enabled submit button → action completes

After each click — ALWAYS call browser_snapshot before next action.
Each stage has different refs — never reuse refs across stages.

## Typing Into Inputs
- Call browser_snapshot to find the textbox ref
- Call browser_type with that exact ref and the required text
- After typing — call browser_snapshot to confirm input received text
- Then click the submit button ref from the SAME snapshot

## Discovering Unknown Info
If you need a username or ID — navigate to the site first and use browser_evaluate to find it.
Never use placeholder text like USERNAME in URLs.

## Content Publishing
Call draft_content BEFORE navigating to any social platform.
Wait for approval then navigate and post.`

// ─── Message trimming (keeps tool pairs intact) ───────────────────────────────

function trimMessages(messages: any[]): any[] {
  if (messages.length <= 20) return messages
  const system = messages[0]
  let rest = messages.slice(1).slice(-18)

  // Find first complete pair — never start with a tool message
  while (rest.length > 0 && rest[0].role === 'tool') rest = rest.slice(1)

  // Never start with an assistant message that has tool_calls but no following tool message
  while (
    rest.length > 0 &&
    rest[0].role === 'assistant' &&
    Array.isArray(rest[0].tool_calls) &&
    rest[0].tool_calls.length > 0
  ) {
    // Check if all tool_calls have responses immediately after
    const toolCallIds = rest[0].tool_calls.map((tc: any) => tc.id)
    const following = rest.slice(1)
    const respondedIds = following
      .filter((m: any) => m.role === 'tool')
      .map((m: any) => m.tool_call_id)
    const allResponded = toolCallIds.every((id: string) => respondedIds.includes(id))
    if (allResponded) break
    rest = rest.slice(1)
  }

  return [system, ...rest]
}

// Only pass last user message and last assistant summary — not agent steps
function cleanContext(context?: string): string {
  if (!context) return ''
  const lines = context.split('\n')
  const cleaned: string[] = []
  let inAgentSteps = false
  for (const line of lines) {
    // Skip lines that are agent progress steps
    if (line.match(/^(🌐|📸|🖱️|⌨️|📖|🍪|🔍|⏳|⚙️|🔐|📝|✅|⚠️|🔄)/)) continue
    if (line.startsWith('Navigated to') || line.startsWith('Clicked') || line.startsWith('Typed') || line.startsWith('Scrolled') || line.startsWith('URL:') || line.startsWith('- button') || line.startsWith('- link') || line.startsWith('- textbox') || line.includes('[ref=')) continue
    cleaned.push(line)
  }
  // Keep only last 500 chars of cleaned context
  const result = cleaned.join('\n').trim()
  return result.length > 500 ? result.slice(-500) : result
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

async function planTask(prompt: string, url?: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: `You are a browser automation planner. Given a task, produce a detailed numbered execution plan for a browser agent.

Rules:
- Be specific about URLs, exact button names, what text to type
- If you need account-specific info (username, email, ID) — add a discovery step first
- For destructive actions (delete, remove) — always include the full confirmation flow
- For confirmation dialogs: describe EVERY stage including typing confirmation text
- Max 10 steps, no explanations, numbered only

Universal patterns to follow:

DELETING SOMETHING WITH CONFIRMATION:
1. Navigate to the settings/danger page
2. Find and click the delete/remove button
3. A dialog appears — click the first confirmation button
4. A second stage appears — click the proceed/understand button
5. A text input appears — type the exact confirmation text shown
6. The submit button becomes enabled — click it to complete deletion

POSTING CONTENT:
1. Call draft_content with the content first
2. Wait for approval
3. Navigate to the platform
4. Click compose/new post
5. Type the approved content
6. Click publish/post button

SENDING EMAIL:
1. Navigate to mail client
2. Click compose
3. Fill recipient, subject, body
4. Click send

IMPORTANT:
- Never use placeholder words like USERNAME, OWNER, USER in URLs
- If account info unknown — add step: navigate to site homepage, take snapshot to find username/email
- For any multi-step confirmation dialog — list each stage as a separate step`
        },
        {
          role: 'user',
          content: url
            ? `Current page: ${url}\nTask: ${prompt}`
            : `Task: ${prompt}`
        }
      ]
    })
    return response.choices[0].message.content?.trim() ?? ''
  } catch {
    return ''
  }
}

async function runAgentLoop(opts: {
  userId: string
  taskId: string
  taskPrompt: string
  tabKey: string
  onProgress: (msg: string) => Promise<void>
  context?: string
  abortSignal?: AbortSignal
  preApproved?: boolean
}): Promise<{ success: boolean; summary: string }> {
  const MAX_ITERATIONS = 25
  const deadline = Date.now() + 300_000
  let consecutiveSnapshots = 0

  const cleanedContext = cleanContext(opts.context)
  const finalPrompt = cleanedContext
    ? `Previous conversation:\n${cleanedContext}\n\nCurrent task: "${opts.taskPrompt}"`
    : opts.taskPrompt

  // Generate plan once using cheap model
  const plan = await planTask(opts.taskPrompt)
  const planContext = plan ? `\n\nEXECUTION PLAN (follow this order):\n${plan}` : ''

  for (let attempt = 0; attempt < 2; attempt++) {

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: attempt === 0
          ? `${finalPrompt}${planContext}`
          : `${finalPrompt}\n\nPrevious attempt failed. Try a completely different approach.`
      }
    ]

    let iterations = 0
    let shouldRetry = false
    let retryReason = ''

    while (iterations < MAX_ITERATIONS && Date.now() < deadline) {
      if (opts.abortSignal?.aborted) return { success: false, summary: 'Task stopped by user.' }
      iterations++

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: trimMessages(messages),
        tools: browserTools,
        tool_choice: 'auto',
        max_tokens: 1000,
      })

      const msg = response.choices[0].message
      messages.push(msg)
      if (!msg.tool_calls?.length) {
        if (msg.content) {
          // Agent responded with text — continue loop
          continue
        }
        return { success: false, summary: 'Agent stopped unexpectedly' }
      }

      const toolResults: OpenAI.ChatCompletionToolMessageParam[] = []

      for (const toolCall of msg.tool_calls as any[]) {
        const args = JSON.parse(toolCall.function.arguments || '{}')
        let result: string

        const loopCheck = detectLoop(opts.taskId, toolCall.function.name, args)
        if (loopCheck.stuck && loopCheck.level === 'critical') {
          return { success: false, summary: loopCheck.message || 'Stuck in a loop' }
        }

        if (opts.abortSignal?.aborted) return { success: false, summary: 'Task stopped by user.' }

        try {
          switch (toolCall.function.name) {
            case 'browser_navigate': {
              consecutiveSnapshots = 0
              await opts.onProgress(`🌐 Navigating to ${args.url}...`)
              await navigateTo(args.url, opts.userId)
              // Auto-dismiss cookie only — no content reading
              const { page: p } = await getBrowser(opts.userId)
              await p.evaluate(() => {
                const sels = ['#onetrust-reject-all-handler','#onetrust-accept-btn-handler','button[id*="reject"]','button[id*="accept"]','button[class*="cookie"]','.cc-dismiss','[id*="consent"] button']
                for (const sel of sels) {
                  const el = document.querySelector(sel) as HTMLElement
                  if (el?.offsetParent !== null) { el.click(); break }
                }
              }).catch(() => {})
              await new Promise(r => setTimeout(r, 600))
              // Return URL only — agent calls browser_snapshot or browser_read next
              const { page: p2 } = await getBrowser(opts.userId)
              result = `Navigated to ${args.url} (current URL: ${p2.url()}). Now call browser_snapshot to see interactive elements or browser_read to read page content.`
              break
            }
            case 'browser_snapshot': {
              consecutiveSnapshots++
              await opts.onProgress('📸 Reading page...')
              const snap = await snapshotPage(opts.userId, opts.tabKey, true)
              if (consecutiveSnapshots >= 3) {
                result = snap + `\n\nWARNING: ${consecutiveSnapshots} snapshots in a row. You MUST now act: click, scroll, navigate, or call task_failed.`
              } else {
                result = snap
              }
              break
            }
            case 'browser_read': {
              consecutiveSnapshots = 0
              await opts.onProgress('📖 Reading page...')
              result = await readPage(opts.userId)
              break
            }
            case 'browser_click': {
              consecutiveSnapshots = 0
              await opts.onProgress(`🖱️ Clicking ${args.ref}...`)
              try {
                await clickRef(opts.userId, args.ref)
                await new Promise(r => setTimeout(r, 800))
                result = `Clicked ${args.ref} successfully. Call browser_snapshot to see updated page.`
              } catch (err) {
                result = toAIFriendlyError(err, args.ref)
              }
              break
            }
            case 'browser_type': {
              consecutiveSnapshots = 0
              await opts.onProgress(`⌨️ Typing into ${args.ref}...`)

              await typeInRef(opts.userId, args.ref, args.text)
              if (args.submit) await pressKey('Enter', opts.userId)
              await new Promise(r => setTimeout(r, 500))
              const postTypeSnap = await snapshotPage(opts.userId, opts.tabKey, true)
              result = `Typed "${args.text}" successfully. Page after typing:\n${postTypeSnap}\n\nIMPORTANT: Find the submit/confirm button in this snapshot and click it. If you see a button that was previously disabled it is now enabled — click it now.`
              break
            }
            case 'browser_key': {
              consecutiveSnapshots = 0
              await opts.onProgress(`⌨️ Pressing ${args.key}...`)
              await pressKey(args.key, opts.userId)
              await new Promise(r => setTimeout(r, 300))
              result = `Pressed ${args.key}.`
              break
            }
            case 'browser_page_scroll': {
              consecutiveSnapshots = 0
              const { page } = await getBrowser(opts.userId)
              const amount = args.amount || 600
              const delta = args.direction === 'down' ? amount : -amount
              await page.evaluate(`window.scrollBy(0, ${delta})`)
              await new Promise(r => setTimeout(r, 400))
              const freshSnapshot = await snapshotPage(opts.userId, opts.tabKey, false)
              result = `Scrolled ${args.direction} ${amount}px. Interactive elements now:\n${freshSnapshot}`
              break
            }

            case 'browser_dismiss_cookie': {
              consecutiveSnapshots = 0
              await opts.onProgress('🍪 Dismissing cookie popup...')
              result = await dismissCookie(opts.userId, opts.tabKey)
              break
            }
            case 'browser_wait': {
              await new Promise(r => setTimeout(r, Math.min(args.ms || 1000, 5000)))
              result = 'Done waiting'
              break
            }
            case 'task_complete': {
              await opts.onProgress(`✅ ${args.summary}`)
              return { success: true, summary: args.summary }
            }
            case 'task_failed': {
              await opts.onProgress(`⚠️ Attempt ${attempt + 1} failed: ${args.reason}`)
              shouldRetry = true
              retryReason = args.reason
              result = 'Noted'
              break
            }
            case 'draft_content': {
              await opts.onProgress(`📝 Draft ready for ${args.platform}`)

              // Check auto-approve preference
              const { data: pref } = await supabase
                .from('user_memories')
                .select('fact')
                .eq('user_id', opts.userId)
                .ilike('fact', '%auto_approve_all%')
                .single()

              if (pref) {
                result = `Auto-approved. Proceed to post on ${args.platform}.`
                break
              }

              // Store as permission request
              try {
                await supabase.from('task_permissions').insert({
                  task_id: opts.taskId,
                  user_id: opts.userId,
                  action: args.action || `Post on ${args.platform}`,
                  details: args.content,
                  platform: args.platform,
                  status: 'pending'
                })
              } catch {}

              await supabase.from('tasks').update({ status: 'waiting_permission' }).eq('id', opts.taskId)

              // Wait for user approval — max 10 minutes for content review
              let permissionResult = 'timeout'
              for (let i = 0; i < 300; i++) {
                await new Promise(r => setTimeout(r, 2000))
                if (opts.abortSignal?.aborted) { permissionResult = 'denied'; break }
                const { data } = await supabase
                  .from('task_permissions')
                  .select('status')
                  .eq('task_id', opts.taskId)
                  .eq('status', 'pending')
                  .order('created_at', { ascending: false })
                  .limit(1)
                  .single()
                if (!data) { permissionResult = 'approved'; break }
                if (data?.status === 'approved') { permissionResult = 'approved'; break }
                if (data?.status === 'denied') { permissionResult = 'denied'; break }
              }

              await supabase.from('tasks').update({ status: 'running' }).eq('id', opts.taskId)

              if (permissionResult === 'approved') {
                result = `User approved the content. Now navigate to ${args.platform} and post exactly this content: "${args.content}"`
              } else if (permissionResult === 'denied') {
                return { success: false, summary: 'User cancelled the post.' }
              } else {
                return { success: false, summary: 'Draft approval timed out.' }
              }
              break
            }
            case 'ask_permission': {
              // If already pre-approved by upfront classification, skip permission
              if (opts.preApproved) {
                result = 'User already approved this action. Proceed immediately.'
                break
              }

              await opts.onProgress(`🔐 Asking permission: ${args.action}`)

              // Check if user has auto-approve enabled
              const { data: pref } = await supabase
                .from('user_memories')
                .select('fact')
                .eq('user_id', opts.userId)
                .ilike('fact', '%auto_approve_all%')
                .single()

              if (pref) {
                result = 'User has auto-approve enabled. Proceed.'
                break
              }

              // Store permission request
              try {
                await supabase.from('task_permissions').insert({
                  task_id: opts.taskId,
                  user_id: opts.userId,
                  action: args.action || '',
                  details: args.details || '',
                  platform: args.platform || '',
                  status: 'pending'
                })
              } catch {}

              // Update task status so frontend knows to show permission card
              await supabase.from('tasks').update({ status: 'waiting_permission' }).eq('id', opts.taskId)

              // Poll for response — max 5 minutes
              let permissionResult = 'timeout'
              for (let i = 0; i < 150; i++) {
                await new Promise(r => setTimeout(r, 2000))
                if (opts.abortSignal?.aborted) {
                  permissionResult = 'denied'
                  break
                }
                const { data } = await supabase
                  .from('task_permissions')
                  .select('status')
                  .eq('task_id', opts.taskId)
                  .eq('status', 'pending')
                  .order('created_at', { ascending: false })
                  .limit(1)
                  .single()

                if (!data) { permissionResult = 'approved'; break }
                if (data?.status === 'approved') { permissionResult = 'approved'; break }
                if (data?.status === 'denied') { permissionResult = 'denied'; break }
              }

              // Resume task status
              await supabase.from('tasks').update({ status: 'running' }).eq('id', opts.taskId)

              if (permissionResult === 'approved') {
                result = 'User approved. Proceed with the action now.'
              } else if (permissionResult === 'denied') {
                return { success: false, summary: 'User cancelled the action.' }
              } else {
                return { success: false, summary: 'Permission request timed out. Action was not taken.' }
              }
              break
            }
            case 'browser_hover': {
              consecutiveSnapshots = 0
              await opts.onProgress(`🖱️ Hovering ${args.ref}...`)
              await hoverRef(opts.userId, args.ref)
              await new Promise(r => setTimeout(r, 400))
              result = `Hovered ${args.ref}. Call browser_snapshot to see any changes.`
              break
            }
            case 'browser_select': {
              consecutiveSnapshots = 0
              await opts.onProgress(`📋 Selecting in ${args.ref}...`)
              await selectOption(opts.userId, args.ref, args.values || [])
              await new Promise(r => setTimeout(r, 300))
              result = `Selected ${args.values?.join(', ')} in ${args.ref}. Call browser_snapshot to see changes.`
              break
            }
            case 'browser_wait_for': {
              await opts.onProgress(`⏳ Waiting...`)
              await waitForCondition(opts.userId, {
                timeMs: args.ms,
                text: args.text,
                selector: args.selector,
                url: args.url
              })
              result = await snapshotPage(opts.userId, opts.tabKey, true)
              result = `Wait done. Elements:\n${result}`
              break
            }
            case 'browser_evaluate': {
              consecutiveSnapshots = 0
              await opts.onProgress(`⚙️ Running script...`)
              try {
                const evalResult = await evaluatePage(opts.userId, args.fn)
                result = `Script result: ${JSON.stringify(evalResult, null, 2)}`
              } catch (err) {
                result = `Script error: ${err instanceof Error ? err.message : String(err)}`
              }
              break
            }
            default:
              consecutiveSnapshots = 0
              result = `Unknown tool: ${toolCall.function.name}`
          }
        } catch (err) {
          consecutiveSnapshots = 0
          const ref = args?.ref || args?.url || toolCall.function.name
          result = toAIFriendlyError(err, ref)
          await opts.onProgress(`⚠️ ${result}`)
        }

        detectLoop(opts.taskId, toolCall.function.name, args, result)
        if (loopCheck.stuck && loopCheck.level === 'warning') result += `\n\n${loopCheck.message}`
        toolResults.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
      }

      messages.push(...toolResults)
      if (shouldRetry) break
    }

    if (!shouldRetry) return { success: false, summary: 'Exceeded max iterations' }
    if (attempt >= 1) return { success: false, summary: retryReason }
    await opts.onProgress('🔄 Retrying task...')
  }

  return { success: false, summary: 'Exceeded max attempts' }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runAgentWithExtension(
  task: string,
  userId: string,
  onStep: (step: string) => Promise<void>,
  taskId?: string,
  keepTabOpen = false,
  context?: string,
  abortSignal?: AbortSignal,
  preApproved = false
): Promise<string> {
  if (abortSignal?.aborted) return 'Task stopped by user.'

  const taskKey = taskId || `${userId}:${task.slice(0, 50)}`
  if (runningTasks.has(taskKey)) throw new Error('Task already running')
  runningTasks.add(taskKey)

  const startTime = Date.now()
  let newTabId: number | null = null

  try {
    await onStep('🔌 Connecting to browser...')
    const { sendExtensionMessage } = await import('../index.js')

    await onStep('🌐 Opening new browser tab...')
    const tabResult = await sendExtensionMessage(userId, 'createAndAttachTab', { url: 'about:blank' }, 60000) as any
    newTabId = tabResult?.tabId ?? null
    if (!newTabId) throw new Error('Extension did not return a tab ID.')

    await new Promise(r => setTimeout(r, 2000))
    await onStep('✅ Tab ready. Starting task...')

    const tabKey = `${userId}:${Date.now()}`
    const result = await runAgentLoop({
      userId,
      taskId: taskId || taskKey,
      taskPrompt: task,
      tabKey,
      onProgress: onStep,
      context,
      abortSignal,
      preApproved
    })

    return result.summary

  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  } finally {
    runningTasks.delete(taskKey)
    if (!keepTabOpen && newTabId) {
      try {
        await new Promise(r => setTimeout(r, 500))
        const { sendExtensionMessage } = await import('../index.js')
        await sendExtensionMessage(userId, 'closeTab', { tabId: newTabId })
      } catch {}
    } else if (keepTabOpen && newTabId) {
      try {
        const { sendExtensionMessage } = await import('../index.js')
        await sendExtensionMessage(userId, 'detachTab', { tabId: newTabId })
      } catch {}
    }
    try {
      await supabase.from('task_executions').insert({
        user_id: userId,
        task_id: taskId || null,
        task_prompt: task,
        status: 'done',
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime
      })
    } catch {}
  }
}