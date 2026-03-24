import { createHash } from 'crypto'
import { Cron } from 'croner'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_REFIRE_GAP_MS = 2000
const MAX_TIMER_DELAY_MS = 60_000
const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000 // 5 minutes
const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000]

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduledTask {
  taskId: string
  userId: string
  prompt: string
  cronExpr: string
  lastRunAt?: number
  consecutiveErrors: number
  nextRunAt: number
}

// ─── In-memory store ──────────────────────────────────────────────────────────

const scheduledTasks = new Map<string, ScheduledTask>()
let timerHandle: NodeJS.Timeout | null = null
let timerRunning = false

// ─── Stagger ──────────────────────────────────────────────────────────────────

function resolveStaggerOffset(taskId: string, windowMs: number): number {
  if (windowMs <= 0) return 0
  const hash = createHash('sha256').update(taskId).digest()
  return hash.readUInt32BE(0) % windowMs
}

function isTopOfHourCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 2) return false
  return parts[0] === '0'
}

// ─── Next run computation ─────────────────────────────────────────────────────

export function computeNextRun(
  taskId: string,
  cronExpr: string,
  lastRunAt?: number
): number {
  const nowMs = Date.now()
  const staggerWindowMs = isTopOfHourCron(cronExpr)
    ? DEFAULT_TOP_OF_HOUR_STAGGER_MS
    : 0
  const stagger = resolveStaggerOffset(taskId, staggerWindowMs)

  try {
    const c = new Cron(cronExpr)
    let next = c.nextRun(new Date(nowMs))

    // Croner timezone bug workaround — retry from next second
    if (!next || next.getTime() <= nowMs) {
      next = c.nextRun(new Date(nowMs + 1000))
    }
    // Still stuck — retry from start of tomorrow
    if (!next || next.getTime() <= nowMs) {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(0, 0, 1, 0)
      next = c.nextRun(tomorrow)
    }

    if (!next) throw new Error(`Cannot compute next run for: ${cronExpr}`)
    return next.getTime() + stagger
  } catch (err) {
    console.error(`computeNextRun error for ${cronExpr}:`, err)
    // Fallback: 1 hour from now
    return nowMs + 3_600_000
  }
}

function computeNextRunWithBackoff(
  taskId: string,
  cronExpr: string,
  consecutiveErrors: number,
  endedAtMs: number
): number {
  const natural = computeNextRun(taskId, cronExpr, endedAtMs)
  if (consecutiveErrors === 0) return natural
  const backoff = BACKOFF_MS[Math.min(consecutiveErrors - 1, BACKOFF_MS.length - 1)]
  return Math.max(natural, endedAtMs + backoff)
}

// ─── Natural language parsing ─────────────────────────────────────────────────

export async function parseSchedule(input: string): Promise<{
  cron: string
  human: string
} | null> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Convert natural language schedule descriptions to cron expressions.
Return ONLY a valid JSON object with exactly two fields:
- cron: standard 5-field cron expression (minute hour day month weekday)
- human: clean human-readable description

Examples:
"every morning at 9am" -> {"cron":"0 9 * * *","human":"Every day at 9:00 AM"}
"every monday at 8am" -> {"cron":"0 8 * * 1","human":"Every Monday at 8:00 AM"}
"every hour" -> {"cron":"0 * * * *","human":"Every hour"}
"every day at 6pm" -> {"cron":"0 18 * * *","human":"Every day at 6:00 PM"}
"every 30 minutes" -> {"cron":"*/30 * * * *","human":"Every 30 minutes"}
"every weekday at 9am" -> {"cron":"0 9 * * 1-5","human":"Every weekday at 9:00 AM"}
"every sunday at noon" -> {"cron":"0 12 * * 0","human":"Every Sunday at 12:00 PM"}

Return null if input is not a valid schedule description.
Return ONLY the JSON object, no markdown, no explanation.`
        },
        { role: 'user', content: input }
      ],
      max_tokens: 100
    })

    const text = response.choices[0].message.content?.trim() || ''
    if (text === 'null' || !text) return null
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)
    if (!parsed.cron || !parsed.human) return null
    return parsed
  } catch (err) {
    console.error('parseSchedule error:', err)
    return null
  }
}

// ─── Inbox messages ───────────────────────────────────────────────────────────

export async function createMessage(
  userId: string,
  taskId: string,
  content: string
): Promise<void> {
  try {
    await supabase.from('messages').insert({
      user_id: userId,
      task_id: taskId,
      content,
      read: false
    })
  } catch (err) {
    console.error('createMessage error:', err)
  }
}

// ─── Timer loop ───────────────────────────────────────────────────────────────

// Import this from routes/tasks.ts when wiring up
let _runTaskFn: ((taskId: string, prompt: string, userId: string) => Promise<void>) | null = null

export function setRunTaskFn(
  fn: (taskId: string, prompt: string, userId: string) => Promise<void>
) {
  _runTaskFn = fn
}

export function armTimer(): void {
  if (timerHandle) {
    clearTimeout(timerHandle)
    timerHandle = null
  }

  if (scheduledTasks.size === 0) return

  const nowMs = Date.now()
  let nearestMs = Infinity

  for (const task of scheduledTasks.values()) {
    if (task.nextRunAt < nearestMs) {
      nearestMs = task.nextRunAt
    }
  }

  if (nearestMs === Infinity) return

  let delayMs = Math.max(nearestMs - nowMs, 0)

  // Enforce minimum gap to prevent tight loops
  if (delayMs < MIN_REFIRE_GAP_MS) delayMs = MIN_REFIRE_GAP_MS

  // Clamp to max for drift recovery
  if (delayMs > MAX_TIMER_DELAY_MS) delayMs = MAX_TIMER_DELAY_MS

  console.log(`⏱ Timer armed — next task in ${Math.round(delayMs / 1000)}s`)

  timerHandle = setTimeout(() => onTimer(), delayMs)
}

async function onTimer(): Promise<void> {
  if (timerRunning) {
    armTimer()
    return
  }

  timerRunning = true

  try {
    const nowMs = Date.now()

    // Collect all due tasks
    const dueTasks: ScheduledTask[] = []
    for (const task of scheduledTasks.values()) {
      if (task.nextRunAt <= nowMs) {
        dueTasks.push(task)
      }
    }

    if (dueTasks.length === 0) {
      armTimer()
      return
    }

    console.log(`⏰ ${dueTasks.length} task(s) due`)

    // Run all due tasks
    for (const task of dueTasks) {
      runScheduledTask(task).catch(err => {
        console.error(`Scheduled task ${task.taskId} threw:`, err)
      })
    }
  } finally {
    timerRunning = false
    armTimer()
  }
}

async function runScheduledTask(task: ScheduledTask): Promise<void> {
  const { taskId, userId, prompt, cronExpr } = task

  // Check if extension is connected — import dynamically to avoid circular deps
  const { isExtensionConnected } = await import('../index.js')

  // Write running_at BEFORE executing — distributed lock
  const { error: lockError } = await supabase
    .from('tasks')
    .update({ running_at: new Date().toISOString() })
    .eq('id', taskId)
    .is('running_at', null) // only if not already running

  if (lockError) {
    console.warn(`Could not lock task ${taskId} — may already be running`)
    return
  }

  const extensionConnected = isExtensionConnected(userId)

  if (!extensionConnected) {
    // Queue it — extension not connected
    await supabase
      .from('tasks')
      .update({
        status: 'queued',
        running_at: null,
        last_run: new Date().toISOString()
      })
      .eq('id', taskId)

    await createMessage(
      userId,
      taskId,
      `⏳ Task queued — your browser isn't connected. It will run automatically when you open Chrome.`
    )

    console.log(`Task ${taskId} queued — extension offline`)

    // Compute next run and update
    const nextRunAt = computeNextRunWithBackoff(taskId, cronExpr, task.consecutiveErrors, Date.now())
    const updated = { ...task, nextRunAt }
    scheduledTasks.set(taskId, updated)
    await supabase
      .from('tasks')
      .update({ next_run: new Date(nextRunAt).toISOString() })
      .eq('id', taskId)

    return
  }

  // Extension is connected — run now
  await supabase
    .from('tasks')
    .update({ status: 'running', output: '' })
    .eq('id', taskId)

  const startedAt = Date.now()

  try {
    if (!_runTaskFn) throw new Error('runTaskFn not set')
    await _runTaskFn(taskId, prompt, userId)

    // Success
    const endedAt = Date.now()
    const nextRunAt = computeNextRunWithBackoff(taskId, cronExpr, 0, endedAt)

    await supabase
      .from('tasks')
      .update({
        last_run: new Date(startedAt).toISOString(),
        next_run: new Date(nextRunAt).toISOString(),
        running_at: null,
        consecutive_errors: 0
      })
      .eq('id', taskId)

    const updated = { ...task, lastRunAt: startedAt, consecutiveErrors: 0, nextRunAt }
    scheduledTasks.set(taskId, updated)

    console.log(`✅ Scheduled task ${taskId} done. Next run: ${new Date(nextRunAt).toISOString()}`)

  } catch (err) {
    // Error — apply backoff
    const endedAt = Date.now()
    const newErrors = task.consecutiveErrors + 1
    const nextRunAt = computeNextRunWithBackoff(taskId, cronExpr, newErrors, endedAt)

    await supabase
      .from('tasks')
      .update({
        last_run: new Date(startedAt).toISOString(),
        next_run: new Date(nextRunAt).toISOString(),
        running_at: null,
        consecutive_errors: newErrors,
        status: 'error'
      })
      .eq('id', taskId)

    await createMessage(
      userId,
      taskId,
      `❌ Scheduled task failed (attempt ${newErrors}): ${String(err).slice(0, 200)}`
    )

    const updated = { ...task, consecutiveErrors: newErrors, nextRunAt }
    scheduledTasks.set(taskId, updated)

    console.error(`Scheduled task ${taskId} failed (errors: ${newErrors}). Next retry: ${new Date(nextRunAt).toISOString()}`)
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function scheduleTask(
  taskId: string,
  userId: string,
  prompt: string,
  cronExpr: string,
  lastRunAt?: number,
  consecutiveErrors = 0
): void {
  const nextRunAt = computeNextRun(taskId, cronExpr, lastRunAt)

  scheduledTasks.set(taskId, {
    taskId,
    userId,
    prompt,
    cronExpr,
    lastRunAt,
    consecutiveErrors,
    nextRunAt
  })

  console.log(`📅 Scheduled task ${taskId} — next run: ${new Date(nextRunAt).toISOString()}`)
  armTimer()
}

export function cancelTask(taskId: string): void {
  if (scheduledTasks.has(taskId)) {
    scheduledTasks.delete(taskId)
    console.log(`🗑 Cancelled scheduled task ${taskId}`)
    armTimer()
  }
}

export function getScheduledTask(taskId: string): ScheduledTask | undefined {
  return scheduledTasks.get(taskId)
}

export function getAllScheduledTasks(): ScheduledTask[] {
  return Array.from(scheduledTasks.values())
}

// ─── Startup — load all recurring tasks from Supabase ─────────────────────────

export async function loadScheduledTasks(
  runTaskFn: (taskId: string, prompt: string, userId: string) => Promise<void>
): Promise<void> {
  setRunTaskFn(runTaskFn)

  // Clear stale running_at markers from crashed previous process
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  await supabase
    .from('tasks')
    .update({ running_at: null, status: 'idle' })
    .lt('running_at', twoHoursAgo)
    .not('running_at', 'is', null)

  // Load all recurring tasks
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, user_id, prompt, schedule, last_run, consecutive_errors, status')
    .eq('is_recurring', true)
    .not('schedule', 'is', null)

  if (error) {
    console.error('loadScheduledTasks error:', error)
    return
  }

  if (!tasks?.length) {
    console.log('📅 No recurring tasks to load')
    return
  }

  for (const task of tasks) {
    scheduleTask(
      task.id,
      task.user_id,
      task.prompt,
      task.schedule,
      task.last_run ? new Date(task.last_run).getTime() : undefined,
      task.consecutive_errors || 0
    )
  }

  console.log(`📅 Loaded ${tasks.length} recurring tasks`)
  armTimer()
}
