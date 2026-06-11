import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { processSteps } from '../lib/teaching-processor.js'

export const teachingRouter = Router()

function sanitizeString(input: unknown, maxLength = 100): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/\0/g, '')
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null
}

// Override body limit for this route — screenshots can be large
teachingRouter.post(
  '/teaching/save-skill',
  async (req, res) => {
    try {
      const { sessionId: rawSession, skillName: rawName, skillDetails: rawDetails, steps, userId: rawUserId } = req.body

      // Validate and sanitize inputs
      const userId = sanitizeString(rawUserId, 100)
      const skillName = sanitizeString(rawName, 200)
      const skillDetails = sanitizeString(rawDetails, 2000) ?? ''
      const sessionId = sanitizeString(rawSession, 100) ?? undefined

      if (!userId || !skillName) {
        return res.status(400).json({ error: 'Missing required fields: userId, skillName' })
      }

      // Auth check — verify userId exists in api_keys table
      const { data: userExists } = await supabase
        .from('api_keys')
        .select('user_id')
        .eq('user_id', userId)
        .single()

      if (!userExists) {
        return res.status(401).json({ error: 'Unauthorized: invalid userId' })
      }

      // Validate steps array
      if (!Array.isArray(steps) || steps.length === 0) {
        return res.status(400).json({ error: 'steps must be a non-empty array' })
      }

      if (steps.length > 200) {
        return res.status(400).json({ error: 'Too many steps (max 200)' })
      }

      // Validate each step has required shape
      for (const step of steps) {
        if (
          typeof step.step_number !== 'number' ||
          typeof step.action_type !== 'string' ||
          typeof step.description !== 'string'
        ) {
          return res.status(400).json({
            error: 'Each step must have step_number (number), action_type (string), and description (string)'
          })
        }
      }

      console.log('[teaching] Saving skill:', skillName, 'for user:', userId)

      // Process: normalize + variable extraction + summary
      const { processedSteps, variables, summary } = await processSteps(steps, skillName, skillDetails)

      // Save skill record
      const { data: skill, error: skillError } = await supabase
        .from('skills')
        .insert({
          user_id: userId,
          session_id: sessionId,
          skill_name: skillName,
          skill_details: skillDetails,
          summary,
          variables,
          step_count: processedSteps.length
        })
        .select('id')
        .single()

      if (skillError || !skill) {
        console.error('[teaching] Failed to insert skill:', skillError)
        return res.status(500).json({ error: 'Failed to save skill' })
      }

      console.log('[teaching] Skill saved:', skill.id)

      // Save all steps
      const stepRows = processedSteps.map(step => ({
        skill_id: skill.id,
        step_number: step.step_number,
        action_type: step.action_type,
        description: step.description,
        screenshot: step.screenshot ?? null,
        identified_variables: step.identified_variables,
        is_manual: step.is_manual
      }))

      const { error: stepsError } = await supabase.from('skill_steps').insert(stepRows)

      if (stepsError) {
        console.error('[teaching] Failed to insert steps:', stepsError)
        // Roll back the skill record
        await supabase.from('skills').delete().eq('id', skill.id)
        return res.status(500).json({ error: 'Failed to save steps' })
      }

      console.log('[teaching] Steps saved:', processedSteps.length)

      return res.status(201).json({
        skillId: skill.id,
        steps: processedSteps,
        variables,
        summary
      })
    } catch (err) {
      console.error('[teaching] Unexpected error:', err)
      return res.status(500).json({ error: 'Internal error processing skill' })
    }
  }
)

// GET /api/teaching/skills/:userId — list skills for a user
teachingRouter.get('/teaching/skills/:userId', async (req, res) => {
  try {
    const userId = sanitizeString(req.params.userId, 100)

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' })
    }

    // Auth check
    const { data: userExists } = await supabase
      .from('api_keys')
      .select('user_id')
      .eq('user_id', userId)
      .single()

    if (!userExists) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { data, error } = await supabase
      .from('skills')
      .select('id, skill_name, skill_details, summary, variables, step_count, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      console.error('[teaching] Error fetching skills:', error)
      return res.status(500).json({ error: error.message })
    }

    return res.json(data || [])
  } catch (err) {
    console.error('[teaching] Unexpected error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// GET /api/teaching/skills/:skillId/steps — get full steps for a skill
teachingRouter.get('/teaching/skills/:skillId/steps', async (req, res) => {
  try {
    const skillId = req.params.skillId

    if (!skillId || typeof skillId !== 'string') {
      return res.status(400).json({ error: 'Invalid skillId' })
    }

    const { data, error } = await supabase
      .from('skill_steps')
      .select('*')
      .eq('skill_id', skillId)
      .order('step_number', { ascending: true })

    if (error) {
      console.error('[teaching] Error fetching steps:', error)
      return res.status(500).json({ error: error.message })
    }

    return res.json(data || [])
  } catch (err) {
    console.error('[teaching] Unexpected error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})
