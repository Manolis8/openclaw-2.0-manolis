import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { processSteps } from '../lib/teaching-processor.js'

export const teachingRouter = Router()

function sanitizeString(input: unknown, maxLength = 100): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/\0/g, '')
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null
}

interface ElementData {
  selector: string
  role: string
  label: string
  coordinates: {
    x: number
    y: number
    width: number
    height: number
    centerX: number
    centerY: number
    isVisible: boolean
  }
  nearbyElements: string[]
  pageContext: {
    url: string
    title: string
    formName?: string
  }
}

interface RawEvent {
  type: 'navigate' | 'click' | 'input' | 'scroll'
  humanDescription: string
  timestamp: number
  url: string
  elementRef?: string
  elementText?: string
  fieldValue?: string
  elementData?: ElementData
  pageContext: {
    url: string
    title: string
  }
}

interface PlaywrightMetadata {
  recordingDuration: number
  totalEvents: number
  eventTypes: {
    navigate: number
    click: number
    input: number
    scroll: number
  }
  elementsUsed: number
  needsPlaywrightVerification: boolean
  playwrightExecutionPriority: 'high' | 'medium' | 'low'
}

interface RawSessionData {
  sessionId: string
  events: RawEvent[]
  elementRegistry: Record<string, any>
  metadata: any
  playwrightMetadata: PlaywrightMetadata
}

teachingRouter.post('/teaching/save-skill', async (req, res) => {
  try {
    const {
      sessionId: rawSession,
      skillName: rawName,
      skillDetails: rawDetails,
      steps,
      userId: rawUserId,
      rawSessionData,
      conversionMetadata
    } = req.body

    const userId = sanitizeString(rawUserId, 100)
    const skillName = sanitizeString(rawName, 200)
    const skillDetails = sanitizeString(rawDetails, 2000) ?? ''
    const sessionId = sanitizeString(rawSession, 100) ?? undefined

    if (!userId || !skillName) {
      return res.status(400).json({ error: 'Missing required fields: userId, skillName' })
    }

    // Auth check
    const { data: userExists } = await supabase
      .from('api_keys')
      .select('user_id')
      .eq('user_id', userId)
      .single()

    if (!userExists) {
      return res.status(401).json({ error: 'Unauthorized: invalid userId' })
    }

    // Duplicate skill name check
    const { data: existingSkill } = await supabase
      .from('skills')
      .select('id')
      .eq('user_id', userId)
      .eq('skill_name', skillName)
      .single()

    if (existingSkill) {
      return res.status(409).json({ error: 'Skill with this name already exists' })
    }

    // Validate steps array
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'steps must be a non-empty array' })
    }

    if (steps.length > 200) {
      return res.status(400).json({ error: 'Too many steps (max 200)' })
    }

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
        step_count: processedSteps.length,

        raw_session_data: rawSessionData ? JSON.stringify(rawSessionData) : null,
        element_registry: rawSessionData ? JSON.stringify(rawSessionData.elementRegistry) : null,
        playwright_metadata: rawSessionData ? JSON.stringify(rawSessionData.playwrightMetadata) : null,
        conversion_metadata: conversionMetadata ? JSON.stringify(conversionMetadata) : null,

        verified_by_playwright: false,
        needs_semantic_analysis: !!rawSessionData
      })
      .select('id')
      .single()

    if (skillError || !skill) {
      console.error('[teaching] Failed to insert skill:', skillError)
      return res.status(500).json({ error: 'Failed to save skill' })
    }

    console.log('[teaching] Skill saved:', skill.id)

    // Save all steps
    const stepRows = processedSteps.map((step, index) => ({
      skill_id: skill.id,
      step_number: step.step_number,
      action_type: step.action_type,
      description: step.description,
      screenshot: step.screenshot ?? null,
      identified_variables: step.identified_variables,
      is_manual: step.is_manual,

      raw_event_data: rawSessionData?.events[index]
        ? JSON.stringify(rawSessionData.events[index])
        : null,
      element_ref: rawSessionData?.events[index]?.elementRef ?? null,
      element_selector: rawSessionData?.events[index]?.elementData?.selector ?? null
    }))

    const { error: stepsError } = await supabase.from('skill_steps').insert(stepRows)

    if (stepsError) {
      console.error('[teaching] Failed to insert steps:', stepsError)
      await supabase.from('skills').delete().eq('id', skill.id)
      return res.status(500).json({ error: 'Failed to save steps' })
    }

    console.log('[teaching] Steps saved:', processedSteps.length, {
      hasRawData: !!rawSessionData,
      rawEventCount: rawSessionData?.events.length ?? 0,
      readyForPlaywright: !!rawSessionData?.playwrightMetadata?.needsPlaywrightVerification,
      readyForSemanticAnalysis: !!rawSessionData
    })

    return res.status(201).json({
      skillId: skill.id,
      skillName,
      steps: processedSteps,
      variables,
      summary,
      rawDataProcessed: !!rawSessionData,
      playwrightVerificationPending: !!rawSessionData?.playwrightMetadata?.needsPlaywrightVerification,
      semanticAnalysisPending: !!rawSessionData
    })
  } catch (err) {
    console.error('[teaching] Unexpected error:', err)
    return res.status(500).json({ error: 'Internal error processing skill' })
  }
})

// GET /api/teaching/skills/:userId — list skills for a user
teachingRouter.get('/teaching/skills/:userId', async (req, res) => {
  try {
    const userId = sanitizeString(req.params.userId, 100)

    if (!userId) {
      return res.status(400).json({ error: 'Invalid userId' })
    }

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
