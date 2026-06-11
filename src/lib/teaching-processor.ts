import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface IdentifiedVariable {
  name: string
  value?: string
  type?: string
}

export interface Step {
  step_number: number
  action_type: string
  description: string
  screenshot?: string
  identified_variables?: IdentifiedVariable[]
}

export interface ProcessedStep extends Step {
  action_type: string
  description: string
  is_manual: boolean
  identified_variables: IdentifiedVariable[]
}

// Normalize a step: lowercase action_type, trim description, ensure variables array
export function normalizeStep(step: Step): ProcessedStep {
  return {
    ...step,
    action_type: step.action_type.toLowerCase().trim(),
    description: step.description.trim().slice(0, 1000),
    is_manual: step.action_type.toLowerCase() === 'manual',
    identified_variables: step.identified_variables ?? []
  }
}

// Extract variables from a step description using GPT
// Called for manual steps or steps with empty identified_variables
export async function extractVariablesFromDescription(description: string): Promise<IdentifiedVariable[]> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      messages: [
        {
          role: 'system',
          content: `Extract reusable variables from a browser action description.
Return JSON array only: [{"name": "variableN", "type": "string"}]

Rules:
- Only extract things that would change between uses (filenames, emails, URLs, search terms, passwords, amounts)
- Skip fixed UI actions like "clicked button", "scrolled", "navigated to settings"
- Return [] if nothing is variable
- Max 5 variables`
        },
        { role: 'user', content: description }
      ]
    })

    const raw = response.choices[0].message.content?.trim() ?? '[]'
    const clean = raw.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.warn('[teaching-processor] Variable extraction failed:', err)
    return []
  }
}

// Aggregate and deduplicate variables across all steps
export function aggregateVariables(steps: ProcessedStep[]): IdentifiedVariable[] {
  const seen = new Map<string, IdentifiedVariable>()

  for (const step of steps) {
    for (const v of step.identified_variables) {
      if (v.name && !seen.has(v.name)) {
        seen.set(v.name, v)
      }
    }
  }

  return Array.from(seen.values())
}

// Generate a human-readable skill summary using GPT
export async function generateSummary(
  skillName: string,
  skillDetails: string,
  steps: ProcessedStep[]
): Promise<string> {
  const stepList = steps
    .map(s => {
      const prefix = s.is_manual ? '[Manual]' : ''
      return `${s.step_number}. ${prefix} ${s.description}`.trim()
    })
    .join('\n')

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: 'Summarize what this recorded browser skill does in 2-3 sentences. Be specific and concise. Note which steps are manual.'
        },
        {
          role: 'user',
          content: `Skill: ${skillName}\nDetails: ${skillDetails}\n\nSteps:\n${stepList}`
        }
      ]
    })

    return response.choices[0].message.content?.trim() ?? skillDetails
  } catch (err) {
    console.warn('[teaching-processor] Summary generation failed:', err)
    return skillDetails
  }
}

// Full pipeline: normalize → extract missing variables → aggregate → summarize
export async function processSteps(
  steps: Step[],
  skillName: string,
  skillDetails: string
): Promise<{
  processedSteps: ProcessedStep[]
  variables: IdentifiedVariable[]
  summary: string
}> {
  // 1. Sort by step_number and normalize
  const sorted = [...steps].sort((a, b) => a.step_number - b.step_number)
  const normalized = sorted.map(normalizeStep)

  console.log('[teaching-processor] Processing', normalized.length, 'steps')

  // 2. For steps with no variables, try LLM extraction
  const withVariables = await Promise.all(
    normalized.map(async (step) => {
      if (step.identified_variables.length > 0) {
        return step
      }

      const extracted = await extractVariablesFromDescription(step.description)
      return { ...step, identified_variables: extracted }
    })
  )

  // 3. Aggregate variables + generate summary (parallel)
  const [variables, summary] = await Promise.all([
    Promise.resolve(aggregateVariables(withVariables)),
    generateSummary(skillName, skillDetails, withVariables)
  ])

  console.log('[teaching-processor] Extracted', variables.length, 'variables')
  console.log('[teaching-processor] Generated summary:', summary.slice(0, 100) + '...')

  return { processedSteps: withVariables, variables, summary }
}
