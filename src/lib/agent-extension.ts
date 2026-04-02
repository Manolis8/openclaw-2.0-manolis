import OpenAI from 'openai'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { isProviderConnected } from './api-caller.js'
import { createMessage } from './scheduler.js'
import { supabase } from './supabase.js'
import * as gmail from './integrations/gmail.js'
import * as notion from './integrations/notion.js'
import * as slack from './integrations/slack.js'
import * as github from './integrations/github.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const runningTasks = new Set<string>()

// ─── Per-user Playwright browser connection, reused across tasks ───

const userBrowserConnections = new Map<string, Browser>()

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'

async function getPlaywrightPage(userId: string): Promise<{ page: Page; browser: Browser }> {
  let browser = userBrowserConnections.get(userId)
  if (!browser || !browser.isConnected()) {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10_000 })
    userBrowserConnections.set(userId, browser)
    browser.on('disconnected', () => {
      userBrowserConnections.delete(userId)
    })
  }

  const context = browser.contexts()[0]
  if (!context) {
    throw new Error('No browser context available. Is the extension relay running?')
  }

  const pages = context.pages()
  const page = pages.find(p => p.url() !== 'about:blank') ?? pages[0]
  if (!page) {
    throw new Error('No open tabs found. Open a tab in Chrome first.')
  }

  return { page, browser }
}

// ─── Snapshot / role-ref system ───

type RoleRef = { role: string; name?: string; nth?: number }
type RoleRefMap = Record<string, RoleRef>

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'treeitem'
])

// Per-tab ref storage: key = userId:tabKey
const tabRoleRefs = new Map<string, { refs: RoleRefMap; url: string }>()

function buildRoleRefsFromSnapshot(ariaSnapshot: string): { snapshot: string; refs: RoleRefMap } {
  const lines = ariaSnapshot.split('\n')
  const refs: RoleRefMap = {}
  const counts = new Map<string, number>()
  const refsByKey = new Map<string, string[]>()
  const out: string[] = []
  let counter = 0

  const getKey = (role: string, name?: string) => `${role}:${name ?? ''}`

  for (const line of lines) {
    const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/)
    if (!match) { out.push(line); continue }
    const [, prefix, roleRaw, name, suffix] = match
    const role = roleRaw.toLowerCase()
    if (!INTERACTIVE_ROLES.has(role)) { out.push(line); continue }

    counter++
    const ref = `e${counter}`
    const key = getKey(role, name)
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

  // Remove nth from non-duplicates
  for (const [key, refList] of refsByKey) {
    if (refList.length <= 1) {
      for (const r of refList) { delete refs[r]?.nth }
    }
  }

  return {
    snapshot: out.join('\n') || '(no interactive elements)',
    refs
  }
}

async function snapshotPage(page: Page, tabKey: string): Promise<string> {
  const ariaSnapshot = await page.locator(':root').ariaSnapshot()
  const url = page.url()
  const { snapshot, refs } = buildRoleRefsFromSnapshot(ariaSnapshot)
  tabRoleRefs.set(tabKey, { refs, url })
  return `URL: ${url}\n${snapshot}`
}

// ─── Element resolution via Playwright getByRole ───

function refLocator(page: Page, ref: string, tabKey: string) {
  const stored = tabRoleRefs.get(tabKey)
  if (!stored?.refs[ref]) {
    throw new Error(`Unknown ref "${ref}". Run a new snapshot — refs may be stale.`)
  }
  const { role, name, nth = 0 } = stored.refs[ref]
  const locator = name
    ? page.getByRole(role as any, { name, exact: true })
    : page.getByRole(role as any)
  return nth > 0 ? locator.nth(nth) : locator
}

// ─── Browser tools for the LLM agent loop ───

const browserTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Read the current page. Returns interactive elements with refs like e1, e2. Always call first, and after every action to verify it worked.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate to a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element by ref from the last snapshot.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into a textbox or input.',
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
      description: 'Press a keyboard key like Enter, Tab, Escape.',
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
      description: 'Scroll the page.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'number' }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: 'Wait for page to stabilize or for text to appear.',
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
      description: 'Call when task is confirmed done. Require visual confirmation — composer closed, form gone, item visible.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_failed',
      description: 'Call when task cannot be completed.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
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

const AGENT_SYSTEM_PROMPT = `You are Felo, an AI browser agent. You control a real Chrome browser.

After every action call browser_snapshot to see what changed. Only call task_complete when the page confirms success — composer closed, form gone, confirmation visible. Never call task_complete just because you clicked something.

If an action fails or the page looks the same, try a different approach. Do not repeat the same action more than twice.`

// ─── Agent execution loop ───

async function runAgentLoop(opts: {
  userId: string
  taskId: string
  taskPrompt: string
  page: Page
  tabKey: string
  onProgress: (msg: string) => void
}): Promise<{ success: boolean; summary: string }> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: opts.taskPrompt }
  ]

  const MAX_ITERATIONS = 20
  const TOTAL_TIMEOUT_MS = 90_000
  const deadline = Date.now() + TOTAL_TIMEOUT_MS

  // Outer retry: 2 attempts
  for (let attempt = 0; attempt < 2; attempt++) {
    let iterations = 0
    while (iterations < MAX_ITERATIONS && Date.now() < deadline) {
      iterations++

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools: browserTools as any,
        tool_choice: 'required',
        max_tokens: 1000,
      })

      const msg = response.choices[0].message
      messages.push(msg)

      if (!msg.tool_calls?.length) {
        return { success: false, summary: 'Agent stopped without completing task' }
      }

      const toolResults: OpenAI.ChatCompletionToolMessageParam[] = []
      for (const tc of msg.tool_calls) {
        const toolCall = tc as any
        const args = JSON.parse(toolCall.function.arguments || '{}')
        let result: string

        try {
          switch (toolCall.function.name) {
            case 'browser_snapshot': {
              opts.onProgress('📸 Reading page...')
              result = await snapshotPage(opts.page, opts.tabKey)
              break
            }
            case 'browser_navigate': {
              opts.onProgress(`🌐 Navigating to ${args.url}...`)
              await opts.page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
              await opts.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
              result = await snapshotPage(opts.page, opts.tabKey)
              result = `Navigated to ${args.url}. Page is now:\n${result}`
              break
            }
            case 'browser_click': {
              opts.onProgress(`🖱️ Clicking ${args.ref}...`)
              const locator = refLocator(opts.page, args.ref, opts.tabKey)
              await locator.click({ timeout: 8000 })
              await opts.page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
              result = await snapshotPage(opts.page, opts.tabKey)
              result = `Clicked ${args.ref}. Page is now:\n${result}`
              break
            }
            case 'browser_type': {
              opts.onProgress(`⌨️ Typing into ${args.ref}...`)
              const locator = refLocator(opts.page, args.ref, opts.tabKey)
              await locator.fill(args.text, { timeout: 8000 })
              if (args.submit) {
                await locator.press('Enter')
              }
              result = await snapshotPage(opts.page, opts.tabKey)
              result = `Typed "${args.text}" into ${args.ref}. Page is now:\n${result}`
              break
            }
            case 'browser_key': {
              opts.onProgress(`⌨️ Pressing ${args.key}...`)
              await opts.page.keyboard.press(args.key)
              result = `Pressed ${args.key}`
              break
            }
            case 'browser_scroll': {
              const amount = args.amount ?? 300
              await opts.page.mouse.wheel(0, args.direction === 'down' ? amount : -amount)
              result = `Scrolled ${args.direction}`
              break
            }
            case 'browser_wait': {
              if (args.ms) await opts.page.waitForTimeout(args.ms)
              if (args.text) {
                await opts.page.getByText(args.text).first().waitFor({ state: 'visible', timeout: 5000 })
              }
              result = 'Done waiting'
              break
            }
            case 'task_complete': {
              opts.onProgress(`✅ Done: ${args.summary}`)
              return { success: true, summary: args.summary }
            }
            case 'task_failed': {
              if (attempt === 0) {
                opts.onProgress(`⚠️ Attempt 1 failed: ${args.reason}. Retrying...`)
                // Reset messages for retry
                messages.length = 2 // keep system + user
                messages.push({ role: 'user', content: `${opts.taskPrompt}\n\nPrevious attempt failed: ${args.reason}. Try a different approach.` })
              } else {
                opts.onProgress(`❌ Failed: ${args.reason}`)
                return { success: false, summary: args.reason }
              }
              result = 'Retrying...'
              break
            }
            // ── Integration tools ──
            case 'gmail_list': {
              const connected = await isProviderConnected(opts.userId, 'gmail')
              if (!connected) { result = 'Gmail not connected. Ask user to connect Gmail.'; break }
              result = JSON.stringify(await gmail.listEmails(opts.userId, { maxResults: args.maxResults || 10 }), null, 2)
              break
            }
            case 'gmail_send': {
              const connected = await isProviderConnected(opts.userId, 'gmail')
              if (!connected) { result = 'Gmail not connected. Ask user to connect Gmail.'; break }
              await gmail.sendEmail(opts.userId, args.to, args.subject, args.body)
              result = `Email sent to ${args.to}`
              break
            }
            case 'gmail_read': {
              const connected = await isProviderConnected(opts.userId, 'gmail')
              if (!connected) { result = 'Gmail not connected. Ask user to connect Gmail.'; break }
              result = (await gmail.getEmailContent(opts.userId, args.messageId)).slice(0, 2000)
              break
            }
            case 'gmail_summarize': {
              const connected = await isProviderConnected(opts.userId, 'gmail')
              if (!connected) { result = 'Gmail not connected. Ask user to connect Gmail.'; break }
              result = await gmail.summarizeEmails(opts.userId)
              break
            }
            case 'notion_create_page': {
              const connected = await isProviderConnected(opts.userId, 'notion')
              if (!connected) { result = 'Notion not connected. Ask user to connect Notion.'; break }
              await notion.createPage(opts.userId, args.parentId, args.title, args.content)
              result = `Created Notion page: ${args.title}`
              break
            }
            case 'notion_list_databases': {
              const connected = await isProviderConnected(opts.userId, 'notion')
              if (!connected) { result = 'Notion not connected. Ask user to connect Notion.'; break }
              result = JSON.stringify(await notion.listDatabases(opts.userId), null, 2)
              break
            }
            case 'notion_query_database': {
              const connected = await isProviderConnected(opts.userId, 'notion')
              if (!connected) { result = 'Notion not connected. Ask user to connect Notion.'; break }
              result = JSON.stringify(await notion.queryDatabase(opts.userId, args.databaseId), null, 2)
              break
            }
            case 'slack_send': {
              const connected = await isProviderConnected(opts.userId, 'slack')
              if (!connected) { result = 'Slack not connected. Ask user to connect Slack.'; break }
              await slack.sendMessage(opts.userId, args.channel, args.text)
              result = `Sent message to ${args.channel}`
              break
            }
            case 'slack_list_channels': {
              const connected = await isProviderConnected(opts.userId, 'slack')
              if (!connected) { result = 'Slack not connected. Ask user to connect Slack.'; break }
              result = JSON.stringify(await slack.listChannels(opts.userId), null, 2)
              break
            }
            case 'slack_read_messages': {
              const connected = await isProviderConnected(opts.userId, 'slack')
              if (!connected) { result = 'Slack not connected. Ask user to connect Slack.'; break }
              result = JSON.stringify(await slack.getMessages(opts.userId, args.channel, args.limit || 10), null, 2)
              break
            }
            case 'github_create_issue': {
              const connected = await isProviderConnected(opts.userId, 'github')
              if (!connected) { result = 'GitHub not connected. Ask user to connect GitHub.'; break }
              result = `Created GitHub issue: ${args.title}`
              break
            }
            case 'github_list_repos': {
              const connected = await isProviderConnected(opts.userId, 'github')
              if (!connected) { result = 'GitHub not connected. Ask user to connect GitHub.'; break }
              result = JSON.stringify(await github.listRepos(opts.userId), null, 2)
              break
            }
            case 'github_list_issues': {
              const connected = await isProviderConnected(opts.userId, 'github')
              if (!connected) { result = 'GitHub not connected. Ask user to connect GitHub.'; break }
              result = JSON.stringify(await github.listIssues(opts.userId, args.owner, args.repo, args.state || 'open'), null, 2)
              break
            }
            default:
              result = `Unknown tool: ${toolCall.function.name}`
          }
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`
          opts.onProgress(`⚠️ Error: ${result}`)
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

  return { success: false, summary: 'Task exceeded maximum iterations' }
}

// ─── Entry point ───

type StepLog = {
  step: number
  description: string
  action: string
  success: boolean
  errorMsg?: string
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
  let status: 'success' | 'error' = 'success'
  let resultSummary = ''

  try {
    await onStep('🔌 Connecting to your browser via Playwright...')
    const { page } = await getPlaywrightPage(userId)
    const tabKey = `${userId}:${Date.now()}`

    const result = await runAgentLoop({
      userId,
      taskId: taskId || taskKey,
      taskPrompt: task,
      page,
      tabKey,
      onProgress: async (msg) => {
        stepsLog.push({
          step: stepsLog.length + 1,
          description: msg,
          action: msg,
          success: !msg.startsWith('⚠️') && !msg.startsWith('❌')
        })
        await onStep(msg)
      }
    })

    status = result.success ? 'success' : 'error'
    resultSummary = result.summary

    if (taskId) {
      await createMessage(userId, taskId, result.success ? `✅ ${resultSummary}` : resultSummary.slice(0, 300))
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
