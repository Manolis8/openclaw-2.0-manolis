import OpenAI from 'openai'
import { sendCdpCommand, sendExtensionMessage } from '../index.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const SYSTEM_PROMPT = `You are an expert browser automation agent controlling a real Chrome browser.
Rules:
- Always navigate first then snapshot to see the page
- Use refs from snapshot to interact with elements
- The user is already logged into their accounts — do not try to log in
- Complete tasks in minimum steps
- Call done when you have the result`

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
    // existing agent loop code stays exactly the same
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: task }
    ]

    const emojis: Record<string, string> = {
      navigate: '🌐', snapshot: '👁️', click: '👆',
      type: '⌨️', extract: '🔍', scroll: '⬇️',
      wait: '⏳', done: '✅'
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
          // Handle both function and custom tool call types
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
    // Close the tab when done regardless of success or error
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
