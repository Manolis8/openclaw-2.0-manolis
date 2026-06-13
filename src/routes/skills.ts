import { Router, Request, Response } from 'express'
import { authenticateUser } from '../middleware/auth.js'
import { skillsApi } from '../lib/skills-api.js'
import {
  saveSkill,
  getSkill,
  listSkills,
  createExecution,
  getExecution,
  updateExecution,
  saveInputVariable
} from '../db/queries.js'
import { Skill, SkillExecution } from '../lib/types.js'
import { runAgentLoop } from '../lib/agent-extension.js'
import { sendExtensionMessage, isExtensionConnected } from '../index.js'

const router = Router()

// All routes require authentication
router.use(authenticateUser)

// ============================================
// POST /api/skills/create-plan
// Generate execution plan from skill description
// ============================================
router.post('/create-plan', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    const { skillDescription, answers } = req.body

    if (!skillDescription || skillDescription.trim().length < 20) {
      return res.status(400).json({ error: 'Skill description required (min 20 characters)' })
    }

    if (skillDescription.trim().length > 1000) {
      return res.status(400).json({ error: 'Skill description too long (max 1000 characters)' })
    }

    console.log(`[Skills API] Generating plan for: ${skillDescription.substring(0, 50)}...`)

    const { plan, questions, inputs } = await skillsApi.generatePlan(
      skillDescription,
      answers || {}
    )

    res.json({
      success: true,
      plan,
      questions: questions && questions.length > 0 ? questions : [],
      inputs
    })
  } catch (error) {
    console.error('[Skills API] Error generating plan:', error)
    res.status(500).json({
      error: 'Failed to generate plan',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// ============================================
// POST /api/skills/save
// Save a skill to database
// ============================================
router.post('/save', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    const { skillName, skillDescription, plan, inputs } = req.body

    if (!skillName || skillName.trim().length === 0) {
      return res.status(400).json({ error: 'Skill name is required' })
    }

    if (!skillDescription || skillDescription.trim().length === 0) {
      return res.status(400).json({ error: 'Skill description is required' })
    }

    if (!plan || !plan.steps || plan.steps.length === 0) {
      return res.status(400).json({ error: 'Valid execution plan is required' })
    }

    // Duplicate name check
    const existingSkills = await listSkills(userId)
    if (existingSkills.some((s: any) => s.skill_name.toLowerCase() === skillName.toLowerCase())) {
      return res.status(409).json({ error: 'A skill with this name already exists' })
    }

    console.log(`[Skills API] Saving skill: ${skillName}`)

    const skill = await saveSkill(userId, {
      skill_name: skillName,
      skill_description: skillDescription,
      execution_plan: plan,
      status: 'active'
    })

    if (inputs && inputs.length > 0) {
      for (const input of inputs) {
        await saveInputVariable(skill.id, input)
      }
    }

    res.json({
      success: true,
      skillId: skill.id,
      message: 'Skill saved successfully'
    })
  } catch (error) {
    console.error('[Skills API] Error saving skill:', error)
    res.status(500).json({
      error: 'Failed to save skill',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// ============================================
// GET /api/skills
// List all user's skills
// ============================================
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    console.log(`[Skills API] Listing skills for user: ${userId}`)

    const skills = await listSkills(userId)
    res.json(skills)
  } catch (error) {
    console.error('[Skills API] Error listing skills:', error)
    res.status(500).json({
      error: 'Failed to list skills',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// ============================================
// GET /api/skills/:skillId
// Get skill details
// ============================================
router.get('/:skillId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    const { skillId } = req.params

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    if (!skillId) {
      return res.status(400).json({ error: 'Skill ID required' })
    }

    console.log(`[Skills API] Getting skill: ${skillId}`)

    const skill = await getSkill(skillId)

    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' })
    }

    if (skill.user_id !== userId && !skill.is_public) {
      return res.status(403).json({ error: 'Access denied' })
    }

    res.json(skill)
  } catch (error) {
    console.error('[Skills API] Error getting skill:', error)
    res.status(500).json({
      error: 'Failed to get skill',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// ============================================
// POST /api/skills/:skillId/execute
// Start skill execution
// ============================================
router.post('/:skillId/execute', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    const { skillId } = req.params
    const { inputValues } = req.body

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    if (!skillId) {
      return res.status(400).json({ error: 'Skill ID required' })
    }

    if (!inputValues || typeof inputValues !== 'object') {
      return res.status(400).json({ error: 'Input values object required' })
    }

    console.log(`[Skills API] Starting execution for skill: ${skillId}`)

    const skill = await getSkill(skillId)
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' })
    }

    if (skill.user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const execution = await createExecution(skillId, userId, inputValues)

    executeSkillAsync(execution, skill).catch(err => {
      console.error('[Skills Executor] Execution error:', err)
      updateExecution(execution.id, {
        status: 'error',
        error_message: err.message,
        completed_at: new Date().toISOString()
      }).catch(e => console.error('Failed to update execution:', e))
    })

    res.json({
      success: true,
      executionId: execution.id,
      status: 'running',
      message: 'Skill execution started'
    })
  } catch (error) {
    console.error('[Skills API] Error starting execution:', error)
    res.status(500).json({
      error: 'Failed to start execution',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// ============================================
// GET /api/skills/:skillId/executions/:executionId
// Get execution status (polling endpoint)
// ============================================
router.get('/:skillId/executions/:executionId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    const { executionId } = req.params

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    if (!executionId) {
      return res.status(400).json({ error: 'Execution ID required' })
    }

    console.log(`[Skills API] Polling execution: ${executionId}`)

    const execution = await getExecution(executionId)

    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' })
    }

    if (execution.user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' })
    }

    res.json(execution)
  } catch (error) {
    console.error('[Skills API] Error polling execution:', error)
    res.status(500).json({
      error: 'Failed to get execution status',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// ============================================
// Helper: Execute skill in background
// ============================================
async function executeSkillAsync(
  execution: SkillExecution,
  skill: Skill
): Promise<void> {
  const startTime = Date.now()
  let tabId: number | null = null

  try {
    if (!isExtensionConnected(execution.user_id)) {
      throw new Error('Extension not connected. Open Unclawned in Chrome first.')
    }

    const prompt = convertPlanToPrompt(skill, execution.input_values)
    console.log(`[Skills] Converting plan to prompt:\n${prompt}`)

    // Create tab (mirrors runWithExtensionTab — runAgentLoop needs a page to exist)
    const tabResult = await sendExtensionMessage(execution.user_id, 'createAndAttachTab', { url: 'about:blank' }, 60000) as any
    tabId = tabResult?.tabId ?? null
    if (!tabId) throw new Error('Extension did not return a tab ID.')
    await new Promise(r => setTimeout(r, 2000))

    const result = await runAgentLoop({
      userId: execution.user_id,
      taskId: execution.id,
      taskPrompt: prompt,
      tabKey: `skill-${execution.id}`,
      onProgress: async (msg) => console.log(`[Skills Agent] ${msg}`),
      preApproved: true,
    })

    await updateExecution(execution.id, {
      status: result.success ? 'success' : 'error',
      execution_log: [{
        stepNumber: 1,
        action: 'agent_loop',
        status: result.success ? 'success' : 'error',
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      }],
      final_url: '',
      error_message: result.success ? '' : result.summary,
      completed_at: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
    })

    console.log(`[Skills] Execution ${execution.id}: ${result.success ? 'SUCCESS' : 'FAILED'}`)
    console.log(`[Skills] Summary: ${result.summary}`)

  } catch (error) {
    console.error('[Skills] Execution failed:', error)
    await updateExecution(execution.id, {
      status: 'error',
      error_message: error instanceof Error ? error.message : 'Unknown error',
      completed_at: new Date().toISOString(),
    }).catch(e => console.error('Failed to update execution:', e))
    throw error

  } finally {
    if (tabId) {
      await sendExtensionMessage(execution.user_id, 'detachTab', { tabId }).catch(() => {})
    }
  }
}

function convertPlanToPrompt(skill: Skill, inputValues: Record<string, string>): string {
  const steps = skill.execution_plan.steps
    .map((s, idx) => {
      let desc = s.description
      let valueInfo = ''

      for (const [key, value] of Object.entries(inputValues)) {
        const placeholder = `{{ ${key} }}`
        if (desc.includes(placeholder)) {
          desc = desc.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value)
          valueInfo += ` Use "${value}".`
        }
        if (s.value?.includes?.(placeholder)) {
          valueInfo += ` Enter "${value}".`
        }
      }

      return `${idx + 1}. ${desc}${valueInfo}`
    })
    .join('\n')

  const varSummary = Object.entries(inputValues)
    .map(([k, v]) => `- ${k}: "${v}"`)
    .join('\n')

  return `Execute the following skill: "${skill.skill_name}"

Description: ${skill.skill_description}

INPUT VALUES TO USE:
${varSummary}

Steps to complete:
${steps}

IMPORTANT: Use the exact input values provided above. Do not make up or improvise values.
Complete all steps in order. Use the browser agent tools to navigate, click, type, and interact with the page. If you encounter any issues, use your error recovery to find alternative approaches. Complete the task fully before calling task_complete.`
}

export default router
