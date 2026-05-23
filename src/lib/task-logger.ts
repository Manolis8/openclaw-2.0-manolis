// task-logger.ts
// Handles all task execution logging

import { supabase } from './supabase.js'

export interface TaskStep {
  stepNumber: number
  toolName: string
  ref?: string
  text?: string
  url?: string
  result: string
  confidence: number
  status: 'success' | 'failed' | 'warning'
}

export interface TaskLog {
  taskId: string
  userId: string
  userPrompt: string
  status: 'started' | 'in_progress' | 'completed' | 'failed'
  plan?: string
  steps: TaskStep[]
  totalTime?: number
  iterationsUsed?: number
  totalSteps?: number
  finalConfidence?: number
  improvements?: string
}

class TaskLogger {
  private log: TaskLog
  private startTime: number

  constructor(taskId: string, userId: string, userPrompt: string) {
    this.log = {
      taskId,
      userId,
      userPrompt,
      status: 'started',
      steps: []
    }
    this.startTime = Date.now()

    console.log(`[LOGGER] Task started: ${taskId}`)
    console.log(`[LOGGER] User prompt: "${userPrompt}"`)
  }

  // Log the plan generated
  setPlan(plan: string) {
    this.log.plan = plan
    console.log(`[LOGGER] Plan set`)
  }

  updateLastStepConfidence(confidence: number) {
    if (this.log.steps.length > 0) {
      this.log.steps[this.log.steps.length - 1].confidence = confidence
    }
  }

  // Log each step during execution
  addStep(step: TaskStep) {
    this.log.steps.push(step)
    console.log(
      `[LOGGER] Step ${step.stepNumber}: ${step.toolName} | ` +
        `Confidence: ${step.confidence}% | Status: ${step.status}`
    )
  }

  // Shorthand for adding browser steps
  addBrowserStep(
    stepNumber: number,
    toolName: string,
    ref: string | undefined,
    result: string,
    confidence: number,
    url?: string,
    text?: string
  ) {
    const step: TaskStep = {
      stepNumber,
      toolName,
      ref,
      text,
      url,
      result,
      confidence,
      status: confidence >= 80 ? 'success' : confidence >= 50 ? 'warning' : 'failed'
    }
    this.addStep(step)
  }

  // Finalize and save log
  async finalize(
    finalStatus: 'completed' | 'failed',
    iterationsUsed: number,
    finalConfidence: number,
    improvements?: string
  ) {
    const endTime = Date.now()
    const totalTimeSeconds = Math.round((endTime - this.startTime) / 1000)

    this.log.status = finalStatus
    this.log.iterationsUsed = iterationsUsed
    this.log.totalSteps = this.log.steps.length
    this.log.finalConfidence = finalConfidence
    this.log.totalTime = totalTimeSeconds
    this.log.improvements = improvements

    console.log(`[LOGGER] Task finalized: ${finalStatus}`)
    console.log(
      `[LOGGER] Time: ${totalTimeSeconds}s | Steps: ${this.log.steps.length} | Confidence: ${finalConfidence}%`
    )

    // Save to Supabase
    try {
      const { error } = await supabase.from('task_logs').insert({
        task_id: this.log.taskId,
        user_id: this.log.userId,
        user_prompt: this.log.userPrompt,
        status: this.log.status,
        plan: this.log.plan,
        steps: this.log.steps,
        total_time: this.log.totalTime,
        iterations_used: this.log.iterationsUsed,
        total_steps: this.log.totalSteps,
        final_confidence: this.log.finalConfidence
      })

      if (error) {
        console.error('[LOGGER] Failed to save log:', error)
      } else {
        console.log('[LOGGER] Log saved to Supabase')
      }
    } catch (err) {
      console.error('[LOGGER] Error saving log:', err)
    }
  }

  // Get formatted log for display
  getFormattedLog(): string {
    const stepsList = this.log.steps
      .map(step => {
        const ref = step.ref
          ? ` { ref: "${step.ref}"${step.text ? `, text: "${step.text}"` : ''}${step.url ? `, url: "${step.url}"` : ''} }`
          : ''
        return (
          `Step ${step.stepNumber}: ${step.toolName}${ref}\n` +
          `  Result: ${step.result}\n` +
          `  Confidence: ${step.confidence}%`
        )
      })
      .join('\n\n')

    return `
═════════════════════════════════════════════════════════════
TASK LOG
═════════════════════════════════════════════════════════════

Task ID: ${this.log.taskId}
Prompt: "${this.log.userPrompt}"
Status: ${this.log.status === 'completed' ? '✅' : '❌'} ${this.log.status.toUpperCase()}
Time: ${this.log.totalTime}s | Steps: ${this.log.totalSteps}/${this.log.iterationsUsed} | Confidence: ${this.log.finalConfidence}%

─────────────────────────────────────────────────────────────
PLAN
─────────────────────────────────────────────────────────────
${this.log.plan || 'No plan'}

─────────────────────────────────────────────────────────────
EXECUTION STEPS
─────────────────────────────────────────────────────────────
${stepsList}

─────────────────────────────────────────────────────────────
IMPROVEMENTS FOR NEXT TIME
─────────────────────────────────────────────────────────────
${this.log.improvements || 'None recorded'}

═════════════════════════════════════════════════════════════
`
  }
}

export function createTaskLogger(taskId: string, userId: string, userPrompt: string) {
  return new TaskLogger(taskId, userId, userPrompt)
}
