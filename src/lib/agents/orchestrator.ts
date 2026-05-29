import { chatAgent } from './chat-agent.js'
import { runAgentLoop } from '../agent-extension.js'

export async function orchestrateTask(
  userMessage: string,
  userId: string,
  taskId: string,
  tabKey: string,
  onProgress: (msg: string) => Promise<void>,
  opts?: { abortSignal?: AbortSignal; preApproved?: boolean }
) {
  const chatResult = await chatAgent(userMessage)

  await onProgress(`Agent: ${chatResult.response}`)

  if (chatResult.needsBrowser) {
    const browserTask = chatResult.browserTask ?? userMessage

    await onProgress('\n🌐 Now let me check the web for you...')

    const browserResult = await runAgentLoop({
      userId,
      taskId,
      taskPrompt: browserTask,
      tabKey,
      onProgress,
      context: userMessage,
      abortSignal: opts?.abortSignal,
      preApproved: opts?.preApproved,
    })

    return {
      success: browserResult.success,
      chatResponse: chatResult.response,
      browserResult: browserResult.summary,
    }
  }

  return {
    success: true,
    chatResponse: chatResult.response,
    browserResult: null,
  }
}
