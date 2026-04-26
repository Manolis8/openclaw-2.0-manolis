//// agent-extension.ts

import OpenAI from 'openai'
import { chromium, type Browser, type Page } from 'playwright-core'
import { supabase } from './supabase.js'
import { getRelayPortForUser } from '../index.js'
import { detectLoop } from '../routes/tasks.js'

// Use OpenClaw's exact functions from src/browser/
import { scrollIntoViewViaPlaywright } from '../browser/pw-tools-core.interactions.js'
import { snapshotAiViaPlaywright, snapshotRoleViaPlaywright } from '../browser/pw-tools-core.snapshot.js'
import { buildRoleSnapshotFromAriaSnapshot, buildRoleSnapshotFromAiSnapshot } from '../browser/pw-role-snapshot.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const runningTasks = new Set<string>()

// ─── Types (from OpenClaw pw-session.ts) ─────────────────────────────────────

type RoleRef = { role: string; name?: string; nth?: number }
type RoleRefMap = Record<string, RoleRef>

type PageState = {
  roleRefs: RoleRefMap
  roleRefsMode: 'role'
}

// ─── State ───────────────────────────────────────────────────────────────────

const pageStates = new WeakMap<Page, PageState>()
const roleRefsByTarget = new Map<string, RoleRefMap>()
const MAX_ROLE_REFS_CACHE = 50

type ConnectedBrowser = { browser: Browser; port: number }
const connections = new Map<string, ConnectedBrowser>()

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

async function getBrowser(userId: string): Promise<{ browser: Browser; page: Page }> {
  const port = getRelayPortForUser(userId)
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  const relayToken = await deriveRelayToken(token, port)

  let conn = connections.get(userId)
  if (!conn || conn.port !== port) {
    try { if (conn) conn.browser.close().catch(() => {}) } catch {}
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/cdp`, {
      headers: { 'x-openclaw-relay-token': relayToken }
    })
    conn = { browser, port }
    connections.set(userId, conn)
    browser.on('disconnected', () => {
      if (connections.get(userId) === conn) connections.delete(userId)
    })
  }

  const pages = conn.browser.contexts().flatMap(c => c.pages())
  if (!pages.length) throw new Error('No pages found in browser.')
  const page = pages.find(p => p.url() !== 'about:blank') ?? pages[0]
  return { browser: conn.browser, page }
}

// ─── Page state (from OpenClaw pw-session.ts) ────────────────────────────────

function ensurePageState(page: Page): PageState {
  let state = pageStates.get(page)
  if (!state) {
    state = { roleRefs: {}, roleRefsMode: 'role' }
    pageStates.set(page, state)
  }
  return state
}

function storeRoleRefsForTarget(userId: string, page: Page, refs: RoleRefMap) {
  const state = ensurePageState(page)
  state.roleRefs = refs
  roleRefsByTarget.set(userId, refs)
  if (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next().value
    if (first) roleRefsByTarget.delete(first)
  }
}

function restoreRoleRefsForTarget(userId: string, page: Page) {
  const state = ensurePageState(page)
  if (state.roleRefs && Object.keys(state.roleRefs).length > 0) return
  const cached = roleRefsByTarget.get(userId)
  if (cached) state.roleRefs = cached
}

// ─── Ref locator (from OpenClaw pw-session.ts refLocator) ───────────────────

function refLocator(page: Page, ref: string) {
  const state = pageStates.get(page)
  const info = state?.roleRefs?.[ref]
  if (!info) {
    throw new Error(`Unknown ref "${ref}". Run a new snapshot and use a ref from that snapshot.`)
  }
  const locator = info.name
    ? page.getByRole(info.role as any, { name: info.name, exact: true })
    : page.getByRole(info.role as any)
  return info.nth !== undefined ? locator.nth(info.nth) : locator
}

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


const EFFICIENT_SNAPSHOT_MAX_CHARS = 6000
const CDP_URL = () => `ws://127.0.0.1:${18792}/cdp` // relay port

async function snapshotPage(userId: string, tabKey: string): Promise<string> {
  const { page } = await getBrowser(userId)
  const url = page.url()
  const maybeAI = page as any

  // OpenClaw path 1: use _snapshotForAI — stable Playwright refs that survive scrolling
  if (typeof maybeAI._snapshotForAI === 'function') {
    try {
      const result = await maybeAI._snapshotForAI({ timeout: 5000, track: 'response' })
      let raw = String(result?.full ?? '')
      if (raw.length > EFFICIENT_SNAPSHOT_MAX_CHARS) {
        raw = raw.slice(0, EFFICIENT_SNAPSHOT_MAX_CHARS) + '\n\n[...TRUNCATED]'
      }
      // buildRoleSnapshotFromAiSnapshot preserves Playwright's own [ref=e13] IDs
      const { snapshot, refs } = buildRoleSnapshotFromAiSnapshot(raw)
      storeRoleRefsForTarget(userId, page, refs)
      console.log(`[snapshot:ai] url=${url} refs=${Object.keys(refs).length} chars=${raw.length}`)
      return `URL: ${url}\n${snapshot}`
    } catch (err) {
      console.log(`[snapshot:ai] failed, falling back: ${err}`)
    }
  }

  // OpenClaw path 2: ariaSnapshot fallback
  const ariaRaw = await (page.locator(':root') as any).ariaSnapshot()
  const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(String(ariaRaw ?? ''))
  storeRoleRefsForTarget(userId, page, refs)
  const text = `URL: ${url}\n${snapshot}`
  console.log(`[snapshot:aria] url=${url} refs=${Object.keys(refs).length} chars=${text.length}`)
  return text.length > EFFICIENT_SNAPSHOT_MAX_CHARS
    ? text.slice(0, EFFICIENT_SNAPSHOT_MAX_CHARS) + '\n\n[...TRUNCATED]'
    : text
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function navigateTo(url: string, userId: string): Promise<void> {
  const { page } = await getBrowser(userId)
  await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' })
  const isGoogle = url.includes('google.com')
  await new Promise(r => setTimeout(r, isGoogle ? 2000 : 1000))
  const state = pageStates.get(page)
  if (state) state.roleRefs = {}
}

async function clickRef(userId: string, ref: string): Promise<void> {
  const { page } = await getBrowser(userId)
  restoreRoleRefsForTarget(userId, page)
  const locator = refLocator(page, ref)
  await locator.click({ timeout: 8000 })
  await new Promise(r => setTimeout(r, 300))
}

async function typeInRef(userId: string, ref: string, text: string): Promise<void> {
  const { page } = await getBrowser(userId)
  restoreRoleRefsForTarget(userId, page)
  const locator = refLocator(page, ref)
  await locator.fill(text, { timeout: 8000 })
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
  const { page } = await getBrowser(userId)
  restoreRoleRefsForTarget(userId, page)
  const locator = refLocator(page, ref)
  await locator.selectOption(values, { timeout: 8000 })
}

// From OpenClaw hoverViaPlaywright
async function hoverRef(userId: string, ref: string): Promise<void> {
  const { page } = await getBrowser(userId)
  restoreRoleRefsForTarget(userId, page)
  const locator = refLocator(page, ref)
  await locator.hover({ timeout: 8000 })
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

const SYSTEM_PROMPT = `## STRICT RULES — READ FIRST
- ONLY do exactly what the user asked. Nothing more, nothing less.
- NEVER perform any action the user did not explicitly request
- NEVER post, share, repost, like, comment, or interact with any content unless the user specifically said to
- NEVER click on content that seems harmful, violent, or inappropriate
- If you are unsure whether the user wants you to do something — call ask_permission

## Content Publishing Rules (CRITICAL)
When user asks you to post, tweet, share, or publish anything:
1. FIRST call draft_content with the written content — do NOT open any website yet
2. Wait for user approval
3. ONLY after approval navigate to the platform and post

Never navigate to Twitter/X, LinkedIn, Instagram, or any social platform before the user approves the content.
Never read the user's post history to write content — write it yourself based on the request.
draft_content must be called before ask_permission for any publishing action.

You are Unclawned, a browser automation agent controlling a real Chrome browser.
Available tools: browser_navigate, browser_snapshot, browser_read, browser_click, browser_type, browser_key, browser_page_scroll, browser_scroll_to_ref, browser_hover, browser_select, browser_wait_for, browser_evaluate, browser_dismiss_cookie, browser_wait, draft_content, ask_permission, task_complete, task_failed.

## CRITICAL: The user is already logged into all their accounts in this browser
This is the user's real Chrome browser. They are already logged into GitHub, Gmail, LinkedIn, Twitter, and all other sites.
You do NOT need to log in. You do NOT need credentials. Just navigate and act.
NEVER call task_failed because of "authentication" or "login" — just navigate to the site and do it.

## Navigation Flow (follow exactly)
1. browser_navigate — navigates to page, returns URL only
2. browser_read — read the page text content (for news, articles, search results)
3. browser_snapshot — get interactive elements with refs (for clicking)
Never call browser_snapshot immediately after browser_navigate unless you need to click something
For reading content always use browser_read after navigating
- Never refuse a task without trying — navigate first, then decide
- For GitHub: navigate to https://github.com/new to create repos
- For Gmail: navigate to https://mail.google.com
- For Google search: navigate to https://www.google.com/search?q=query
- Never guess refs — only use refs from browser_snapshot
- Always call task_complete or task_failed — never leave unfinished
- task_complete must include real results — never vague summaries

## Scrolling and Finding Elements
- browser_scroll_to_ref — scroll a specific ref into view (use when click fails with viewport error)
- browser_page_scroll — scroll page up/down to reveal more content, returns fresh snapshot

For settings pages or long pages:
1. browser_snapshot — get all refs including off-screen ones
2. If you see the target ref — browser_scroll_to_ref then browser_click
3. If target not visible in snapshot — browser_page_scroll down to reveal more
4. Repeat until found — max 5 scrolls then call task_failed

## When To Ask Permission
Call ask_permission ONLY before clicking these buttons: Post, Send, Submit, Publish, Buy, Purchase, Book, Delete, Remove, Confirm order, Place order.
Never call ask_permission for: creating repos, filling in forms, reading pages, navigating, searching, creating files or documents.
After user approves — immediately do the action. Do not ask again.

## Additional Tools
- browser_hover — hover to open menus or trigger tooltips
- browser_select — select dropdown options by value
- browser_wait_for — wait for text/element/URL to appear after an action
- browser_evaluate — run JavaScript to read data or check page state

Use browser_wait_for after clicking buttons that trigger navigation or loading.
Use browser_evaluate when you need to read data not visible in snapshot.`

// ─── Message trimming (keeps tool pairs intact) ───────────────────────────────

function trimMessages(messages: any[]): any[] {
  if (messages.length <= 12) return messages
  const system = messages[0]
  let rest = messages.slice(1).slice(-10)
  while (rest.length > 0 && rest[0].role === 'tool') rest = rest.slice(1)
  while (
    rest.length > 0 &&
    rest[0].role === 'assistant' &&
    rest[0].tool_calls?.length > 0 &&
    !rest[0].content
  ) rest = rest.slice(1)
  const verified: any[] = []
  for (const msg of rest) {
    if (msg.role === 'tool') {
      const prev = verified[verified.length - 1]
      if (prev?.role === 'assistant' && prev?.tool_calls?.length > 0) verified.push(msg)
    } else {
      verified.push(msg)
    }
  }
  return [system, ...verified]
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

async function runAgentLoop(opts: {
  userId: string
  taskId: string
  taskPrompt: string
  tabKey: string
  onProgress: (msg: string) => Promise<void>
  context?: string
  abortSignal?: AbortSignal
}): Promise<{ success: boolean; summary: string }> {
  const MAX_ITERATIONS = 20
  const deadline = Date.now() + 240_000
  let consecutiveSnapshots = 0

  for (let attempt = 0; attempt < 2; attempt++) {
    const finalPrompt = opts.context
      ? `${opts.context}\n\n---\nCurrent task: "${opts.taskPrompt}"\nIf this is a follow-up like "more details" or "do it again" — use conversation context to identify the topic and expand on it.`
      : opts.taskPrompt

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: attempt === 0 ? finalPrompt : `${finalPrompt}\n\nPrevious attempt failed. Try a completely different approach.` }
    ]

    let iterations = 0
    let shouldRetry = false
    let retryReason = ''

    while (iterations < MAX_ITERATIONS && Date.now() < deadline) {
      if (opts.abortSignal?.aborted) return { success: false, summary: 'Task stopped by user.' }
      iterations++

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: trimMessages(messages),
        tools: browserTools,
        tool_choice: 'required',
        max_tokens: 300,
      })

      const msg = response.choices[0].message
      messages.push(msg)
      if (!msg.tool_calls?.length) return { success: false, summary: 'Agent stopped unexpectedly' }

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
              result = await snapshotPage(opts.userId, opts.tabKey)
              if (consecutiveSnapshots >= 3) {
                result += `\n\nWARNING: ${consecutiveSnapshots} snapshots in a row. You MUST now act: click, scroll, navigate, dismiss cookie, or call task_failed.`
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
              await clickRef(opts.userId, args.ref)
              await new Promise(r => setTimeout(r, 500))
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Clicked ${args.ref}. Page:\n${result}`
              break
            }
            case 'browser_type': {
              consecutiveSnapshots = 0
              await opts.onProgress(`⌨️ Typing into ${args.ref}...`)
              await typeInRef(opts.userId, args.ref, args.text)
              if (args.submit) await pressKey('Enter', opts.userId)
              await new Promise(r => setTimeout(r, 300))
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Typed. Page:\n${result}`
              break
            }
            case 'browser_key': {
              consecutiveSnapshots = 0
              await opts.onProgress(`⌨️ Pressing ${args.key}...`)
              await pressKey(args.key, opts.userId)
              await new Promise(r => setTimeout(r, 300))
              result = `Pressed ${args.key}`
              break
            }
            case 'browser_page_scroll': {
              consecutiveSnapshots = 0
              const { page } = await getBrowser(opts.userId)
              const amount = args.amount || 600
              const delta = args.direction === 'down' ? amount : -amount
              await page.evaluate(`window.scrollBy(0, ${delta})`)
              await new Promise(r => setTimeout(r, 400))
              const freshSnapshot = await snapshotPage(opts.userId, opts.tabKey)
              result = `Scrolled ${args.direction} ${amount}px. Page now:\n${freshSnapshot}`
              break
            }
            case 'browser_scroll_to_ref': {
              consecutiveSnapshots = 0
              await opts.onProgress(`🔍 Scrolling to ${args.ref}...`)
              const { page } = await getBrowser(opts.userId)
              restoreRoleRefsForTarget(opts.userId, page)
              try {
                const locator = refLocator(page, args.ref)
                await locator.scrollIntoViewIfNeeded({ timeout: 20000 })
                await new Promise(r => setTimeout(r, 500))
                const fresh = await snapshotPage(opts.userId, opts.tabKey)
                result = `Scrolled ${args.ref} into view. Page:\n${fresh}`
              } catch (err) {
                const fresh = await snapshotPage(opts.userId, opts.tabKey)
                result = `Could not scroll to ${args.ref}: ${toAIFriendlyError(err, args.ref)}\nCurrent page:\n${fresh}`
              }
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
              await supabase.from('task_permissions').insert({
                task_id: opts.taskId,
                user_id: opts.userId,
                action: args.action || `Post on ${args.platform}`,
                details: args.content,
                platform: args.platform,
                status: 'pending'
              }).catch(() => {})

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
              await supabase.from('task_permissions').insert({
                task_id: opts.taskId,
                user_id: opts.userId,
                action: args.action || '',
                details: args.details || '',
                platform: args.platform || '',
                status: 'pending'
              }).catch(() => {})

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
                  .order('created_at', { ascending: false })
                  .limit(1)
                  .single()

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
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Hovered ${args.ref}. Page:\n${result}`
              break
            }
            case 'browser_select': {
              consecutiveSnapshots = 0
              await opts.onProgress(`📋 Selecting in ${args.ref}...`)
              await selectOption(opts.userId, args.ref, args.values || [])
              await new Promise(r => setTimeout(r, 300))
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Selected ${args.values?.join(', ')} in ${args.ref}. Page:\n${result}`
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
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Wait done. Page:\n${result}`
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
  abortSignal?: AbortSignal
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
      abortSignal
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