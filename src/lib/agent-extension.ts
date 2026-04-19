import OpenAI from 'openai'
import { chromium } from 'playwright-core'
import { isProviderConnected } from './api-caller.js'
import { createMessage } from './scheduler.js'
import { supabase } from './supabase.js'
import * as gmail from './integrations/gmail.js'
import * as notion from './integrations/notion.js'
import * as slack from './integrations/slack.js'
import * as github from './integrations/github.js'
import { getRelayPortForUser } from '../index.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const runningTasks = new Set<string>()

async function deriveRelayToken(gatewayToken: string, port: number): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(gatewayToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`openclaw-extension-relay-v1:${port}`))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}
const sessionRefs = new Map<string, Record<string, { role: string; name?: string; nth?: number }>>()

async function getPage(userId: string) {
  const port = getRelayPortForUser(userId)
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  const relayToken = await deriveRelayToken(token, port)
  const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/cdp`, {
    headers: {
      'x-openclaw-relay-token': relayToken
    }
  })
  const pages = browser.contexts().flatMap(c => c.pages())
  if (!pages.length) throw new Error('No pages found in browser.')
  const page = pages.find(p => p.url() !== 'about:blank') ?? pages[0]
  return { browser, page }
}

function getUserIdFromTabKey(tabKey: string): string {
  return tabKey.split(':')[0]
}

async function snapshotPage(tabKey: string): Promise<string> {
  const userId = await getUserIdFromTabKey(tabKey)
  const { browser, page } = await getPage(userId)
  try {
    const url = page.url()

    const ariaSnapshotRaw = await (page.locator(':root') as any).ariaSnapshot()
    const ariaText = String(ariaSnapshotRaw ?? '')

    const refs: Record<string, { role: string; name?: string; nth?: number }> = {}
    const INTERACTIVE = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
      'listbox', 'menuitem', 'option', 'searchbox', 'slider', 'switch', 'tab',
      'menuitemcheckbox', 'menuitemradio', 'treeitem', 'spinbutton'
    ])

    let counter = 0
    const lines = ariaText.split('\n')
    const outLines: string[] = []
    const roleCounts = new Map<string, number>()

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

    sessionRefs.set(tabKey, refs)
    console.log(`[snapshot] url=${url} refs=${Object.keys(refs).length}`)
    return `URL: ${url}\n${outLines.join('\n') || '(no elements)'}`
  } finally {
    await browser.close()
  }
}

async function navigateTo(url: string, userId: string): Promise<void> {
  const { browser, page } = await getPage(userId)
  try {
    await page.goto(url, { timeout: 30000 })
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await new Promise(r => setTimeout(r, 1000))
  } finally {
    await browser.close()
  }
}

async function clickRef(tabKey: string, ref: string, userId: string): Promise<void> {
  const refs = sessionRefs.get(tabKey)
  const target = refs?.[ref]
  if (!target) throw new Error(`Unknown ref "${ref}". Call browser_snapshot first.`)

  const { browser, page } = await getPage(userId)
  try {
    const role = target.role as any
    const locator = target.name
      ? page.getByRole(role, { name: target.name, exact: true })
      : page.getByRole(role)
    // Always use nth to avoid strict mode violations
    const nth = target.nth !== undefined ? target.nth : 0
    const resolved = locator.nth(nth)
    await resolved.click({ timeout: 8000 })
    await new Promise(r => setTimeout(r, 300))
  } finally {
    await browser.close()
  }
}

async function typeInRef(tabKey: string, ref: string, text: string, userId: string): Promise<void> {
  const refs = sessionRefs.get(tabKey)
  const target = refs?.[ref]
  if (!target) throw new Error(`Unknown ref "${ref}". Call browser_snapshot first.`)

  const { browser, page } = await getPage(userId)
  try {
    const role = target.role as any
    const locator = target.name
      ? page.getByRole(role, { name: target.name, exact: true })
      : page.getByRole(role)
    const resolved = target.nth !== undefined ? locator.nth(target.nth) : locator
    await resolved.fill(text, { timeout: 8000 })
  } finally {
    await browser.close()
  }
}

async function pressKey(key: string, userId: string): Promise<void> {
  const { browser, page } = await getPage(userId)
  try {
    await page.keyboard.press(key)
  } finally {
    await browser.close()
  }
}

async function scrollPage(direction: 'up' | 'down', amount = 300, userId: string): Promise<void> {
  const { browser, page } = await getPage(userId)
  try {
    const delta = direction === 'down' ? amount : -amount
    await page.evaluate(`window.scrollBy(0, ${delta})`)
  } finally {
    await browser.close()
  }
}

const browserTools: OpenAI.Chat.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'browser_snapshot', description: 'Read the current page. Returns interactive elements with refs like e1, e2. ALWAYS call first and after every action.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'browser_navigate', description: 'Navigate to a URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_click', description: 'Click element by ref from last snapshot.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'browser_type', description: 'Type text into a ref.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] } } },
  { type: 'function', function: { name: 'browser_key', description: 'Press a key: Enter, Tab, Escape, ArrowDown, ArrowUp.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'browser_scroll', description: 'Scroll page up or down.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'browser_wait', description: 'Wait milliseconds.', parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } } },
  { type: 'function', function: { name: 'task_complete', description: 'Call only after visual confirmation task succeeded.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
  { type: 'function', function: { name: 'task_failed', description: 'Call when task cannot be completed.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
  { type: 'function', function: { name: 'gmail_list', description: 'List Gmail emails', parameters: { type: 'object', properties: { maxResults: { type: 'number' } } } } },
  { type: 'function', function: { name: 'gmail_send', description: 'Send email', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } } },
  { type: 'function', function: { name: 'gmail_read', description: 'Read email by ID', parameters: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] } } },
  { type: 'function', function: { name: 'gmail_summarize', description: 'Summarize recent emails', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'notion_create_page', description: 'Create Notion page', parameters: { type: 'object', properties: { parentId: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['parentId', 'title', 'content'] } } },
  { type: 'function', function: { name: 'notion_list_databases', description: 'List Notion databases', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'notion_query_database', description: 'Query Notion database', parameters: { type: 'object', properties: { databaseId: { type: 'string' } }, required: ['databaseId'] } } },
  { type: 'function', function: { name: 'slack_send', description: 'Send Slack message', parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } } },
  { type: 'function', function: { name: 'slack_list_channels', description: 'List Slack channels', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'slack_read_messages', description: 'Read Slack messages', parameters: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] } } },
  { type: 'function', function: { name: 'github_list_repos', description: 'List GitHub repos', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'github_list_issues', description: 'List GitHub issues', parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } } },
  { type: 'function', function: { name: 'github_create_issue', description: 'Create GitHub issue', parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'body'] } } },
]

function trimMessages(messages: any[]): any[] {
  if (messages.length <= 7) return messages
  
  const systemMessage = messages[0]
  const rest = messages.slice(1)
  
  let trimmed = rest.slice(-6)
  
  while (
    trimmed.length > 0 && 
    (trimmed[0].role === 'tool' || 
    (trimmed[0].role === 'assistant' && !trimmed[0].content && trimmed[0].tool_calls))
  ) {
    trimmed = trimmed.slice(1)
  }
  
  return [systemMessage, ...trimmed]
}

const SYSTEM_PROMPT = `You are Unclawned, a browser automation agent.

CRITICAL RULES TO SAVE TOKENS:
- Keep your responses extremely concise
- Never repeat what you already know
- After a snapshot, only mention elements you plan to interact with
- Never describe the full page — just what matters for the task
- Maximum 3 retry attempts per element then try a different approach
- If a cookie/consent popup appears, dismiss it FIRST before anything else using browser_click

COOKIE POPUP RULE — HIGHEST PRIORITY:
When ANY element has 'cookie', 'consent', 'onetrust', 'banner', 'gdpr' in its class or text:
1. Take a snapshot immediately
2. Look for buttons in this order: 'Reject', 'Reject all', 'Decline', 'Close', 'Accept', 'Accept all', 'Agree', 'OK', 'Got it'
3. Click the FIRST one you find using browser_click
4. Wait 500ms then take another snapshot
5. Only then continue with the original task
NEVER try to click through a cookie popup — always handle it first
NEVER try to click the same element more than twice — if it fails twice take a snapshot and try different approach
- Never click elements outside the viewport — scroll first using browser_scroll

TOKEN SAVING RULES:
- For Google searches: navigate directly to the URL with search query instead of typing in the search box. Example: navigate to https://www.google.com/search?q=your+search+query
- Never read more than 3 search results
- After finding the answer stop immediately — do not keep browsing
- Keep all your responses under 100 words
- Never explain what you are about to do — just do it
- Never summarize what you already did — just report the final answer

VIEWPORT RULE:
- Before clicking ANY element, always call browser_scroll down first if the element might be below the fold
- Never click 'Skip to main content' buttons — they are invisible helper elements, ignore them completely
- If an element is outside viewport after scrolling, take a new snapshot and find a visible alternative

HOW YOU WORK:
- Call browser_snapshot to see the page — it shows interactive elements with refs like e1, e2
- Use refs to click, type, and interact
- After every action, call browser_snapshot to see what changed
- Keep going until the task is done, then call task_complete

RULES:
- Never assume an action worked — always snapshot after to verify
- If you can't find an element, snapshot again — the page may have changed
- If something fails twice, try a different approach
- Never try to log in — the user is already logged in
- Only call task_complete when you can see the result on the page
- Only call task_failed after exhausting all approaches

IMPORTANT URL RULES:
- Always use full URLs with https:// prefix
- "X" or "Twitter" = https://x.com
- "Google" = https://google.com  
- "YouTube" = https://youtube.com
- "Gmail" = https://mail.google.com
- Never navigate to a plain word — always use a full https:// URL

RELIABILITY RULES:
- If a page takes too long to load, take a snapshot anyway and work with what you have
- If you click something and nothing happens after a snapshot, try a different approach
- If you see a cookie consent or popup blocking the page, dismiss it first before doing anything else
- If you cannot complete the task after 2 attempts, call task_failed with a clear reason why
- Never get stuck in a loop doing the same action repeatedly
- If you see a login page, do NOT try to log in — tell the user they need to be logged in to that site first
- Always call task_complete or task_failed — never leave a task hanging`

async function runAgentLoop(opts: {
  userId: string
  taskId: string
  taskPrompt: string
  tabKey: string
  onProgress: (msg: string) => Promise<void>
}): Promise<{ success: boolean; summary: string }> {
  const MAX_ITERATIONS = 20
  const deadline = Date.now() + 90_000

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: attempt === 0
        ? opts.taskPrompt
        : `${opts.taskPrompt}\n\nNote: first attempt failed. Try a different approach.`
      }
    ]

    let iterations = 0
    let shouldRetry = false
    let retryReason = ''
    let consecutiveSnapshots = 0

    while (iterations < MAX_ITERATIONS && Date.now() < deadline) {
      iterations++

      const trimmedMessages = trimMessages(messages)

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: trimmedMessages,
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

        try {
          switch (toolCall.function.name) {
            case 'browser_snapshot': {
              consecutiveSnapshots++
              if (consecutiveSnapshots > 3) {
                await opts.onProgress('📸 Reading page...')
                result = await snapshotPage(opts.tabKey)
                result += '\n\nWARNING: You have taken too many snapshots in a row. You MUST now either click something, navigate somewhere, or call task_complete/task_failed. Do not take another snapshot.'
                break
              }
              await opts.onProgress('📸 Reading page...')
              result = await snapshotPage(opts.tabKey)
              break
            }
            case 'browser_navigate': {
              await opts.onProgress(`🌐 Navigating to ${args.url}...`)
              await navigateTo(args.url, opts.userId)
              result = await snapshotPage(opts.tabKey)
              result = `Navigated. Page:\n${result}`
              break
            }
            case 'browser_click': {
              await opts.onProgress(`🖱️ Clicking ${args.ref}...`)
              await clickRef(opts.tabKey, args.ref, opts.userId)
              await new Promise(r => setTimeout(r, 500))
              result = await snapshotPage(opts.tabKey)
              result = `Clicked. Page:\n${result}`
              break
            }
            case 'browser_type': {
              await opts.onProgress(`⌨️ Typing into ${args.ref}...`)
              await typeInRef(opts.tabKey, args.ref, args.text, opts.userId)
              if (args.submit) await pressKey('Enter', opts.userId)
              await new Promise(r => setTimeout(r, 300))
              result = await snapshotPage(opts.tabKey)
              result = `Typed. Page:\n${result}`
              break
            }
            case 'browser_key': {
              await opts.onProgress(`⌨️ Pressing ${args.key}...`)
              await pressKey(args.key, opts.userId)
              await new Promise(r => setTimeout(r, 300))
              result = `Pressed ${args.key}`
              break
            }
            case 'browser_scroll': {
              await scrollPage(args.direction, args.amount, opts.userId)
              result = `Scrolled ${args.direction}`
              break
            }
            case 'browser_wait': {
              await new Promise(r => setTimeout(r, Math.min(args.ms || 1000, 10000)))
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
              result = `Created: ${args.title}`
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
            case 'github_create_issue': {
              if (!await isProviderConnected(opts.userId, 'github')) { result = 'GitHub not connected'; break }
              result = `Created issue: ${args.title}`
              break
            }
            default:
              consecutiveSnapshots = 0
              result = `Unknown tool: ${toolCall.function.name}`
          }
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`
          await opts.onProgress(`⚠️ ${result}`)
        }

        toolResults.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
      }

      messages.push(...toolResults)
      if (shouldRetry) break
    }

    if (!shouldRetry) return { success: false, summary: 'Exceeded max iterations' }
    if (attempt >= 1) return { success: false, summary: retryReason }
    await opts.onProgress(`🔄 Retrying task...`)
  }

  return { success: false, summary: 'Exceeded max attempts' }
}

type StepLog = { step: number; description: string; action: string; success: boolean }

export async function runAgentWithExtension(
  task: string,
  userId: string,
  onStep: (step: string) => Promise<void>,
  taskId?: string,
  keepTabOpen = false
): Promise<string> {
  const taskKey = taskId || `${userId}:${task.slice(0, 50)}`
  if (runningTasks.has(taskKey)) throw new Error('Task already running')
  runningTasks.add(taskKey)

  const startTime = Date.now()
  const stepsLog: StepLog[] = []
  let status: 'success' | 'error' = 'success'
  let resultSummary = ''
  let newTabId: number | null = null

  try {
    await onStep('🔌 Connecting to browser...')

    const { sendExtensionMessage } = await import('../index.js')

    await onStep('🌐 Opening new browser tab...')
    console.log(`[agent] sending createAndAttachTab for ${userId}`)

    const tabResult = await sendExtensionMessage(userId, 'createAndAttachTab', { url: 'about:blank' }, 60000) as any
    console.log(`[agent] createAndAttachTab result:`, JSON.stringify(tabResult))

    newTabId = tabResult?.tabId ?? null
    if (!newTabId) throw new Error('Extension did not return a tab ID.')

    console.log(`[agent] tab ${newTabId} ready, waiting for relay...`)
    await new Promise(r => setTimeout(r, 2000))

    const relayPort = getRelayPortForUser(userId)
    const wsUrl = `ws://127.0.0.1:${relayPort}/cdp`
    console.log(`[agent] connecting Playwright to ${wsUrl}`)

    await onStep('✅ Tab ready. Starting task...')

    const tabKey = `${userId}:${Date.now()}`
    const result = await runAgentLoop({
      userId,
      taskId: taskId || taskKey,
      taskPrompt: task,
      tabKey,
      onProgress: async (msg) => {
        stepsLog.push({ step: stepsLog.length + 1, description: msg, action: msg, success: !msg.startsWith('⚠️') && !msg.startsWith('❌') })
        await onStep(msg)
      }
    })

    status = result.success ? 'success' : 'error'
    resultSummary = result.summary
    if (taskId) await createMessage(userId, taskId, result.success ? `✅ Task completed successfully` : `⚠️ Task could not be completed`)
    return resultSummary

  } catch (err) {
    status = 'error'
    resultSummary = err instanceof Error ? err.message : String(err)
    if (taskId) await createMessage(userId, taskId, '⚠️ Task failed. Please try again.')
    return resultSummary

  } finally {
    runningTasks.delete(taskKey)

    const tabId = newTabId

    // Always detach debugger so browser is no longer controlled
    try {
      if (tabId) {
        const { sendCdpCommand: disableDebugger } = await import('../index.js')
        await disableDebugger(userId, 'Debugger.disable', {}, tabId)
        const { sendExtensionMessage: detachMsg } = await import('../index.js')
        await detachMsg(userId, 'detachTab', { tabId })
      }
    } catch {
      // ignore
    }

    // Only close tab if keepTabOpen is false
    if (!keepTabOpen) {
      try {
        if (tabId) {
          await new Promise(r => setTimeout(r, 1000))
          const { sendExtensionMessage: closeMsg } = await import('../index.js')
          await closeMsg(userId, 'closeTab', { tabId })
          console.log(`[agent] closed tab ${tabId}`)
        }
      } catch {
        // ignore
      }
    }

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