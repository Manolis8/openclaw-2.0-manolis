import OpenAI from 'openai'
import { chromium, type Browser, type Page } from 'playwright-core'
import { supabase } from './supabase.js'
import { getRelayPortForUser } from '../index.js'
import { detectLoop } from '../routes/tasks.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const runningTasks = new Set<string>()

// ─── Persistent browser connection (like OpenClaw's pw-session.ts) ───────────

type PageState = {
  roleRefs: Record<string, { role: string; name?: string; nth?: number }>
  roleRefsMode: 'role'
}

const pageStates = new WeakMap<Page, PageState>()
const roleRefsByTarget = new Map<string, PageState['roleRefs']>()
const MAX_ROLE_REFS_CACHE = 50

type ConnectedBrowser = { browser: Browser; port: number }
const connections = new Map<string, ConnectedBrowser>()

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
    try {
      if (conn) {
        conn.browser.close().catch(() => {})
      }
    } catch {}
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/cdp`, {
      headers: { 'x-openclaw-relay-token': relayToken }
    })
    conn = { browser, port }
    connections.set(userId, conn)
    browser.on('disconnected', () => {
      if (connections.get(userId) === conn) {
        connections.delete(userId)
      }
    })
  }

  const pages = conn.browser.contexts().flatMap(c => c.pages())
  if (!pages.length) throw new Error('No pages found in browser.')
  const page = pages.find(p => p.url() !== 'about:blank') ?? pages[0]
  return { browser: conn.browser, page }
}

function getPageState(page: Page): PageState {
  let state = pageStates.get(page)
  if (!state) {
    state = { roleRefs: {}, roleRefsMode: 'role' }
    pageStates.set(page, state)
  }
  return state
}

function storeRefs(userId: string, page: Page, refs: PageState['roleRefs']) {
  const state = getPageState(page)
  state.roleRefs = refs
  roleRefsByTarget.set(userId, refs)
  if (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next().value
    if (first) roleRefsByTarget.delete(first)
  }
}

function refLocator(page: Page, ref: string) {
  const state = pageStates.get(page)
  const info = state?.roleRefs?.[ref]
  if (!info) {
    throw new Error(`Unknown ref "${ref}". Call browser_snapshot first to get fresh refs.`)
  }
  const locator = info.name
    ? page.getByRole(info.role as any, { name: info.name, exact: true })
    : page.getByRole(info.role as any)
  return info.nth !== undefined ? locator.nth(info.nth) : locator
}

// ─── AI-friendly error messages (like OpenClaw's toAIFriendlyError) ──────────

function toAIFriendlyError(error: unknown, ref: string): string {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes('strict mode violation')) {
    const countMatch = message.match(/resolved to (\d+) elements/)
    const count = countMatch ? countMatch[1] : 'multiple'
    return `Ref "${ref}" matched ${count} elements. Call browser_snapshot to get fresh refs and use a different one.`
  }
  if (message.includes('intercepts pointer events') || message.includes('not receive pointer events')) {
    return `Element "${ref}" is blocked by an overlay. Call browser_dismiss_cookie immediately, then browser_snapshot and continue.`
  }
  if (message.includes('outside of the viewport') || message.includes('element is outside')) {
    return `Element "${ref}" is outside the viewport. Call browser_scroll direction=down amount=400, then browser_snapshot and try again.`
  }
  if (message.includes('Timeout') || message.includes('timeout')) {
    return `Element "${ref}" timed out (not found or not visible). Call browser_snapshot to see current page elements.`
  }
  if (message.includes('Unknown ref')) {
    return `Ref "${ref}" no longer exists. Call browser_snapshot to get fresh refs.`
  }
  return `Error on "${ref}": ${message}. Call browser_snapshot to see current page state.`
}

// ─── Snapshot (stores refs persistently like OpenClaw) ───────────────────────

const sessionRefs = new Map<string, Record<string, { role: string; name?: string; nth?: number }>>()

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'option', 'searchbox', 'slider', 'switch', 'tab',
  'menuitemcheckbox', 'menuitemradio', 'treeitem', 'spinbutton'
])

async function snapshotPage(userId: string, tabKey: string): Promise<string> {
  const { page } = await getBrowser(userId)
  const url = page.url()
  const ariaSnapshotRaw = await (page.locator(':root') as any).ariaSnapshot()
  const ariaText = String(ariaSnapshotRaw ?? '')

  const refs: Record<string, { role: string; name?: string; nth?: number }> = {}
  const roleCounts = new Map<string, number>()
  let counter = 0
  const lines = ariaText.split('\n')
  const outLines: string[] = []

  for (const line of lines) {
    const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?(.*)$/)
    if (!match) { outLines.push(line); continue }
    const [, indent, role, name, rest] = match
    const roleLower = role.toLowerCase()

    if (INTERACTIVE.has(roleLower)) {
      counter++
      const ref = `e${counter}`
      const key = `${roleLower}:${name ?? ''}`
      const nth = roleCounts.get(key) ?? 0
      roleCounts.set(key, nth + 1)
      refs[ref] = { role: roleLower, name: name || undefined, nth: nth > 0 ? nth : undefined }
      const refTag = nth > 0 ? ` [ref=${ref}] [nth=${nth}]` : ` [ref=${ref}]`
      outLines.push(`${indent}- ${role}${name ? ` "${name}"` : ''}${refTag}${rest}`)
    } else {
      outLines.push(line)
    }
  }

  // Store refs persistently on the page object AND in tabKey map
  storeRefs(userId, page, refs)
  sessionRefs.set(tabKey, refs)

  console.log(`[snapshot] url=${url} refs=${Object.keys(refs).length}`)
  return `URL: ${url}\n${outLines.join('\n') || '(no elements)'}`
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function navigateTo(url: string, userId: string): Promise<void> {
  const { page } = await getBrowser(userId)
  await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' })
  // For Google wait longer to let dynamic content render
  const isGoogle = url.includes('google.com')
  await new Promise(r => setTimeout(r, isGoogle ? 2000 : 1000))
  const state = pageStates.get(page)
  if (state) state.roleRefs = {}
}

async function clickRef(tabKey: string, ref: string, userId: string): Promise<void> {
  const { page } = await getBrowser(userId)
  // Restore refs from cache if page state was lost
  const state = getPageState(page)
  if (!state.roleRefs[ref]) {
    const cached = roleRefsByTarget.get(userId)
    if (cached) state.roleRefs = cached
  }
  const locator = refLocator(page, ref)
  await locator.click({ timeout: 8000 })
  await new Promise(r => setTimeout(r, 300))
}

async function typeInRef(tabKey: string, ref: string, text: string, userId: string): Promise<void> {
  const { page } = await getBrowser(userId)
  const state = getPageState(page)
  if (!state.roleRefs[ref]) {
    const cached = roleRefsByTarget.get(userId)
    if (cached) state.roleRefs = cached
  }
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

async function dismissCookie(userId: string, tabKey: string): Promise<string> {
  const { page } = await getBrowser(userId)
  const dismissed = await page.evaluate(() => {
    const SELECTORS = [
      '#onetrust-reject-all-handler',
      '#onetrust-accept-btn-handler',
      '.onetrust-close-btn-handler',
      '[aria-label="Reject all"]',
      '[aria-label="Accept all"]',
      'button[id*="reject"]',
      'button[id*="decline"]',
      'button[id*="accept"]',
      'button[id*="close"]',
      'button[class*="reject"]',
      'button[class*="decline"]',
      'button[class*="cookie"]',
      '.cookie-banner button',
      '.cookie-notice button',
      '.cc-dismiss',
      '.cc-btn',
      '[id*="cookie"] button',
      '[class*="cookie"] button',
      '[id*="consent"] button',
      '[id*="gdpr"] button',
    ]
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel) as HTMLElement | null
      if (el && el.offsetParent !== null) { el.click(); return `Clicked: ${sel}` }
    }
    const overlays = [
      '#onetrust-consent-sdk', '.onetrust-pc-dark-filter',
      '[id*="cookie-banner"]', '[class*="cookie-banner"]',
      '.cc-window', '#CybotCookiebotDialog',
    ]
    let removed = 0
    for (const sel of overlays) {
      document.querySelectorAll(sel).forEach(el => { el.remove(); removed++ })
    }
    if (removed > 0) return `Removed ${removed} overlay elements`
    return 'No cookie popup found'
  })
  await new Promise(r => setTimeout(r, 800))
  const snapshot = await snapshotPage(userId, tabKey)
  return `Cookie handled: ${dismissed}\n\nPage after:\n${snapshot}`
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const browserTools: OpenAI.Chat.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'browser_snapshot', description: 'Read the current page. Returns interactive elements with refs like e1, e2. Call this first and after every navigation.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'browser_read', description: 'Extract all readable text content from the current page. Use this to read articles, news, search results, or any page content. Much more efficient than snapshot for reading.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'browser_navigate', description: 'Navigate to a URL. Always use full https:// URLs. For Google search go directly to https://www.google.com/search?q=your+query', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_click', description: 'Click element by ref from last snapshot. If error says blocked by overlay call browser_dismiss_cookie first.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'browser_type', description: 'Type text into a ref element.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] } } },
  { type: 'function', function: { name: 'browser_key', description: 'Press a key: Enter, Tab, Escape, ArrowDown, ArrowUp.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'browser_scroll', description: 'Scroll page up or down. Use before clicking elements that may be outside viewport.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'browser_dismiss_cookie', description: 'Dismiss cookie/consent popups. Call this immediately when any element says it is blocked by an overlay or intercepts pointer events.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'browser_wait', description: 'Wait milliseconds for page to load.', parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } } },
  { type: 'function', function: { name: 'task_complete', description: 'Call when task is done. The summary MUST be detailed and complete — minimum 200 words for research/news tasks. Include all findings with specifics.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
  { type: 'function', function: { name: 'task_failed', description: 'Call when task cannot be completed after trying all approaches.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
]

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Unclawned, a browser automation agent.

## How It Works
When you navigate to a page, you automatically receive:
- PAGE CONTENT: the full readable text from the page
- INTERACTIVE ELEMENTS: refs for clicking

## Your Job
## For Search Tasks
After getting search results you have two options:
A) If task wants a quick overview: call task_complete with all titles and snippets as bullet points
B) If task wants details/more info: navigate to the top 2-3 article URLs from results, use browser_read on each, then call task_complete with comprehensive content from all articles

Always choose B when the user says "more details", "tell me more", "in depth", "read the articles"
Always choose A for quick queries like "what's in the news today"

For task_complete: write at minimum 300 words with real specific information — not vague summaries

1. Navigate to the right page
2. Read the PAGE CONTENT you received
3. Call task_complete with the full answer

## Task Complete Rules
- Always include the actual data in task_complete — real headlines, real prices, real results
- For news: list at least 5 headlines with brief details
- For prices: list the actual numbers
- For fixtures: list the actual matches and times
- Never give a vague summary — always give the real information

## If You Need To Click Something
Use the INTERACTIVE ELEMENTS refs to click
After clicking, you get new PAGE CONTENT automatically

## Cookie Popups
If anything is blocked call browser_dismiss_cookie then browser_navigate to the same URL again

## Search
Navigate directly to: https://www.google.com/search?q=your+query
Read the search results from PAGE CONTENT and call task_complete

## Rules
- Never try to log in
- Always call task_complete or task_failed
- Never leave a task without a conclusion`

// ─── Message trimming (keeps tool pairs intact) ───────────────────────────────

function trimMessages(messages: any[]): any[] {
  if (messages.length <= 30) return messages
  const system = messages[0]
  let rest = messages.slice(1).slice(-28)
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
      if (prev?.role === 'assistant' && prev?.tool_calls?.length > 0) {
        verified.push(msg)
      }
    } else {
      verified.push(msg)
    }
  }
  return [system, ...verified]
}

// ─── Agent Loop ───────────────────────────────────────────────────────────────

async function runAgentLoop(opts: {
  userId: string
  taskId: string
  taskPrompt: string
  tabKey: string
  onProgress: (msg: string) => Promise<void>
  context?: string
  abortSignal?: AbortSignal
}): Promise<{ success: boolean; summary: string }> {
  const MAX_ITERATIONS = 30
  const deadline = Date.now() + 240_000
  let consecutiveSnapshots = 0

  for (let attempt = 0; attempt < 2; attempt++) {
    const finalPrompt = opts.context
      ? `${opts.context}\n\n---\nBased on the conversation above, the user is asking: "${opts.taskPrompt}"\nIf this is a follow-up like "more details", "do it again", "tell me more" — identify the specific topic from the last Assistant message and search for that topic with more detail. Do NOT search for the literal words the user typed.`
      : opts.taskPrompt

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: attempt === 0
        ? finalPrompt
        : `${finalPrompt}\n\nPrevious attempt failed. Try a completely different approach.`
      }
    ]

    let iterations = 0
    let shouldRetry = false
    let retryReason = ''

    while (iterations < MAX_ITERATIONS && Date.now() < deadline) {
      if (opts.abortSignal?.aborted) {
        return { success: false, summary: 'Task stopped by user.' }
      }
      iterations++

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: trimMessages(messages),
        tools: browserTools,
        tool_choice: 'required',
        max_tokens: 1000,
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

        if (opts.abortSignal?.aborted) {
          return { success: false, summary: 'Task stopped by user.' }
        }

        try {
          switch (toolCall.function.name) {
            case 'browser_snapshot': {
              consecutiveSnapshots++
              await opts.onProgress('📸 Reading page...')
              result = await snapshotPage(opts.userId, opts.tabKey)
              if (consecutiveSnapshots >= 3) {
                result += `\n\nWARNING: ${consecutiveSnapshots} snapshots in a row with no action. You MUST now: click something, scroll, navigate, call browser_dismiss_cookie, or call task_failed. Do NOT snapshot again.`
              }
              break
            }
            case 'browser_navigate': {
              consecutiveSnapshots = 0
              await opts.onProgress(`🌐 Navigating to ${args.url}...`)
              await navigateTo(args.url, opts.userId)
              // Auto-dismiss cookie after navigation
              const { page: p } = await getBrowser(opts.userId)
              await p.evaluate(() => {
                const SELECTORS = [
                  '#onetrust-reject-all-handler','#onetrust-accept-btn-handler',
                  'button[id*="reject"]','button[id*="accept"]',
                  'button[class*="reject"]','button[class*="cookie"]',
                  '.cc-dismiss','.cc-btn','[id*="cookie"] button',
                  '[id*="consent"] button',
                ]
                for (const sel of SELECTORS) {
                  const el = document.querySelector(sel) as HTMLElement | null
                  if (el && el.offsetParent !== null) { el.click(); return }
                }
              }).catch(() => {})
              await new Promise(r => setTimeout(r, 800))
              // Auto-read the page content after navigation
              const { page: p2 } = await getBrowser(opts.userId)
              const isGoogleSearch = args.url.includes('google.com/search')
              if (isGoogleSearch) {
                await new Promise(r => setTimeout(r, 1500))
                const { page: p3 } = await getBrowser(opts.userId)
                const content = await p3.evaluate(() => {
                  const results: string[] = []
                  const containers = document.querySelectorAll(
                    '.g:not(.commercial-unit-desktop-top):not(.ads-ad), [data-hveid] .g, .Gx5Zad, .tF2Cxc'
                  )
                  containers.forEach(el => {
                    const title = el.querySelector('h3')
                    const snippet = el.querySelector(
                      '.VwiC3b, .MUxGbd, .yXK7lf, .lEBKkf, [data-sncf="1"], [data-sncf="2"]'
                    )
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
                      if (t && t.length > 10 && !t.includes('Skip to main') && !t.includes('Accessibility')) {
                        results.push(`• ${t}`)
                      }
                    })
                  }
                  return results.slice(0, 15).join('\n') || 'No results found'
                }).catch(() => 'Failed to read search results')
                result = `Google search results for: ${args.url}\n\n${content}\n\n` +
                  `NEXT STEP: If you have enough information, call task_complete with all bullet points above formatted in detail.\n` +
                  `If user wants more details, navigate to 1-2 of the article pages and use browser_read to get full content.`
                break
              }
              const content = await p2.evaluate(() => {
                const remove = document.querySelectorAll('script,style,nav,header,footer,aside,[class*="ad"],[class*="cookie"],[class*="popup"],[id*="cookie"],[id*="popup"]')
                remove.forEach(el => el.remove())
                const main = document.querySelector('main,article,[role="main"],[class*="content"],[id*="content"],[id*="main"]') as HTMLElement | null
                const text = (main || document.body).innerText
                return text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000)
              }).catch(() => '')
              // Also get interactive elements for clicking
              const snapshot = await snapshotPage(opts.userId, opts.tabKey)
              if (isGoogleSearch) {
                result = `Search results for ${args.url}:\n${content}\n\n` +
                `INSTRUCTION: You now have search results with titles, snippets and URLs.\n` +
                `Step 1: Call task_complete with a summary of ALL results found above.\n` +
                `If the task asks for "more details" or "read articles": navigate to the top 2-3 URLs from the results above to read the full articles, then call task_complete with comprehensive details from all articles combined.`
              } else {
                result = `Navigated to ${args.url}.\n\nPAGE CONTENT:\n${content}\n\nINTERACTIVE ELEMENTS:\n${snapshot}`
              }
              break
            }
            case 'browser_click': {
              consecutiveSnapshots = 0
              await opts.onProgress(`🖱️ Clicking ${args.ref}...`)
              await clickRef(opts.tabKey, args.ref, opts.userId)
              await new Promise(r => setTimeout(r, 500))
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Clicked ${args.ref}. Page:\n${result}`
              break
            }
            case 'browser_type': {
              consecutiveSnapshots = 0
              await opts.onProgress(`⌨️ Typing into ${args.ref}...`)
              await typeInRef(opts.tabKey, args.ref, args.text, opts.userId)
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
            case 'browser_scroll': {
              consecutiveSnapshots = 0
              await scrollPage(args.direction, args.amount || 300, opts.userId)
              result = `Scrolled ${args.direction} ${args.amount || 300}px`
              break
            }
            case 'browser_dismiss_cookie': {
              consecutiveSnapshots = 0
              await opts.onProgress('🍪 Dismissing cookie popup...')
              result = await dismissCookie(opts.userId, opts.tabKey)
              break
            }
            case 'browser_read': {
              consecutiveSnapshots = 0
              await opts.onProgress('📖 Reading page content...')
              const { page } = await getBrowser(opts.userId)
              const content = await page.evaluate(() => {
                const remove = document.querySelectorAll('script, style, nav, header, footer, aside, .ad, .advertisement, .cookie, .popup')
                remove.forEach(el => el.remove())
                const main = document.querySelector('main, article, [role="main"], .content, #content, #main') as HTMLElement | null
                const text = main ? main.innerText : document.body.innerText
                return text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000)
              })
              result = `Page content:\n${content}`
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

        if (loopCheck.stuck && loopCheck.level === 'warning') {
          result += `\n\n${loopCheck.message}`
        }

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