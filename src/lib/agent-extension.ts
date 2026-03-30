import OpenAI from 'openai'
import { sendCdpCommand, sendExtensionMessage } from '../index.js'
import { isProviderConnected } from './api-caller.js'
import * as gmail from './integrations/gmail.js'
import * as notion from './integrations/notion.js'
import * as slack from './integrations/slack.js'
import * as github from './integrations/github.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const SYSTEM_PROMPT = `You are an expert browser automation agent with access to integrations.
IMPORTANT: For Gmail, Notion, Slack, and GitHub tasks, ALWAYS use the API tools first. Do NOT use the browser.
API tools available:
- gmail_list, gmail_send, gmail_read, gmail_summarize
- notion_create_page, notion_list_databases, notion_query_database
- slack_send, slack_list_channels, slack_read_messages
- github_create_issue, github_list_repos, github_list_issues

Rules:
1. If task mentions Gmail/Notion/Slack/GitHub → use ONLY the API tools, never the browser
2. For other websites (Twitter, LinkedIn, etc) → use browser automation
3. Always call the appropriate API tool first before trying the browser
4. Complete tasks in minimum steps
5. Call done when you have the result
6. The user is already logged into their accounts`

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
      description: 'Click an element by CSS selector or text',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description: 'Type text into an input field',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' }
        },
        required: ['selector', 'text']
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
          direction: { type: 'string', enum: ['down', 'up'] }
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
      await new Promise(r => setTimeout(r, 1500))
      return `Navigated to ${args.url}`
    }
    case 'snapshot': {
      const result = await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: `document.body.innerText`,
        returnByValue: true
      }, tabId)
      const text = result?.result?.value || ''
      const url = await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: 'window.location.href',
        returnByValue: true
      }, tabId)
      return `URL: ${url?.result?.value}\n\n${text.slice(0, 4000)}`
    }
    case 'click': {
      await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector('${args.selector}')
              || [...document.querySelectorAll('*')].find(e => e.textContent.trim() === '${args.selector}')
            if (el) { el.click(); return 'clicked' }
            return 'not found'
          })()
        `,
        returnByValue: true
      }, tabId)
      await new Promise(r => setTimeout(r, 500))
      return `Clicked ${args.selector}`
    }
    case 'type': {
      await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector('${args.selector}')
            if (el) {
              el.focus()
              el.value = '${args.text}'
              el.dispatchEvent(new Event('input', { bubbles: true }))
              el.dispatchEvent(new Event('change', { bubbles: true }))
              return 'typed'
            }
            return 'not found'
          })()
        `,
        returnByValue: true
      }, tabId)
      return `Typed "${args.text}" into ${args.selector}`
    }
    case 'extract': {
      const result = await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: 'document.body.innerText',
        returnByValue: true
      }, tabId)
      const text = result?.result?.value || ''
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Extract the requested data from the page text. Be specific and structured.' },
          { role: 'user', content: `${args.instruction}\n\nPage text:\n${text.slice(0, 6000)}` }
        ],
        max_tokens: 800
      })
      return response.choices[0].message.content || 'Nothing extracted'
    }
    case 'scroll': {
      const y = args.direction === 'down' ? 600 : -600
      await sendCdpCommand(userId, 'Runtime.evaluate', {
        expression: `window.scrollBy(0, ${y})`,
        returnByValue: false
      }, tabId)
      return `Scrolled ${args.direction}`
    }
    case 'wait': {
      const ms = Math.min(Number(args.ms) || 1000, 3000)
      await new Promise(r => setTimeout(r, ms))
      return `Waited ${ms}ms`
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
  onStep: (step: string) => Promise<void>
): Promise<string> {
  await onStep('🔌 Opening browser tab...')
  const tabId = await initializeTab(userId)

  try {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: task }
    ]

    const emojis: Record<string, string> = {
      navigate: '🌐', snapshot: '👁️', click: '👆',
      type: '⌨️', extract: '🔍', scroll: '⬇️',
      wait: '⏳', done: '✅',
      gmail_list: '📧', gmail_send: '✉️', gmail_read: '📬', gmail_summarize: '📨',
      notion_create_page: '📝', notion_list_databases: '🗄️', notion_query_database: '🔎',
      slack_send: '💬', slack_list_channels: '📡', slack_read_messages: '💭',
      github_create_issue: '🐛', github_list_repos: '📦', github_list_issues: '📋'
    }

    for (let i = 0; i < 25; i++) {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools,
        max_tokens: 1000
      })

      const choice = response.choices[0]

      if (choice.finish_reason === 'stop') {
        return choice.message.content || 'Task completed'
      }

      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
        messages.push(choice.message)

        for (const toolCall of choice.message.tool_calls) {
          if (toolCall.type !== 'function') continue
          const toolName = toolCall.function.name
          const args = JSON.parse(toolCall.function.arguments)

          const stepDesc = toolName === 'navigate'
            ? `🌐 Navigating to ${args.url}`
            : toolName === 'extract'
            ? `🔍 Extracting: ${args.instruction}`
            : toolName === 'done'
            ? `✅ Done`
            : `${emojis[toolName] || '⚙️'} ${toolName}`

          await onStep(stepDesc)

          const result = await executeTool(toolName, args, userId, tabId)

          if (result.startsWith('DONE:')) {
            return result.replace('DONE:', '')
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result
          })
        }
      }
    }
    return 'Max iterations reached'
  } finally {
    if (tabId) {
      try {
        await sendExtensionMessage(userId, 'closeTab', { tabId }, 5000)
        await onStep('🗂️ Browser tab closed')
      } catch {
        // ignore close errors
      }
    }
  }
}
