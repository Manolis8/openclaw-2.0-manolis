import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function chatAgent(userMessage: string): Promise<{
  response: string
  needsBrowser: boolean
  browserTask?: string
}> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content: `You are a helpful AI assistant.

If the user asks you to do something on the web (like check GitHub, delete repos, search, create repos, etc):
- Say: "I can help with that. Let me check the web for you..."
- Reply with: needsBrowser: true
- Tell me the exact task

If it's just a conversation/question/advice:
- Answer naturally
- needsBrowser: false`
      },
      {
        role: 'user',
        content: userMessage
      }
    ]
  })

  const text = response.choices[0].message.content || ''

  // Simple heuristic: if user is asking agent to DO something on web
  const browserKeywords = ['delete', 'create', 'check', 'find', 'look up', 'search', 'open', 'visit', 'go to']
  const needsBrowser = browserKeywords.some(kw => userMessage.toLowerCase().includes(kw))

  return {
    response: text,
    needsBrowser,
    browserTask: needsBrowser ? userMessage : undefined
  }
}
