// mid-action-planner.ts
// When agent gets confused mid-task, generate a new plan

import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface MidActionPlanInput {
  taskPrompt: string
  lookingFor: string
  alreadyTried: string[]
  currentPage: string
  whyStuck: string
}

export interface MidActionPlanResult {
  confused: boolean
  recommendation: 'TRY_DIFFERENT_APPROACH' | 'NAVIGATE_NEW_PAGE' | 'IMPOSSIBLE'
  suggestion: string
  explanation: string
  nextAction?: string
}

export async function getMidActionPlan(
  input: MidActionPlanInput
): Promise<MidActionPlanResult> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 250,
      messages: [
        {
          role: 'system',
          content: `You are a task recovery assistant. The agent is stuck and asking for help.

          Analyze the situation and respond with EXACTLY ONE recommendation.
          
          CRITICAL RULES:
          1. ONLY suggest pages/approaches that are directly related to the task
          2. DO NOT suggest API documentation, external sites, or unrelated pages
          3. DO NOT suggest going to Settings, Delete, or configuration pages unless the task explicitly asks for it
          4. If the information truly cannot be found on the relevant pages, say IMPOSSIBLE
          5. Focus on the most likely place the information exists based on the task
          
          Format your response EXACTLY like this:
          
          ### RECOMMENDATION
          TRY_DIFFERENT_APPROACH: [What to try differently on current page/site]
          OR
          NAVIGATE_NEW_PAGE: [Which specific page to go to - must be directly related to the task]
          OR
          IMPOSSIBLE: [Why this task can't be completed]
          
          ### EXPLANATION
          Brief 1-2 sentence explanation of why this is the right path.
          
          ### NEXT_ACTION
          Specific action to take next (or "N/A" if impossible).
          
          IMPORTANT:
          - Pick ONLY ONE recommendation type
          - Be specific about which page or what approach
          - Never suggest documentation, APIs, or external resources
          - Never suggest Settings or admin pages unless explicitly asked
          - If the information truly doesn't exist, say IMPOSSIBLE
          - If you say IMPOSSIBLE, the agent MUST call task_failed
          - Stay focused on completing the user's actual task, nothing more`},
        {
          role: 'user',
          content: `
          TASK: "${input.taskPrompt}"
          
          Agent is trying to find: ${input.lookingFor}
          
          Already attempted:
          ${input.alreadyTried.length > 0 ? input.alreadyTried.map((t) => `- ${t}`).join('\n') : '- Nothing yet'}
          
          Current page: ${input.currentPage}
          
          Why stuck: ${input.whyStuck}
          
          What should the agent do next?`
        }
      ]
    })

    const responseText = response.choices[0].message.content || ''
    
    console.log(`[tokens] model=${response.model} prompt=${response.usage?.prompt_tokens} completion=${response.usage?.completion_tokens} total=${response.usage?.total_tokens}`)
    console.log(`[MID_ACTION_PLAN]\n${responseText}`)

    // Parse response
    const isTryDifferent = responseText.includes('TRY_DIFFERENT_APPROACH')
    const isNavigate = responseText.includes('NAVIGATE_NEW_PAGE')
    const isImpossible = responseText.includes('IMPOSSIBLE')

    let recommendation: MidActionPlanResult['recommendation'] = 'IMPOSSIBLE'
    if (isTryDifferent) recommendation = 'TRY_DIFFERENT_APPROACH'
    if (isNavigate) recommendation = 'NAVIGATE_NEW_PAGE'

    // Extract suggestion (text after RECOMMENDATION line)
    const suggestionMatch = responseText.match(/RECOMMENDATION\n[^:]*:\s*(.+?)(?=###|$)/s)
    const suggestion = suggestionMatch?.[1]?.trim() || responseText

    // Extract explanation
    const explanationMatch = responseText.match(/EXPLANATION\n(.+?)(?=###|$)/s)
    const explanation = explanationMatch?.[1]?.trim() || ''

    // Extract next action
    const nextActionMatch = responseText.match(/NEXT_ACTION\n(.+?)(?=###|$)/s)
    const nextAction = nextActionMatch?.[1]?.trim()

    return {
      confused: true,
      recommendation,
      suggestion,
      explanation,
      nextAction
    }
  } catch (err) {
    console.error('getMidActionPlan error:', err)
    return {
      confused: true,
      recommendation: 'IMPOSSIBLE',
      suggestion: 'Unable to generate plan',
      explanation: 'System error occurred'
    }
  }
}