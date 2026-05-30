import OpenAI from 'openai'
import { chatAgent } from './chat-agent.js'
import { runAgentLoop } from '../agent-extension.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

async function classifyTaskType(userMessage: string): Promise<'chat' | 'browser'> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 10,
    messages: [
      {
        role: 'system',
        content: `Classify if this REQUIRES browser access. Reply with ONLY "browser" or "chat".

BROWSER task (must have browser):
- Check/view/list repos, emails, messages, social media
- Find something on a website
- Do something on GitHub/email/social media/any website
- Access user's personal accounts or data
- "Check my X", "Find my X", "Get my X", "Show me my X"
- "Search for", "Look up", "Browse", "Go to"
- Any website interaction

CHAT task (no browser needed):
- General questions, advice, explanations
- Questions about concepts, definitions
- Personal thoughts or help with thinking through something
- NOT asking to access websites or do web actions`
      },
      {
        role: 'user',
        content: userMessage
      }
    ]
  })

  const classification = response.choices[0].message.content?.trim().toLowerCase() || 'chat'
  return classification.includes('browser') ? 'browser' : 'chat'
}

export async function orchestrateTask(
  userMessage: string,
  userId: string,
  taskId: string,
  tabKey: string,
  onProgress: (msg: string) => Promise<void>,
  opts?: { abortSignal?: AbortSignal; preApproved?: boolean }
) {
  // Orchestrator decides: chat or browser?
  const taskType = await classifyTaskType(userMessage)

  if (taskType === 'chat') {
    // Chat only
    const chatResult = await chatAgent(userMessage)
    await onProgress(`Agent: ${chatResult.response}`)

    return {
      success: true,
      chatResponse: chatResult.response,
      browserResult: null,
    }
  }

  // Browser task
  if (taskType === 'browser') {
    // Let user know agent is opening browser
    await onProgress(`Agent: I'll check that for you right now...\n🌐 Opening browser...`)

    const browserResult = await runAgentLoop({
      userId,
      taskId,
      taskPrompt: userMessage,
      tabKey,
      onProgress,
      context: userMessage,
      abortSignal: opts?.abortSignal,
      preApproved: opts?.preApproved,
    })

    return {
      success: browserResult.success,
      chatResponse: 'Checking your request...',
      browserResult: browserResult.summary,
    }
  }

  return {
    success: false,
    chatResponse: 'Unable to process request',
    browserResult: null,
  }
}
