import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function chatAgent(userMessage: string): Promise<{
  response: string
  needsBrowser: boolean
  browserTask?: string
}> {
  const response = await client.messages.create({
    model: 'claude-opus-4-20250514',
    max_tokens: 1024,
    system: `You are a helpful AI assistant.

If the user asks you to do something on the web (like check GitHub, search, create repos, etc):
- Respond with: "I can help with that. Let me check [website] for you..."
- On the last line, add: browserTask: <exact step-by-step browser instructions>

If it's just a conversation/question:
- Just answer naturally
- Do not include browserTask:`,
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  })

  const text =
    response.content[0]?.type === 'text' ? response.content[0].text : ''

  const browserTask = extractBrowserTask(text)
  const needsBrowser =
    Boolean(browserTask) ||
    /\blet me\b/i.test(text) ||
    /\bchecking\b/i.test(text) ||
    /\bfinding\b/i.test(text)

  return {
    response: stripBrowserTaskLine(text),
    needsBrowser,
    browserTask,
  }
}

function extractBrowserTask(text: string): string | undefined {
  const browserMatch = text.match(/browserTask:\s*(.+?)(?:\n|$)/i)
  if (browserMatch) return browserMatch[1].trim()

  const match = text.match(/(?:task|do):\s*(.+?)(?:\.|$)/i)
  return match ? match[1].trim() : undefined
}

function stripBrowserTaskLine(text: string): string {
  return text.replace(/\n?browserTask:\s*.+$/i, '').trim()
}
