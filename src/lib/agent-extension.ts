import OpenAI from 'openai'
import { sendCdpCommand, sendExtensionMessage, extensionConnections } from '../index.js'
import { isProviderConnected } from './api-caller.js'
import { createMessage } from './scheduler.js'
import { supabase } from './supabase.js'
import * as gmail from './integrations/gmail.js'
import * as notion from './integrations/notion.js'
import * as slack from './integrations/slack.js'
import * as github from './integrations/github.js'
import { formatAriaSnapshot, type RawAXNode } from '../browser/cdp-snapshot.js'
import { buildRoleSnapshotFromAriaSnapshot } from '../browser/pw-role-snapshot.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const runningTasks = new Set<string>()
const userTabIds = new Map<string, number>()

const sessionRefs = new Map<string, Record<string, { role: string; name?: string; nodeId: string }>>()

async function openAndAttachTab(userId: string, url = 'about:blank'): Promise<number> {
  const ws = extensionConnections.get(userId)
  if (!ws || ws.readyState !== 1) {
    throw new Error('Extension not connected. Make sure the Felo extension is installed and connected.')
  }
  console.log(`[agent] sending createAndAttachTab for user ${userId}`)
  try {
    const result = await sendExtensionMessage(userId, 'createAndAttachTab', { url }, 20000) as any
    console.log(`[agent] createAndAttachTab result:`, JSON.stringify(result))
    const tabId = result?.tabId
    if (!tabId || typeof tabId !== 'number') {
      throw new Error(`Extension returned invalid tabId: ${JSON.stringify(result)}`)
    }
    userTabIds.set(userId, tabId)
    console.log(`[agent] tab ${tabId} ready for user ${userId}`)
    await new Promise(r => setTimeout(r, 1500))
    return tabId
  } catch (err) {
    console.error(`[agent] createAndAttachTab failed:`, err)
    throw new Error(`Failed to open browser tab: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function closeTab(userId: string): Promise<void> {
  const tabId = userTabIds.get(userId)
  userTabIds.delete(userId)
  if (!tabId) return
  try {
    await sendExtensionMessage(userId, 'closeTab', { tabId }, 5000)
  } catch {}
}

function getTabId(userId: string): number {
  const tabId = userTabIds.get(userId)
  if (!tabId) throw new Error(`No tab open for user ${userId}`)
  return tabId
}

async function cdp(userId: string, method: string, params: object = {}): Promise<any> {
  const tabId = getTabId(userId)
  return sendCdpCommand(userId, method, params, tabId, 15000)
}

async function navigateTo(userId: string, url: string): Promise<void> {
  await cdp(userId, 'Page.navigate', { url })
  await new Promise(r => setTimeout(r, 2500))
}

async function getPageUrl(userId: string): Promise<string> {
  try {
    const result = await cdp(userId, 'Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true
    })
    return result?.result?.value ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

async function snapshotPage(userId: string, tabKey: string): Promise<string> {
  const [axResult, url] = await Promise.all([
    cdp(userId, 'Accessibility.getFullAXTree', {}),
    getPageUrl(userId)
  ])

  const rawNodes: RawAXNode[] = axResult?.nodes ?? []

  const ariaNodes = formatAriaSnapshot(rawNodes, 500)

  const ariaText = ariaNodes
    .map(n => {
      const indent = '  '.repeat(n.depth)
      let line = `${indent}- ${n.role}`
      if (n.name) line += ` "${n.name}"`
      if (n.value) line += `: ${n.value}`
      return line
    })
    .join('\n')

  const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(ariaText, { interactive: true })

  sessionRefs.set(tabKey, Object.fromEntries(
    Object.entries(refs).map(([ref, data]) => [ref, {
      role: data.role,
      name: data.name,
      nodeId: ''
    }])
  ))

  const text = snapshot || '(no interactive elements)'
  return `URL: ${url}\n${text}`
}

async function clickRef(userId: string, tabKey: string, ref: string): Promise<void> {
  const refs = sessionRefs.get(tabKey)
  const target = refs?.[ref]
  if (!target) throw new Error(`Unknown ref "${ref}". Call browser_snapshot first.`)

  const nameSafe = (target.name ?? '').replace(/"/g, '\\"')
  const targetRole = target.role

  const result = await cdp(userId, 'Runtime.evaluate', {
    expression: `
      (() => {
        let el = document.querySelector('[aria-label="${nameSafe}"]');
        if (!el) {
          for (const c of document.querySelectorAll('[role="${targetRole}"]')) {
            if (c.getAttribute('aria-label') === '${nameSafe}' || c.textContent?.trim() === '${nameSafe}') {
              el = c; break;
            }
          }
        }
        if (!el && '${nameSafe}'.toLowerCase() === 'post') {
          el = document.querySelector('[data-testid="tweetButtonInline"]')
            || document.querySelector('[data-testid="tweetButton"]');
        }
        if (!el) {
          const tag = '${targetRole}' === 'link' ? 'a' : 'button';
          for (const c of document.querySelectorAll(tag)) {
            if (c.textContent?.trim() === '${nameSafe}' || c.getAttribute('aria-label') === '${nameSafe}') {
              el = c; break;
            }
          }
        }
        if (!el) el = document.querySelector('[role="${targetRole}"]');
        if (!el) return 'not_found';
        el.scrollIntoView({ block: 'center' });
        ['mousedown','mouseup','click'].forEach(t =>
          el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
        );
        el.click();
        return el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.tagName;
      })()
    `,
    returnByValue: true
  }) as any

  if (result?.result?.value === 'not_found') {
    throw new Error(`Could not find element for ref "${ref}" (${target.role} "${target.name}"). Take a new snapshot.`)
  }
  console.log(`[agent] clicked: ${result?.result?.value}`)
  await new Promise(r => setTimeout(r, 300))
}

async function typeInRef(userId: string, tabKey: string, ref: string, text: string): Promise<void> {
  const refs = sessionRefs.get(tabKey)
  const target = refs?.[ref]
  if (!target) throw new Error(`Unknown ref "${ref}". Call browser_snapshot first.`)

  const nameSafe = (target.name ?? '').replace(/"/g, '\\"')
  const targetRole = target.role

  await cdp(userId, 'Runtime.evaluate', {
    expression: `
      (() => {
        let el = document.querySelector('[aria-label="${nameSafe}"]');
        if (!el) el = document.querySelector('[role="${targetRole}"]');
        if (!el) return false;
        el.focus(); el.click(); return true;
      })()
    `,
    returnByValue: true
  })
  await new Promise(r => setTimeout(r, 200))

  await cdp(userId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 8 })
  await cdp(userId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 8 })
  await new Promise(r => setTimeout(r, 100))
  await cdp(userId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', keyCode: 8 })
  await cdp(userId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', keyCode: 8 })
  await new Promise(r => setTimeout(r, 100))

  await cdp(userId, 'Input.insertText', { text })
  await new Promise(r => setTimeout(r, 300))
}

async function pressKey(userId: string, key: string): Promise<void> {
  const keyMap: Record<string, { code: string; keyCode: number }> = {
    'Enter':     { code: 'Enter',     keyCode: 13 },
    'Tab':       { code: 'Tab',       keyCode: 9  },
    'Escape':    { code: 'Escape',    keyCode: 27 },
    'ArrowDown': { code: 'ArrowDown', keyCode: 40 },
    'ArrowUp':   { code: 'ArrowUp',   keyCode: 38 },
  }
  const k = keyMap[key] ?? { code: key, keyCode: 0 }
  await cdp(userId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: k.code, keyCode: k.keyCode })
  await cdp(userId, 'Input.dispatchKeyEvent', { type: 'keyUp',   key, code: k.code, keyCode: k.keyCode })
}

async function scrollPage(userId: string, direction: 'up' | 'down', amount = 300): Promise<void> {
  const delta = direction === 'down' ? amount : -amount
  await cdp(userId, 'Runtime.evaluate', { expression: `window.scrollBy(0, ${delta})`, returnByValue: true })
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

const SYSTEM_PROMPT = `You are Felo, an AI browser agent controlling a real Chrome tab.

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
              result = await snapshotPage(opts.userId, opts.tabKey)
              break
            }
            case 'browser_navigate': {
              await opts.onProgress(`🌐 Navigating to ${args.url}...`)
              await navigateTo(opts.userId, args.url)
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Navigated. Page:\n${result}`
              break
            }
            case 'browser_click': {
              await opts.onProgress(`🖱️ Clicking ${args.ref}...`)
              await clickRef(opts.userId, opts.tabKey, args.ref)
              await new Promise(r => setTimeout(r, 500))
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Clicked. Page:\n${result}`
              break
            }
            case 'browser_type': {
              await opts.onProgress(`⌨️ Typing into ${args.ref}...`)
              await typeInRef(opts.userId, opts.tabKey, args.ref, args.text)
              if (args.submit) await pressKey(opts.userId, 'Enter')
              await new Promise(r => setTimeout(r, 300))
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Typed. Page:\n${result}`
              break
            }
            case 'browser_key': {
              await opts.onProgress(`⌨️ Pressing ${args.key}...`)
              await pressKey(opts.userId, args.key)
              await new Promise(r => setTimeout(r, 300))
              result = `Pressed ${args.key}`
              break
            }
            case 'browser_scroll': {
              await scrollPage(opts.userId, args.direction, args.amount)
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
    await onStep('🔌 Opening browser tab...')
    await openAndAttachTab(userId, 'about:blank')
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
    if (taskId) await createMessage(userId, taskId, result.success ? `✅ ${resultSummary}` : resultSummary.slice(0, 300))
    return resultSummary

  } catch (err) {
    status = 'error'
    resultSummary = err instanceof Error ? err.message : String(err)
    if (taskId) await createMessage(userId, taskId, resultSummary.slice(0, 300))
    return resultSummary

  } finally {
    runningTasks.delete(taskKey)
    await closeTab(userId)
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