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
import { runAgentWithExtension } from '../lib/agent-extension.js'

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
  try {
    const prompt = convertPlanToPrompt(skill, execution.input_values)

    const summary = await runAgentWithExtension(
      prompt,
      execution.user_id,
      async (step) => console.log(`[Skills] ${step}`),
      execution.id,
      false,
      undefined,
      undefined,
      true
    )

    await updateExecution(execution.id, {
      status: 'success',
      final_url: '',
      error_message: '',
      completed_at: new Date().toISOString()
    })
  } catch (error) {
    console.error('[Skills Executor] Fatal error:', error)
    throw error
  }
}

function convertPlanToPrompt(skill: Skill, inputValues: Record<string, string>): string {
  const steps = skill.execution_plan.steps
    .map(s => {
      const desc = s.description.replace(
        /\{\{(\w+)\}\}/g,
        (_: string, key: string) => inputValues[key] || `{{${key}}}`
      )
      return `${s.number}. ${desc}`
    })
    .join('\n')

  return `Execute the following skill: "${skill.skill_name}"

Steps:
${steps}

Complete all steps in order. If you encounter any issues, recover and continue.`
}

export default router
