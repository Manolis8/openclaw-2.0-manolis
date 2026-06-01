import OpenAI from 'openai'
import type { ConfidenceScore } from './confidence-scorer.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function generateClarifyingQuestions(
  userMessage: string,
  confidence: ConfidenceScore
): Promise<string[]> {
  try {
    let questionCount = 1
    if (confidence.overall < 70) questionCount = 2
    if (confidence.overall < 60) questionCount = Math.min(3, confidence.gaps.length)

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 350,
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content: `Generate EXACTLY ${questionCount} short clarifying questions to better understand this task.

Return ONLY a valid JSON array (no markdown, no backticks):
["Question 1?", "Question 2?", "Question 3?"]

Requirements:
- Each question is SHORT (under 15 words)
- Questions are specific, not vague
- Questions address the gaps
- Make them easy to answer (yes/no, or short phrase)
- Don't repeat information already provided
- Ask about: intent, scope, target, action, or context

Gaps to address:
${confidence.gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}

User's original message: "${userMessage}"

Generate only the JSON array, nothing else.`
        }
      ]
    })

    const text = response.choices[0].message.content?.trim() || '[]'
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    return Array.isArray(parsed) ? parsed.slice(0, questionCount) : []
  } catch (err) {
    console.error('[question-generator] Error:', err)
    return [
      'Can you give me more specific details?',
      'Which platform or service are you referring to?'
    ]
  }
}
