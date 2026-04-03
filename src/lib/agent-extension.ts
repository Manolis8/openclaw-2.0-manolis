import OpenAI from 'openai'
import { sendExtensionMessage, extensionConnections } from '../index.js'
import { isProviderConnected } from './api-caller.js'
import { createMessage } from './scheduler.js'
import { supabase } from './supabase.js'
import * as gmail from './integrations/gmail.js'
import * as notion from './integrations/notion.js'
import * as slack from './integrations/slack.js'
import * as github from './integrations/github.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const runningTasks = new Set<string>()
const sessionRefs = new Map<string, Record<string, { role: string; name?: string; nodeId: string }>>()

async function openAndAttachTab(userId: string, url = 'about:blank'): Promise<void> {
  const ws = extensionConnections.get(userId)
  if (!ws || ws.readyState !== 1) {
    throw new Error('Extension not connected. Install the Felo extension and make sure it is connected.')
  }

  await sendExtensionMessage(userId, 'createAndAttachTab', { url }, 15000)
  await new Promise(resolve => setTimeout(resolve, 1500))
}

async function closeTab(userId: string): Promise<void> {
  const ws = extensionConnections.get(userId)
  if (!ws || ws.readyState !== 1) return

  try {
    await sendExtensionMessage(userId, 'closeCurrentTab', {}, 5000)
  } catch {}
}

async function navigateTo(userId: string, url: string): Promise<void> {
  await sendExtensionMessage(userId, 'navigateTo', { url }, 20000)
  await new Promise(resolve => setTimeout(resolve, 2000))
}

async function getAriaSnapshot(userId: string): Promise<string> {
  const result = await sendExtensionMessage(userId, 'getAriaSnapshot', {}, 15000) as any
  const url = result?.url ?? 'unknown'
  const nodes = result?.nodes ?? []
  const lines = buildSnapshotWithRefs(nodes, userId, '')
  return `URL: ${url}\n${lines || '(no interactive elements)'}`
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'option', 'searchbox', 'slider', 'switch', 'tab'
])

function buildSnapshotWithRefs(
  nodes: Array<{ role?: string; name?: string; nodeId?: string }>,
  userId: string,
  tabKey: string
): string {
  const refs: Record<string, { role: string; name?: string; nodeId: string }> = {}
  const lines: string[] = []
  let counter = 0

  for (const node of nodes) {
    const role = node.role?.toLowerCase() ?? ''
    const name = node.name ?? ''
    if (!role || role === 'none' || role === 'generic') continue

    counter++
    const ref = `e${counter}`
    let line = `- ${role}`
    if (name) line += ` "${name}"`

    if (INTERACTIVE_ROLES.has(role)) {
      line += ` [ref=${ref}]`
      refs[ref] = { role, name: name || undefined, nodeId: node.nodeId ?? '' }
    }
    lines.push(line)
  }

  if (tabKey) sessionRefs.set(tabKey, refs)
  return lines.join('\n') || '(no interactive elements)'
}

async function snapshotPage(userId: string, tabKey: string): Promise<string> {
  const result = await sendExtensionMessage(userId, 'getAriaSnapshot', {}, 15000) as any
  const url = result?.url ?? 'unknown'
  const nodes = result?.nodes ?? []
  const snapshot = buildSnapshotWithRefs(nodes, userId, tabKey)
  return `URL: ${url}\n${snapshot}`
}

async function clickRef(userId: string, tabKey: string, ref: string): Promise<void> {
  const refs = sessionRefs.get(tabKey)
  const target = refs?.[ref]
  if (!target) throw new Error(`Unknown ref "${ref}". Call browser_snapshot first.`)

  if (target.name) {
    await sendExtensionMessage(userId, 'clickByText', { text: target.name }, 10000)
  } else {
    await sendExtensionMessage(userId, 'clickByRole', { role: target.role }, 10000)
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}

async function typeInRef(userId: string, tabKey: string, ref: string, text: string): Promise<void> {
  const refs = sessionRefs.get(tabKey)
  const target = refs?.[ref]
  if (!target) throw new Error(`Unknown ref "${ref}". Call browser_snapshot first.`)

  if (target.name) {
    await sendExtensionMessage(userId, 'typeIntoByText', { text: target.name, value: text }, 10000)
  } else {
    await sendExtensionMessage(userId, 'typeIntoByRole', { role: target.role, value: text }, 10000)
  }
}

async function pressKey(userId: string, key: string): Promise<void> {
  await sendExtensionMessage(userId, 'pressKey', { key }, 5000)
}

async function scrollPage(userId: string, direction: 'up' | 'down', amount = 300): Promise<void> {
  await sendExtensionMessage(userId, 'scrollPage', { direction, amount }, 5000)
}

const browserTools: OpenAI.Chat.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'browser_snapshot', description: 'Read the current page. Returns interactive elements with ref IDs. ALWAYS call first and after every action.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'browser_navigate', description: 'Navigate to a URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_click', description: 'Click an element by ref from the last snapshot.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'browser_type', description: 'Type text into an input or textbox.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] } } },
  { type: 'function', function: { name: 'browser_key', description: 'Press a key: Enter, Tab, Escape, ArrowDown, ArrowUp.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'browser_scroll', description: 'Scroll the page.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'browser_wait', description: 'Wait milliseconds.', parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } } },
  { type: 'function', function: { name: 'task_complete', description: 'Task done. Only call after visual confirmation.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
  { type: 'function', function: { name: 'task_failed', description: 'Task failed.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
  { type: 'function', function: { name: 'gmail_list', description: 'List Gmail emails', parameters: { type: 'object', properties: { maxResults: { type: 'number' } } } } },
  { type: 'function', function: { name: 'gmail_send', description: 'Send email', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } } },
  { type: 'function', function: { name: 'gmail_read', description: 'Read email', parameters: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] } } },
  { type: 'function', function: { name: 'gmail_summarize', description: 'Summarize emails', parameters: { type: 'object', properties: {} } } },
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

const SYSTEM_PROMPT = `You are Felo, an AI browser agent. You control the user's Chrome browser via the Felo extension.

Rules:
- ALWAYS call browser_snapshot before any action and after every action
- NEVER call task_complete without visual confirmation the task worked
- If a ref fails, call browser_snapshot again for fresh refs
- Do not attempt to log in — assume user is already logged in`

async function runAgentLoop(opts: {
  userId: string
  taskId: string
  taskPrompt: string
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
              await opts.onProgress(`����️ Clicking ${args.ref}...`)
              await clickRef(opts.userId, opts.tabKey, args.ref)
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Clicked. Page:\n${result}`
              break
            }
            case 'browser_type': {
              await opts.onProgress(`⌨️ Typing into ${args.ref}...`)
              await typeInRef(opts.userId, opts.tabKey, args.ref, args.text)
              if (args.submit) await pressKey(opts.userId, 'Enter')
              result = await snapshotPage(opts.userId, opts.tabKey)
              result = `Typed. Page:\n${result}`
              break
            }
            case 'browser_key': {
              await opts.onProgress(`⌨️ Pressing ${args.key}...`)
              await pressKey(opts.userId, args.key)
              result = `Pressed ${args.key}`
              break
            }
            case 'browser_scroll': {
              await scrollPage(opts.userId, args.direction, args.amount)
              result = `Scrolled ${args.direction}`
              break
            }
            case 'browser_wait': {
              await new Promise(r => setTimeout(r, args.ms || 1000))
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
                messages[1] = { role: 'user', content: `${opts.taskPrompt}\n\nFirst attempt failed: ${args.reason}. Try differently.` }
              } else {
                await opts.onProgress(`❌ ${args.reason}`)
                return { success: false, summary: args.reason }
              }
              result = 'Retrying'
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
    }
  }

  return { success: false, summary: 'Exceeded max iterations' }
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
    await onStep('🔌 Opening a new browser tab...')
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