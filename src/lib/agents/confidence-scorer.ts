import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface ConfidenceScore {
  overall: number
  intent: number
  scope: number
  target: number
  action: number
  gaps: string[]
  reason: string
}

export async function scoreConfidence(userMessage: string): Promise<ConfidenceScore> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 250,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `You are a task clarity analyzer. Analyze this request and return ONLY valid JSON (no markdown, no backticks):
{
  "intent": <0-100>,
  "scope": <0-100>,
  "target": <0-100>,
  "action": <0-100>,
  "gaps": [<list of unclear parts>],
  "reason": "<one sentence why this score>"
}

Score based on:
- intent (0-100): Do we understand what they want to accomplish?
- scope (0-100): Do we know the boundaries? (one item, all items, specific range?)
- target (0-100): Do we know WHERE or WHICH SERVICE? (GitHub, Gmail, etc)
- action (0-100): Do we know WHAT TO DO? (get, check, create, delete, etc)

Examples:
"get my repos" → intent:90, scope:70 (all? oldest?), target:95, action:85
"help with my stuff" → intent:20, scope:10, target:30, action:40
"oldest GitHub repo" → intent:95, scope:95, target:95, action:85`
        },
        {
          role: 'user',
          content: userMessage
        }
      ]
    })

    const text = response.choices[0].message.content?.trim() || '{}'
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    const overall = (parsed.intent + parsed.scope + parsed.target + parsed.action) / 4

    return {
      overall: Math.round(overall),
      intent: parsed.intent || 0,
      scope: parsed.scope || 0,
      target: parsed.target || 0,
      action: parsed.action || 0,
      gaps: parsed.gaps || [],
      reason: parsed.reason || 'Unknown'
    }
  } catch (err) {
    console.error('[confidence-scorer] Error:', err)
    return {
      overall: 70,
      intent: 70,
      scope: 70,
      target: 70,
      action: 70,
      gaps: ['Unable to analyze'],
      reason: 'Error during analysis'
    }
  }
}
