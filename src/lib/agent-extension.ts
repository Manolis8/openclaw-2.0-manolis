import OpenAI from 'openai'
import { chromium } from 'playwright-core'
import { isProviderConnected } from './api-caller.js'
import { createMessage } from './scheduler.js'
import { supabase } from './supabase.js'
import * as gmail from './integrations/gmail.js'
import * as notion from './integrations/notion.js'
import * as slack from './integrations/slack.js'
import * as github from './integrations/github.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const runningTasks = new Set<string>()

const RELAY_BASE = 'http://127.0.0.1:18792'

const sessionRefs = new Map<string, Record<string, { role: string; name?: string; nth?: number }>>()

async function getPage(targetId?: string) {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  const cdpUrl = `${RELAY_BASE}/json/version?token=${encodeURIComponent(token)}`
  
  const res = await fetch(cdpUrl, {
    headers: { 'x-openclaw-relay-token': token }
  })
  const json = await res.json() as any
  const wsUrl = json.webSocketDebuggerUrl
  if (!wsUrl) throw new Error('No WebSocket URL from relay. Is a tab attached?')
  
  const browser = await chromium.connectOverCDP(wsUrl)
  const pages = browser.contexts().flatMap(c => c.pages())
  if (!pages.length) throw new Error('No pages available. Make sure a tab is open in Chrome.')
  const found = pages.find(p => p.url() !== 'about:blank') ?? pages[0]
  return { browser, page: found }
}

async function snapshotPage(tabKey: string, targetId?: string): Promise<string> {
  const { browser, page } = await getPage(targetId)
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

async function navigateTo(url: string, targetId?: string): Promise<void> {
  const { browser, page } = await getPage(targetId)
  try {
    await page.goto(url, { timeout: 30000 })
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await new Promise(r => setTimeout(r, 1000))
  } finally {
    await browser.close()
  }
}

async function clickRef(tabKey: string, ref: string, targetId?: string): Promise<void> {
  const refs = sessionRefs.get(tabKey)
  const target = refs?.[ref]
  if (!target) throw new Error(`Unknown ref "${ref}". Call browser_snapshot first.`)

  const { browser, page } = await getPage(targetId)
  try {
    const role = target.role as any
    const locator = target.name
      ? page.getByRole(role, { name: target.name, exact: true })
      : page.getByRole(role)
    const resolved = target.nth !== undefined ? locator.nth(target.nth) : locator
    await resolved.click({ timeout: 8000 })
  } finally {
    await browser.close()
  }
}

async function typeInRef(tabKey: string, ref: string, text: string, targetId?: string): Promise<void> {
  const refs = sessionRefs.get(tabKey)
  const target = refs?.[ref]
  if (!target) throw new Error(`Unknown ref "${ref}". Call browser_snapshot first.`)

  const { browser, page } = await getPage(targetId)
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

async function pressKey(key: string, targetId?: string): Promise<void> {
  const { browser, page } = await getPage(targetId)
  try {
    await page.keyboard.press(key)
  } finally {
    await browser.close()
  }
}

async function scrollPage(direction: 'up' | 'down', amount = 300, targetId?: string): Promise<void> {
  const { browser, page } = await getPage(targetId)
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

const SYSTEM_PROMPT = `You are Felo, an AI browser agent controlling a real Chrome tab via Playwright.

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
- Only call task_failed after exhausting all approaches`

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
      if (!msg.tool_calls?.length) return { success: false, summary: 'Agent stopped unexpectedly' }

      const toolResults: OpenAI.ChatCompletionToolMessageParam[] = []

      for (const toolCall of msg.tool_calls as any[]) {
        const args = JSON.parse(toolCall.function.arguments || '{}')
        let result: string

        try {
          switch (toolCall.function.name) {
            case 'browser_snapshot': {
              await opts.onProgress('📸 Reading page...')
              result = await snapshotPage(opts.tabKey)
              break
            }
            case 'browser_navigate': {
              await opts.onProgress(`🌐 Navigating to ${args.url}...`)
              await navigateTo(args.url)
              result = await snapshotPage(opts.tabKey)
              result = `Navigated. Page:\n${result}`
              break
            }
            case 'browser_click': {
              await opts.onProgress(`🖱️ Clicking ${args.ref}...`)
              await clickRef(opts.tabKey, args.ref)
              await new Promise(r => setTimeout(r, 500))
              result = await snapshotPage(opts.tabKey)
              result = `Clicked. Page:\n${result}`
              break
            }
            case 'browser_type': {
              await opts.onProgress(`⌨️ Typing into ${args.ref}...`)
              await typeInRef(opts.tabKey, args.ref, args.text)
              if (args.submit) await pressKey('Enter')
              await new Promise(r => setTimeout(r, 300))
              result = await snapshotPage(opts.tabKey)
              result = `Typed. Page:\n${result}`
              break
            }
            case 'browser_key': {
              await opts.onProgress(`⌨️ Pressing ${args.key}...`)
              await pressKey(args.key)
              await new Promise(r => setTimeout(r, 300))
              result = `Pressed ${args.key}`
              break
            }
            case 'browser_scroll': {
              await scrollPage(args.direction, args.amount)
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
  taskId?: string
): Promise<string> {
  const taskKey = taskId || `${userId}:${task.slice(0, 50)}`
  if (runningTasks.has(taskKey)) throw new Error('Task already running')
  runningTasks.add(taskKey)

  const startTime = Date.now()
  const stepsLog: StepLog[] = []
  let status: 'success' | 'error' = 'success'
  let resultSummary = ''

  try {
    await onStep('🔌 Connecting to browser...')

    const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''

    const relayRes = await fetch(`${RELAY_BASE}/json/version?token=${encodeURIComponent(token)}`, {
      headers: { 'x-openclaw-relay-token': token }
    }).catch(() => null)

    if (!relayRes?.ok) throw new Error('Extension not connected. Make sure the Felo extension is installed and the badge is ON.')

    const relayJson = await relayRes.json() as any

    if (!relayJson.webSocketDebuggerUrl) {
      await onStep('🌐 Opening new tab...')
      const { sendExtensionMessage } = await import('../index.js')
      sendExtensionMessage(userId, 'createAndAttachTab', { url: 'about:blank' }, 30000).catch(() => {})
      
      let wsUrl: string | null = null
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000))
        try {
          const check = await fetch(`${RELAY_BASE}/json/version?token=${encodeURIComponent(token)}`, {
            headers: { 'x-openclaw-relay-token': token }
          })
          const checkJson = await check.json() as any
          if (checkJson.webSocketDebuggerUrl) {
            wsUrl = checkJson.webSocketDebuggerUrl
            break
          }
        } catch {}
      }
      
      if (!wsUrl) throw new Error('Failed to open tab. Please click the extension badge on a Chrome tab manually.')
      await onStep('✅ Tab ready. Starting task...')
    } else {
      await onStep('✅ Connected. Starting task...')
    }

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
    if (taskId) await createMessage(userId, taskId, result.success ? `✅ ${resultSummary}` : resultSummary.slice(0, 300))
    return resultSummary

  } catch (err) {
    status = 'error'
    resultSummary = err instanceof Error ? err.message : String(err)
    if (taskId) await createMessage(userId, taskId, resultSummary.slice(0, 300))
    return resultSummary

  } finally {
    runningTasks.delete(taskKey)

    await new Promise(r => setTimeout(r, 3000))
    try {
      const { browser, page } = await getPage()
      await page.goto('about:blank')
      await browser.close()
    } catch {}

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