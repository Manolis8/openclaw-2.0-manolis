import OpenAI from 'openai'
import type { Page } from 'playwright'
import { isProviderConnected } from './api-caller.js'
import * as gmail from './integrations/gmail.js'
import * as notion from './integrations/notion.js'
import * as slack from './integrations/slack.js'
import * as github from './integrations/github.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const SYSTEM_PROMPT = `You are a browser automation agent. Complete the user's task using browser tools and integrations.
Rules:
- Always navigate to the right URL first
- Use snapshot to read page content before interacting
- Use extract to pull specific data from pages
- For Gmail/Slack/Notion/GitHub tasks, use the API tools instead of browser automation
- Complete tasks in minimum steps
- When you have the result call done immediately
- If a step fails try a different approach`

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate to a URL',
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
      description: 'Get visible text content of the current page',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element on the page',
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
      description: 'Signal task is complete with the final result',
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

async function executeTool(name: string, args: Record<string, string>, page: Page, userId: string): Promise<string> {
  switch (name) {
    case 'navigate': {
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      return `Navigated to ${args.url}`
    }
    case 'snapshot': {
      const text = await page.evaluate(() => document.body.innerText)
      return text.slice(0, 3000)
    }
    case 'click': {
      try {
        await page.click(args.selector, { timeout: 5000 })
      } catch {
        await page.getByText(args.selector).first().click({ timeout: 5000 })
      }
      return `Clicked ${args.selector}`
    }
    case 'type': {
      await page.fill(args.selector, args.text)
      return `Typed into ${args.selector}`
    }
    case 'extract': {
      const html = await page.evaluate(() => document.body.innerHTML)
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Extract the requested data from the HTML. Be concise.' },
          { role: 'user', content: `${args.instruction}\n\nHTML:\n${html.slice(0, 8000)}` }
        ],
        max_tokens: 500
      })
      return r.choices[0].message.content || 'Nothing extracted'
    }
    case 'gmail_list': {
      const connected = await isProviderConnected(userId, 'gmail')
      if (!connected) return 'Gmail not connected. Ask user to connect Gmail.'
      try {
        const result = await gmail.listEmails(userId, { maxResults: parseInt(args.maxResults) || 10 })
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
        await notion.createPage(userId, args.parentId as any, args.title, args.content)
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
        const result = await slack.getMessages(userId, args.channel, parseInt(args.limit) || 10)
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

export async function runAgent(
  task: string,
  page: Page,
  onStep: (step: string) => Promise<void>,
  userId: string
): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task }
  ]

  for (let i = 0; i < 20; i++) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools,
      max_tokens: 500
    })

    const choice = response.choices[0]

    if (choice.finish_reason === 'stop') {
      return choice.message.content || 'Task completed'
    }

    if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      messages.push(choice.message)

      for (const toolCall of choice.message.tool_calls!) {
        const functionCall = toolCall as any
        const name = functionCall.function.name
        const args = JSON.parse(functionCall.function.arguments)

        const emojis: Record<string, string> = {
          navigate: '🌐', snapshot: '👁️', click: '👆',
          type: '⌨️', extract: '🔍', done: '✅',
          gmail_list: '📧', gmail_send: '✉️', gmail_read: '📬', gmail_summarize: '📨',
          notion_create_page: '📝', notion_list_databases: '🗄️', notion_query_database: '🔎',
          slack_send: '💬', slack_list_channels: '📡', slack_read_messages: '💭',
          github_create_issue: '🐛', github_list_repos: '📦', github_list_issues: '📋'
        }

        await onStep(`${emojis[name] || '⚙️'} ${name}: ${JSON.stringify(args)}`)

        const result = await executeTool(name, args, page, userId)

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
}
