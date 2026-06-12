import OpenAI from 'openai'
import { ExecutionPlan, ClarifyingQuestion, InputVariable } from './types.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function extractVariables(plan: ExecutionPlan): InputVariable[] {
  return (plan.variables || []).map((varName, idx) => ({
    id: `var-${idx}`,
    skill_id: '',
    variable_name: varName,
    variable_type: 'text' as const,
    description: `Enter value for ${varName}`,
    is_required: true,
    created_at: new Date().toISOString()
  }))
}

export const skillsApi = {
  async generateQuestions(description: string): Promise<ClarifyingQuestion[]> {
    try {
      console.log('[GPT] Generating clarifying questions for:', description.substring(0, 50))

      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        temperature: 0.7,
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content: `You are an expert at understanding web automation tasks.

Given a user's skill description, generate 3-5 clarifying questions to help you understand their needs better.

Questions should be:
- Specific and actionable
- Yes/no OR multiple choice (2-4 options)
- About important details that affect the execution plan

Return ONLY valid JSON (no markdown, no preamble):
[
  {
    "question": "Should the repository be public or private?",
    "type": "multiple_choice",
    "options": ["public", "private", "ask each time"]
  },
  {
    "question": "Should I initialize with a README?",
    "type": "yes_no",
    "options": ["Yes", "No", "Ask each time"]
  }
]`
          },
          { role: 'user', content: description }
        ]
      })

      const content = response.choices[0].message.content || '[]'

      try {
        return JSON.parse(content)
      } catch {
        const jsonMatch = content.match(/\[[\s\S]*\]/)
        if (jsonMatch) return JSON.parse(jsonMatch[0])
        console.warn('[GPT] Could not parse questions, returning empty array')
        return []
      }
    } catch (error) {
      console.error('[GPT] Error generating questions:', error)
      throw error
    }
  },

  async generatePlan(
    description: string,
    answers: Record<string, string>
  ): Promise<{
    plan: ExecutionPlan
    questions: ClarifyingQuestion[]
    inputs: InputVariable[]
  }> {
    try {
      console.log('[GPT] Generating plan for:', description.substring(0, 50))

      if (Object.keys(answers).length === 0) {
        const questions = await this.generateQuestions(description)
        return {
          plan: {
            steps: [],
            variables: [],
            estimatedTime: '',
            errorHandling: { maxRetries: 3, pauseOnError: false, userInterventionSteps: [] }
          },
          questions,
          inputs: []
        }
      }

      const answerContext = Object.entries(answers)
        .map(([q, a]) => `Q: ${q}\nA: ${a}`)
        .join('\n\n')

      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        temperature: 0.7,
        max_tokens: 2000,
        messages: [
          {
            role: 'system',
            content: `You are an expert web automation engineer. Your job is to create detailed execution plans for browser automation tasks.

Given a user's skill description and their answers to clarifying questions, generate a complete execution plan.

The plan MUST be valid JSON with this exact structure:
{
  "steps": [
    {
      "number": 1,
      "title": "Navigate to GitHub",
      "action": "navigate",
      "url": "https://github.com/new",
      "expected": "Page title contains 'Create a new repository'",
      "timeout": 5,
      "onError": "retry",
      "description": "Navigate to the GitHub new repository page"
    },
    {
      "number": 2,
      "title": "Enter Repository Name",
      "action": "type",
      "selectors": ["[name='repository[name]']", "[id='repo-name']", "input:first-of-type"],
      "fallbackSelectors": ["[aria-label*='Name']", "input[placeholder*='name']"],
      "value": "{{ repo_name }}",
      "timeout": 3,
      "onError": "pause",
      "description": "Type the repository name into the name field"
    },
    {
      "number": 3,
      "title": "Click Create Button",
      "action": "click",
      "selectors": ["button[type='submit']", "button:contains('Create')"],
      "timeout": 2,
      "onError": "retry",
      "description": "Click the Create Repository button"
    }
  ],
  "variables": ["repo_name"],
  "estimatedTime": "10-20 seconds",
  "errorHandling": {
    "maxRetries": 3,
    "pauseOnError": false,
    "userInterventionSteps": [2]
  }
}

IMPORTANT:
- action: must be 'navigate', 'click', 'type', 'verify', or 'wait'
- selectors: CSS selectors that find the element (try multiple for robustness)
- fallbackSelectors: alternative selectors if primary ones fail
- value: for type actions, can include {{ variableName }} placeholders
- timeout: in seconds
- onError: 'retry' (auto-retry), 'pause' (ask user), or 'abort' (stop skill)
- variables: list of {{ variable }} names used in the plan
- estimatedTime: reasonable estimate based on steps and delays
- userInterventionSteps: which step numbers need manual help

Be specific with selectors. Include multiple options. Test on real websites if you know them.
Include verification steps (expected outcomes) to catch failures early.`
          },
          {
            role: 'user',
            content: `Skill Description:\n${description}\n\nUser Preferences:\n${answerContext}\n\nGenerate the complete execution plan as JSON.`
          }
        ]
      })

      const content = response.choices[0].message.content || '{}'

      let plan: ExecutionPlan
      try {
        plan = JSON.parse(content)
      } catch {
        const mdMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (mdMatch) {
          plan = JSON.parse(mdMatch[1])
        } else {
          const objMatch = content.match(/\{[\s\S]*\}/)
          if (objMatch) {
            plan = JSON.parse(objMatch[0])
          } else {
            throw new Error('Could not parse GPT response as JSON')
          }
        }
      }

      if (!plan.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        throw new Error('Plan has no steps')
      }

      plan.variables = plan.variables || []
      plan.estimatedTime = plan.estimatedTime || '30 seconds'
      plan.errorHandling = plan.errorHandling || {
        maxRetries: 3,
        pauseOnError: false,
        userInterventionSteps: []
      }

      const inputs = extractVariables(plan)

      console.log(`[GPT] Generated plan with ${plan.steps.length} steps`)

      return { plan, questions: [], inputs }
    } catch (error) {
      console.error('[GPT] Error generating plan:', error)
      throw error
    }
  },

  validatePlan(plan: ExecutionPlan): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (!plan.steps || plan.steps.length === 0) {
      errors.push('Plan has no steps')
    }

    plan.steps.forEach((step, idx) => {
      if (!step.number || step.number !== idx + 1) {
        errors.push(`Step ${idx} has invalid number`)
      }

      if (!['navigate', 'click', 'type', 'verify', 'wait'].includes(step.action)) {
        errors.push(`Step ${step.number} has invalid action: ${step.action}`)
      }

      if (step.action === 'navigate' && !step.url) {
        errors.push(`Step ${step.number} (navigate) missing URL`)
      }

      if ((step.action === 'click' || step.action === 'type') && !step.selectors?.length) {
        errors.push(`Step ${step.number} (${step.action}) missing selectors`)
      }

      if (step.action === 'type' && !step.value) {
        errors.push(`Step ${step.number} (type) missing value`)
      }

      if (!step.timeout || step.timeout <= 0) {
        errors.push(`Step ${step.number} has invalid timeout`)
      }

      if (!['retry', 'pause', 'abort'].includes(step.onError)) {
        errors.push(`Step ${step.number} has invalid onError: ${step.onError}`)
      }
    })

    return { valid: errors.length === 0, errors }
  }
}
