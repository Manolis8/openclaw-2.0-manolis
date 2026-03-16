import OpenAI from 'openai'
import type { Page } from 'playwright'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const SYSTEM_PROMPT = `You are an expert browser automation agent. Complete tasks accurately.

Rules:
- Always navigate to the correct URL first
- Always call snapshot after navigating to see the page
- The snapshot returns numbered refs like [1], [2] next to interactive elements
- Use act with a ref number to click, type, or interact with elements
- Use extract to pull specific data from the current page text
- Call done when you have the result
- Never guess selectors — always use refs from snapshot
- If a page seems empty, call wait then snapshot again
- For dynamic sites, wait 1-2 seconds after navigation before snapshotting`

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate to a URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL including https://' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'snapshot',
      description: 'Get the accessibility tree of the current page with numbered refs for interactive elements. Always call this after navigating.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'act',
      description: 'Interact with an element using its ref number from snapshot',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Ref number from snapshot e.g. "1" or "42"' },
          action: {
            type: 'string',
            enum: ['click', 'type', 'press_enter', 'scroll_down', 'scroll_up', 'hover', 'select'],
            description: 'Action to perform'
          },
          text: { type: 'string', description: 'Text to type (only for type action)' },
          value: { type: 'string', description: 'Value to select (only for select action)' }
        },
        required: ['action']
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
          instruction: { type: 'string', description: 'What data to extract from the page' }
        },
        required: ['instruction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for page content to load',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: 'Milliseconds to wait, max 3000' }
        },
        required: ['ms']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Task is complete — return the final result to the user',
      parameters: {
        type: 'object',
        properties: {
          result: { type: 'string', description: 'The final result to show the user' }
        },
        required: ['result']
      }
    }
  }
]

// Stored refs per page: refNumber -> elementHandle
const pageRefs = new WeakMap<Page, Map<number, string>>()

async function getSnapshot(page: Page): Promise<string> {
  const refs = new Map<number, string>()
  let counter = 0

  // Get accessibility tree - use type assertion for older API
  const snapshot = await (page as any).accessibility?.snapshot?.({ interestingOnly: true }) 
    || await page.evaluate(() => {
      // Fallback: build a simple accessibility tree from DOM
      const getEl = (el: Element): any => {
        const role = el.getAttribute('role') || 
          (el.tagName === 'A' ? 'link' : 
           el.tagName === 'BUTTON' ? 'button' : 
           el.tagName === 'INPUT' ? 'textbox' : 
           el.tagName === 'SELECT' ? 'combobox' : 'generic')
        const name = el.textContent?.trim() || el.getAttribute('name') || el.getAttribute('aria-label') || ''
        const children = Array.from(el.children).map(getEl).filter((c: any) => c.role !== 'generic')
        return { role, name, children }
      }
      return getEl(document.body)
    })

  function processNode(node: any, depth: number): string {
    if (!node) return ''
    const indent = '  '.repeat(depth)
    const role = node.role || ''
    const name = node.name || ''

    let line = ''
    const isInteractive = [
      'link', 'button', 'textbox', 'searchbox', 'combobox',
      'checkbox', 'radio', 'menuitem', 'tab', 'option',
      'spinbutton', 'slider', 'switch'
    ].includes(role.toLowerCase())

    if (isInteractive && name) {
      counter++
      refs.set(counter, name)
      line = `${indent}[${counter}] ${role}: ${name}`
    } else if (name && role !== 'generic' && role !== 'none') {
      line = `${indent}${role}: ${name}`
    }

    const children = (node.children || [])
      .map((child: any) => processNode(child, depth + 1))
      .filter(Boolean)
      .join('\n')

    return [line, children].filter(Boolean).join('\n')
  }

  const tree = processNode(snapshot, 0)
  pageRefs.set(page, refs)

  const url = page.url()
  const title = await page.title()
  return `URL: ${url}\nTitle: ${title}\n\n${tree}`.slice(0, 6000)
}

async function executeTool(
  name: string,
  args: Record<string, any>,
  page: Page
): Promise<string> {
  switch (name) {
    case 'navigate': {
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(500)
      return `Navigated to ${args.url}`
    }

    case 'snapshot': {
      return await getSnapshot(page)
    }

    case 'act': {
      const refs = pageRefs.get(page)
      const refNum = parseInt(args.ref)
      const refName = refs?.get(refNum)
      const action = args.action

      if (action === 'scroll_down') {
        await page.evaluate(() => window.scrollBy(0, 600))
        return 'Scrolled down'
      }
      if (action === 'scroll_up') {
        await page.evaluate(() => window.scrollBy(0, -600))
        return 'Scrolled up'
      }
      if (action === 'press_enter') {
        await page.keyboard.press('Enter')
        return 'Pressed Enter'
      }

      if (!refName) {
        return `Ref ${args.ref} not found in last snapshot. Call snapshot first.`
      }

      try {
        if (action === 'click') {
          await page.getByRole('link', { name: refName, exact: false }).first().click({ timeout: 5000 })
            .catch(() => page.getByRole('button', { name: refName, exact: false }).first().click({ timeout: 5000 }))
            .catch(() => page.getByText(refName, { exact: false }).first().click({ timeout: 5000 }))
          await page.waitForTimeout(500)
          return `Clicked "${refName}"`
        }
        if (action === 'type') {
          await page.getByRole('textbox', { name: refName, exact: false }).first().fill(args.text || '', { timeout: 5000 })
            .catch(() => page.getByRole('searchbox', { name: refName, exact: false }).first().fill(args.text || '', { timeout: 5000 }))
          return `Typed "${args.text}" into "${refName}"`
        }
        if (action === 'hover') {
          await page.getByText(refName, { exact: false }).first().hover({ timeout: 5000 })
          return `Hovered over "${refName}"`
        }
        if (action === 'select') {
          await page.getByRole('combobox', { name: refName, exact: false }).first().selectOption(args.value || '', { timeout: 5000 })
          return `Selected "${args.value}" in "${refName}"`
        }
      } catch (err) {
        return `Action failed on "${refName}": ${String(err)}`
      }
      return `Unknown action: ${action}`
    }

    case 'extract': {
      const text = await page.evaluate(() => document.body.innerText)
      const url = page.url()
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Extract the requested data from the page content. Be specific, structured and complete.'
          },
          {
            role: 'user',
            content: `Page URL: ${url}\nInstruction: ${args.instruction}\n\nPage content:\n${text.slice(0, 8000)}`
          }
        ],
        max_tokens: 1000
      })
      return response.choices[0].message.content || 'Nothing extracted'
    }

    case 'wait': {
      const ms = Math.min(Number(args.ms) || 1000, 3000)
      await page.waitForTimeout(ms)
      return `Waited ${ms}ms`
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

  const emojis: Record<string, string> = {
    navigate: '🌐',
    snapshot: '👁️',
    act: '👆',
    extract: '🔍',
    wait: '⏳',
    done: '✅'
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
        // OpenAI SDK v6+ uses toolCall.name and toolCall.arguments directly
        const tc = toolCall as any
        const toolName = tc.function?.name || tc.name
        const args = JSON.parse(tc.function?.arguments || tc.arguments || '{}')

        const stepDesc = toolName === 'act'
          ? `${emojis[toolName]} ${args.action} on ref [${args.ref}]${args.text ? `: "${args.text}"` : ''}`
          : toolName === 'navigate'
          ? `${emojis[toolName]} Navigating to ${args.url}`
          : toolName === 'extract'
          ? `${emojis[toolName]} Extracting: ${args.instruction}`
          : toolName === 'done'
          ? `✅ Done`
          : `${emojis[toolName] || '⚙️'} ${toolName}`

        await onStep(stepDesc)

        const result = await executeTool(toolName, args, page)

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
