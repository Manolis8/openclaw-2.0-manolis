import OpenAI from 'openai'
import type { Page } from 'playwright'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const SYSTEM_PROMPT = `You are a browser automation agent. Complete the user's task using browser tools.
Rules:
- Always navigate to the right URL first
- Use snapshot to read page content before interacting
- Use extract to pull specific data from pages
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

async function executeTool(name: string, args: Record<string, string>, page: Page): Promise<string> {
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
  onStep: (step: string) => Promise<void>
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
          type: '⌨️', extract: '🔍', done: '✅'
        }

        await onStep(`${emojis[name] || '⚙️'} ${name}: ${JSON.stringify(args)}`)

        const result = await executeTool(name, args, page)

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
