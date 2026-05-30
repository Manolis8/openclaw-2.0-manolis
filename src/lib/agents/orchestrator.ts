import OpenAI from 'openai'
import { chatAgent } from './chat-agent.js'
import { runAgentLoop } from '../agent-extension.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

async function classifyTaskType(userMessage: string): Promise<'chat' | 'browser'> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1,
    temperature: 0, // Deterministic
    messages: [
      {
        role: 'system',
        content: `You are a task classifier. Your job is to decide if a user's request needs browser/web access or not.

Output ONLY the number:
1 = Browser task (needs web access, checking websites, accessing accounts, doing web actions)
2 = Chat task (general question, advice, explanation, no web access needed)

Examples:
"What's the weather?" → 2 (chat)
"Check the weather in London" → 1 (browser - needs to access weather website)
"How do I learn Python?" → 2 (chat)
"Book me a flight to Paris" → 1 (browser - needs to access booking sites)
"What are your thoughts on AI?" → 2 (chat)
"Get my latest emails" → 1 (browser - needs Gmail access)
"Help me think through this problem" → 2 (chat)
"Find me a restaurant nearby" → 1 (browser - needs web search)

When in doubt, lean towards browser (1) if there's ANY hint of accessing external data/websites.`
      },
      {
        role: 'user',
        content: userMessage
      }
    ]
  })

  const result = response.choices[0].message.content?.trim() || '2'
  return result === '1' ? 'browser' : 'chat'
}

export async function orchestrateTask(
  userMessage: string,
  userId: string,
  taskId: string,
  tabKey: string,
  onProgress: (msg: string) => Promise<void>,
  opts?: { abortSignal?: AbortSignal; preApproved?: boolean }
) {
  // Orchestrator uses AI to decide
  const taskType = await classifyTaskType(userMessage)

  if (taskType === 'chat') {
    const chatResult = await chatAgent(userMessage)
    await onProgress(`Agent: ${chatResult.response}`)

    return {
      success: true,
      chatResponse: chatResult.response,
      browserResult: null,
    }
  }

  // Browser task
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
