import { scoreConfidence } from './confidence-scorer.js'
import { generateClarifyingQuestions } from './question-generator.js'
import { chatAgent } from './chat-agent.js'
import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export type OrchestratorResult =
  | {
      type: 'clarify'
      questions: string[]
      message: string
    }
  | {
      type: 'chat'
      response: string
    }
  | {
      type: 'browser'
      task: string
      context: string
    }

async function classifyTaskType(userMessage: string): Promise<'chat' | 'browser'> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 5,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `Classify if this task needs browser/web access. Reply with ONLY the number:
1 = Browser task (needs web access, checking websites, accessing accounts, doing web actions)
2 = Chat task (general question, advice, explanation, no web access needed)

Examples:
"What's the weather?" → 2
"Check the weather in London" → 1
"How do I code?" → 2
"Book me a flight" → 1
"Get my emails" → 1
"Help me think through this" → 2`
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
  clarificationAnswers?: string[]
): Promise<OrchestratorResult> {

  let fullContext = userMessage
  if (clarificationAnswers && clarificationAnswers.length > 0) {
    fullContext = `${userMessage}\n\n[Clarifications provided:]\n${clarificationAnswers.map((a, i) => `Q${i + 1}: ${a}`).join('\n')}`
  }

  console.log(`[orchestrator] Scoring confidence for: "${userMessage.slice(0, 50)}..."`)
  const confidence = await scoreConfidence(fullContext)
  console.log(`[orchestrator] Confidence: ${confidence.overall}% (intent:${confidence.intent} scope:${confidence.scope} target:${confidence.target} action:${confidence.action})`)

  if (confidence.overall > 80) {
    console.log(`[orchestrator] HIGH confidence (${confidence.overall}%) → executing`)
    const taskType = await classifyTaskType(fullContext)

    if (taskType === 'chat') {
      console.log(`[orchestrator] Classified as CHAT`)
      const chatResponse = await chatAgent(fullContext)
      return {
        type: 'chat',
        response: chatResponse.response
      }
    }

    console.log(`[orchestrator] Classified as BROWSER`)
    return {
      type: 'browser',
      task: userMessage,
      context: fullContext
    }
  }

  console.log(`[orchestrator] MEDIUM/LOW confidence (${confidence.overall}%) → asking questions`)
  const questions = await generateClarifyingQuestions(userMessage, confidence)

  return {
    type: 'clarify',
    questions,
    message: `I need a bit more info to help you better:`
  }
}
