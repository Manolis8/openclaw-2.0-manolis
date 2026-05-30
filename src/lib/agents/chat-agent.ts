import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function chatAgent(userMessage: string): Promise<{
  response: string
}> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content: 'You are a helpful AI assistant. Answer naturally and conversationally.'
      },
      {
        role: 'user',
        content: userMessage
      }
    ]
  })

  return {
    response: response.choices[0].message.content || ''
  }
}
