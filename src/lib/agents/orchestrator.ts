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
        content: `Classify if this is a chat-only task or requires browser access. Reply with ONLY "chat" or "browser", nothing else.

Browser task: user wants you to check/find/access something on a website, do something on a website, or interact with web services.
Chat task: general question, advice, explanation, or something that doesn't need website access.`
      },
      {
        role: 'user',
        content: userMessage
      }
    ]
  })

  const classification = response.choices[0].message.content?.trim().toLowerCase() || 'chat'
  return classification === 'browser' ? 'browser' : 'chat'
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
