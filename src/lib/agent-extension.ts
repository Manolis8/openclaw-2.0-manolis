import OpenAI from 'openai'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { isProviderConnected } from './api-caller.js'
import { createMessage } from './scheduler.js'
import { getRelayServerInfo } from './relay-server.js'
import { supabase } from './supabase.js'
import * as gmail from './integrations/gmail.js'
import * as notion from './integrations/notion.js'
import * as slack from './integrations/slack.js'
import * as github from './integrations/github.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const runningTasks = new Set<string>()
const userBrowserConnections = new Map<string, Browser>()

// ─── Browser connection ───

async function getPlaywrightPage(userId: string): Promise<{ page: Page }> {
  const relayServer = getRelayServerInfo(userId)
  if (!relayServer) {
    throw new Error('Extension not connected. Click the Felo extension badge ON on a Chrome tab first.')
  }

  // ws://127.0.0.1:{port}/cdp → http://127.0.0.1:{port}
  const cdpUrl = relayServer.cdpWsUrl
    .replace('ws://', 'http://')
    .replace('/cdp', '')

  // Always get a fresh connection — don't reuse across tasks
  // because the relay session state resets between connections
  let browser = userBrowserConnections.get(userId)
  if (browser) {
    try { await browser.close() } catch {}
    userBrowserConnections.delete(userId)
  }

  console.log(`[playwright] connecting to relay at ${cdpUrl}`)
  browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 })
  userBrowserConnections.set(userId, browser)
  browser.on('disconnected', () => userBrowserConnections.delete(userId))
  console.log(`[playwright] connected`)

  // Wait up to 5s for a context and page to appear
  let context = browser.contexts()[0]
  if (!context) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No browser context after 5s. Is a tab attached?')), 5000)
      const check = () => {
        const ctx = browser.contexts()[0]
        if (ctx) { clearTimeout(timeout); resolve() }
      }
      // Poll every 500ms
      const interval = setInterval(() => {
        if (browser.contexts()[0]) { clearInterval(interval); check() }
      }, 500)
      check()
    })
  }

  const pages = context.pages()
  if (!pages.length) {
    throw new Error('No tabs found. Click the Felo extension badge ON on a Chrome tab first.')
  }

  const page = pages.find(p => {
    const url = p.url()
    return url && url !== 'about:blank' && !url.startsWith('chrome://')
  }) ?? pages[0]

  console.log(`[playwright] using page: ${page.url()}`)
  return { page }
}

// ─── Snapshot / role-ref system (OpenClaw-style) ───

type RoleRef = { role: string; name?: string; nth?: number }
type RoleRefMap = Record<string, RoleRef>

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'treeitem'
])

const tabRoleRefs = new Map<string, { refs: RoleRefMap; url: string }>()

function buildRoleRefsFromSnapshot(ariaSnapshot: string): { snapshot: string; refs: RoleRefMap } {
  const lines = ariaSnapshot.split('\n')
  const refs: RoleRefMap = {}
  const counts = new Map<string, number>()
  const refsByKey = new Map<string, string[]>()
  const out: string[] = []
  let counter = 0

  for (const line of lines) {
    const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/)
    if (!match) { out.push(line); continue }
    const [, prefix, roleRaw, name, suffix] = match
    const role = roleRaw.toLowerCase()
    if (!INTERACTIVE_ROLES.has(role)) { out.push(line); continue }

    counter++
    const ref = `e${counter}`
    const key = `${role}:${name ?? ''}`
    const nth = counts.get(key) ?? 0
    counts.set(key, nth + 1)
    const existing = refsByKey.get(key) ?? []
    existing.push(ref)
    refsByKey.set(key, existing)

    refs[ref] = { role, name: name || undefined, nth }
    let enhanced = `${prefix}${roleRaw}`
    if (name) enhanced += ` "${name}"`
    enhanced += ` [ref=${ref}]`
    if (nth > 0) enhanced += ` [nth=${nth}]`
    if (suffix) enhanced += suffix
    out.push(enhanced)
  }

  for (const [, refList] of refsByKey) {
    if (refList.length <= 1) {
      for (const r of refList) { if (refs[r]) delete refs[r].nth }
    }
  }

  return { snapshot: out.join('\n') || '(no interactive elements)', refs }
}

async function snapshotPage(page: Page, tabKey: string): Promise<string> {
  const ariaSnapshot = await page.locator(':root').ariaSnapshot({ timeout: 10_000 })
  const url = page.url()
  const { snapshot, refs } = buildRoleRefsFromSnapshot(ariaSnapshot)
  tabRoleRefs.set(tabKey, { refs, url })
  return `URL: ${url}\n${snapshot}`
}

function refLocator(page: Page, ref: string, tabKey: string) {
  const stored = tabRoleRefs.get(tabKey)
  if (!stored?.refs[ref]) {
    throw new Error(`Unknown ref "${ref}". Call browser_snapshot first to get current refs.`)
  }
  const { role, name, nth } = stored.refs[ref]
  const locator = name
    ? page.getByRole(role as any, { name, exact: true })
    : page.getByRole(role as any)
  return (nth !== undefined && nth > 0) ? locator.nth(nth) : locator
}

// ─── Tools ───

const browserTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Read the current page state. Returns all interactive elements with ref IDs like e1, e2. ALWAYS call this first before any action, and after every action to confirm what changed.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate the current tab to a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL including https://' } },
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
        properties: { ref: { type: 'string', description: 'Ref like e1, e2 from snapshot' } },
        required: ['ref']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into a textbox or input field.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          text: { type: 'string' },
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
      description: 'Press a keyboard key. Examples: Enter, Tab, Escape, ArrowDown.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
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
      description: 'Wait for milliseconds or for text to appear on page.',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number' },
          text: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description: 'Mark task as done. Only call after visual confirmation the action succeeded — post appeared, form submitted, item created.',
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
      description: 'Mark task as failed after exhausting all approaches.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason']
      }
    }
  },
  // ── Integrations ──
  { type: 'function', function: { name: 'gmail_list', description: 'List recent Gmail emails', parameters: { type: 'object', properties: { maxResults: { type: 'number' } } } } },
  { type: 'function', function: { name: 'gmail_send', description: 'Send email via Gmail', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } } },
  { type: 'function', function: { name: 'gmail_read', description: 'Read a Gmail email by ID', parameters: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] } } },
  { type: 'function', function: { name: 'gmail_summarize', description: 'Summarize recent emails', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'notion_create_page', description: 'Create Notion page', parameters: { type: 'object', properties: { parentId: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['parentId', 'title', 'content'] } } },
  { type: 'function', function: { name: 'notion_list_databases', description: 'List Notion databases', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'notion_query_database', description: 'Query Notion database', parameters: { type: 'object', properties: { databaseId: { type: 'string' } }, required: ['databaseId'] } } },
  { type: 'function', function: { name: 'slack_send', description: 'Send Slack message', parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } } },
  { type: 'function', function: { name: 'slack_list_channels', description: 'List Slack channels', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'slack_read_messages', description: 'Read Slack messages', parameters: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] } } },
  { type: 'function', function: { name: 'github_create_issue', description: 'Create GitHub issue', parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'body'] } } },
  { type: 'function', function: { name: 'github_list_repos', description: 'List GitHub repos', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'github_list_issues', description: 'List GitHub issues', parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } } },
]

const SYSTEM_PROMPT = `You are Felo, an AI browser agent controlling a real Chrome browser tab.

Rules:
- ALWAYS call browser_snapshot before any action and after every action to see what changed
- NEVER call task_complete just because you clicked something — wait for visual confirmation (post appeared, form gone, success message)
- If an element ref is stale, call browser_snapshot again to get fresh refs
- If something fails twice, try a completely different approach
- For typing in contenteditable areas (like Twitter/X post box), click first then type`

// ─── Agent loop ───

async function runAgentLoop(opts: {
  userId: string
  taskId: string
  taskPrompt: string
  page: Page
  tabKey: string
  onProgress: (msg: string) => Promise<void>
}): Promise<{ success: boolean; summary: string }> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: opts.taskPrompt }
  ]

  const MAX_ITERATIONS = 20
  const deadline = Date.now() + 90_000

  for (let attempt = 0; attempt < 2; attempt++) {
    let iterations = 0
    while (iterations < MAX_ITERATIONS && Date.now() < deadline) {
      iterations++

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools: browserTools,
        tool_choice: 'required',
        max_tokens: 1000,
      })

      const msg = response.choices[0].message
      messages.push(msg)

      if (!msg.tool_calls?.length) {
        return { success: false, summary: 'Agent stopped unexpectedly' }
      }

      const toolResults: OpenAI.ChatCompletionToolMessageParam[] = []

      for (const toolCall of msg.tool_calls as any[]) {
        const args = JSON.parse(toolCall.function.arguments || '{}')
        let result: string

        try {
          switch (toolCall.function.name) {

            case 'browser_snapshot': {
              await opts.onProgress('📸 Reading page...')
              result = await snapshotPage(opts.page, opts.tabKey)
              break
            }

            case 'browser_navigate': {
              await opts.onProgress(`🌐 Navigating to ${args.url}...`)
              await opts.page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
              await opts.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
              result = await snapshotPage(opts.page, opts.tabKey)
              result = `Navigated. Page is now:\n${result}`
              break
            }

            case 'browser_click': {
              await opts.onProgress(`🖱️ Clicking ${args.ref}...`)
              const locator = refLocator(opts.page, args.ref, opts.tabKey)
              await locator.click({ timeout: 8000 })
              await opts.page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
              result = await snapshotPage(opts.page, opts.tabKey)
              result = `Clicked. Page is now:\n${result}`
              break
            }

            case 'browser_type': {
              await opts.onProgress(`⌨️ Typing into ${args.ref}...`)
              const locator = refLocator(opts.page, args.ref, opts.tabKey)
              await locator.fill(args.text, { timeout: 8000 })
              if (args.submit) await locator.press('Enter')
              result = await snapshotPage(opts.page, opts.tabKey)
              result = `Typed. Page is now:\n${result}`
              break
            }

            case 'browser_key': {
              await opts.onProgress(`⌨️ Pressing ${args.key}...`)
              await opts.page.keyboard.press(args.key)
              result = `Pressed ${args.key}`
              break
            }

            case 'browser_scroll': {
              await opts.page.mouse.wheel(0, args.direction === 'down' ? (args.amount ?? 300) : -(args.amount ?? 300))
              result = `Scrolled ${args.direction}`
              break
            }

            case 'browser_wait': {
              if (args.ms) await opts.page.waitForTimeout(args.ms)
              if (args.text) await opts.page.getByText(args.text).first().waitFor({ state: 'visible', timeout: 5000 })
              result = 'Done waiting'
              break
            }

            case 'task_complete': {
              await opts.onProgress(`✅ ${args.summary}`)
              return { success: true, summary: args.summary }
            }

            case 'task_failed': {
              if (attempt === 0) {
                await opts.onProgress(`⚠️ Retrying: ${args.reason}`)
                messages.length = 2
                messages[1] = { role: 'user', content: `${opts.taskPrompt}\n\nFirst attempt failed: ${args.reason}. Try a different approach.` }
              } else {
                await opts.onProgress(`❌ ${args.reason}`)
                return { success: false, summary: args.reason }
              }
              result = 'Retrying with different approach'
              break
            }

            // ── Integrations ──
            case 'gmail_list': {
              if (!await isProviderConnected(opts.userId, 'gmail')) { result = 'Gmail not connected'; break }
              result = JSON.stringify(await gmail.listEmails(opts.userId, { maxResults: args.maxResults || 10 }), null, 2)
              break
            }
            case 'gmail_send': {
              if (!await isProviderConnected(opts.userId, 'gmail')) { result = 'Gmail not connected'; break }
              await gmail.sendEmail(opts.userId, args.to, args.subject, args.body)
              result = `Email sent to ${args.to}`
              break
            }
            case 'gmail_read': {
              if (!await isProviderConnected(opts.userId, 'gmail')) { result = 'Gmail not connected'; break }
              result = (await gmail.getEmailContent(opts.userId, args.messageId)).slice(0, 2000)
              break
            }
            case 'gmail_summarize': {
              if (!await isProviderConnected(opts.userId, 'gmail')) { result = 'Gmail not connected'; break }
              result = await gmail.summarizeEmails(opts.userId)
              break
            }
            case 'notion_create_page': {
              if (!await isProviderConnected(opts.userId, 'notion')) { result = 'Notion not connected'; break }
              await notion.createPage(opts.userId, args.parentId, args.title, args.content)
              result = `Created page: ${args.title}`
              break
            }
            case 'notion_list_databases': {
              if (!await isProviderConnected(opts.userId, 'notion')) { result = 'Notion not connected'; break }
              result = JSON.stringify(await notion.listDatabases(opts.userId), null, 2)
              break
            }
            case 'notion_query_database': {
              if (!await isProviderConnected(opts.userId, 'notion')) { result = 'Notion not connected'; break }
              result = JSON.stringify(await notion.queryDatabase(opts.userId, args.databaseId), null, 2)
              break
            }
            case 'slack_send': {
              if (!await isProviderConnected(opts.userId, 'slack')) { result = 'Slack not connected'; break }
              await slack.sendMessage(opts.userId, args.channel, args.text)
              result = `Sent to ${args.channel}`
              break
            }
            case 'slack_list_channels': {
              if (!await isProviderConnected(opts.userId, 'slack')) { result = 'Slack not connected'; break }
              result = JSON.stringify(await slack.listChannels(opts.userId), null, 2)
              break
            }
            case 'slack_read_messages': {
              if (!await isProviderConnected(opts.userId, 'slack')) { result = 'Slack not connected'; break }
              result = JSON.stringify(await slack.getMessages(opts.userId, args.channel, args.limit || 10), null, 2)
              break
            }
            case 'github_create_issue': {
              if (!await isProviderConnected(opts.userId, 'github')) { result = 'GitHub not connected'; break }
              result = `Created issue: ${args.title}`
              break
            }
            case 'github_list_repos': {
              if (!await isProviderConnected(opts.userId, 'github')) { result = 'GitHub not connected'; break }
              result = JSON.stringify(await github.listRepos(opts.userId), null, 2)
              break
            }
            case 'github_list_issues': {
              if (!await isProviderConnected(opts.userId, 'github')) { result = 'GitHub not connected'; break }
              result = JSON.stringify(await github.listIssues(opts.userId, args.owner, args.repo, args.state || 'open'), null, 2)
              break
            }

            default:
              result = `Unknown tool: ${toolCall.function.name}`
          }
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`
          await opts.onProgress(`⚠️ ${result}`)
        }

        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        })
      }

      messages.push(...toolResults)
    }
  }

  return { success: false, summary: 'Exceeded max iterations' }
}

// ─── Entry point ───

type StepLog = { step: number; description: string; action: string; success: boolean; errorMsg?: string }

export async function runAgentWithExtension(
  task: string,
  userId: string,
  onStep: (step: string) => Promise<void>,
  taskId?: string
): Promise<string> {
  const taskKey = taskId || `${userId}:${task.slice(0, 50)}`
  if (runningTasks.has(taskKey)) throw new Error(`Task already running`)
  runningTasks.add(taskKey)

  const startTime = Date.now()
  const stepsLog: StepLog[] = []
  let status: 'success' | 'error' = 'success'
  let resultSummary = ''

  try {
    await onStep('🔌 Connecting to your browser...')
    const { page } = await getPlaywrightPage(userId)
    const tabKey = `${userId}:${Date.now()}`

    const result = await runAgentLoop({
      userId,
      taskId: taskId || taskKey,
      taskPrompt: task,
      page,
      tabKey,
      onProgress: async (msg) => {
        stepsLog.push({ step: stepsLog.length + 1, description: msg, action: msg, success: !msg.startsWith('⚠️') && !msg.startsWith('❌') })
        await onStep(msg)
      }
    })

    status = result.success ? 'success' : 'error'
    resultSummary = result.summary
    if (taskId) await createMessage(userId, taskId, result.success ? `✅ ${resultSummary}` : resultSummary.slice(0, 300))
    return resultSummary

  } catch (err) {
    status = 'error'
    resultSummary = err instanceof Error ? err.message : String(err)
    if (taskId) await createMessage(userId, taskId, resultSummary.slice(0, 300))
    return resultSummary

  } finally {
    runningTasks.delete(taskKey)
    try {
      await supabase.from('task_executions').insert({
        user_id: userId, task_id: taskId || null, task_prompt: task, plan: [],
        status, result_summary: resultSummary.slice(0, 1000), steps_log: stepsLog,
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime
      })
    } catch (e) { console.error('task_executions insert failed:', e) }
  }
}