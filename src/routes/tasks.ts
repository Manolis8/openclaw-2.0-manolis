import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { isExtensionConnected, extensionConnections } from '../index.js'
import { runAgentWithExtension } from '../lib/agent-extension.js'
import { createMessage, parseSchedule, scheduleTask, computeNextRun } from '../lib/scheduler.js'

function sanitizeString(input: unknown, maxLength = 100): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/\0/g, '')
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null
}

export const tasksRouter = Router()

const runningTasksPerUser = new Map<string, boolean>()

async function appendOutput(taskId: string, line: string) {
  const { data } = await supabase
    .from('tasks')
    .select('output')
    .eq('id', taskId)
    .single()
  const current = data?.output || ''
  await supabase
    .from('tasks')
    .update({ output: current + line + '\n', status: 'running' })
    .eq('id', taskId)
}

export async function runTaskInBackground(taskId: string, prompt: string, userId: string, useApiMode?: boolean) {
  console.log(`runTaskInBackground: taskId=${taskId} userId=${userId}`)
  console.log(`Extension connected for ${userId}: ${isExtensionConnected(userId)}`)
  console.log(`All connected users: ${[...extensionConnections.keys()].join(', ')}`)

  // Only 1 task at a time per user
  if (runningTasksPerUser.get(userId)) {
    await supabase.from('tasks').update({
      status: 'error',
      output: '⚠️ You already have a task running. Please wait for it to finish before starting a new one.'
    }).eq('id', taskId)
    return
  }
  runningTasksPerUser.set(userId, true)

  const TASK_TIMEOUT_MS = 120_000 // 2 minutes

  // Always use cloud browser (agent-extension.ts) for reliability
  // The agent-extension.ts uses aria-snapshot which is more reliable than CSS selectors
  await appendOutput(taskId, '☁️ Starting browser agent...\n')
  try {
    const taskPromise = runAgentWithExtension(prompt, userId, async (step) => {
      console.log(`[${taskId}] ${step}`)
      await appendOutput(taskId, step + '\n')
    }, taskId)

    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('Task timed out after 2 minutes')), TASK_TIMEOUT_MS)
    )

    const result = await Promise.race([taskPromise, timeoutPromise])
    const { data } = await supabase.from('tasks').select('output').eq('id', taskId).single()
    await supabase.from('tasks').update({
      status: 'done',
      output: (data?.output || '') + `✅ Done: ${result}\n`
    }).eq('id', taskId)

    await createMessage(userId, taskId, `✅ Task complete: ${result.slice(0, 300)}`)
  } catch (err) {
    const { data } = await supabase.from('tasks').select('output').eq('id', taskId).single()
    await supabase.from('tasks').update({
      status: 'error',
      output: (data?.output || '') + `❌ Error: ${String(err)}\n`
    }).eq('id', taskId)

    await createMessage(userId, taskId, `❌ Task failed: ${String(err).slice(0, 200)}`)
  } finally {
    runningTasksPerUser.delete(userId)
  }
}

tasksRouter.post('/create-task', async (req, res) => {
  const { prompt: rawPrompt, userId: rawUserId, useApiMode } = req.body
  const prompt = sanitizeString(rawPrompt, 2000)
  const userId = sanitizeString(rawUserId, 100)
  if (!prompt || !userId) {
    return res.status(400).json({ error: 'Missing or invalid prompt or userId' })
  }
  console.log(`Create task: userId=${userId}, extensionConnected=${isExtensionConnected(userId)}`)
  console.log(`All connected extensions: ${[...extensionConnections.keys()].join(', ')}`)
  const { data, error } = await supabase
    .from('tasks')
    .insert({ user_id: userId, prompt, output: '', status: 'running' })
    .select()
    .single()
  if (error || !data) {
    console.error('Supabase insert error:', error)
    return res.status(500).json({ error: 'Failed to create task' })
  }
  res.json({ taskId: data.id })
  runTaskInBackground(data.id, prompt, userId, useApiMode)
})

tasksRouter.get('/tasks/:userId', async (req, res) => {
  const { data } = await supabase
    .from('tasks')
    .select('id, prompt, status, output, created_at, is_recurring, schedule_human, next_run, last_run')
    .eq('user_id', req.params.userId)
    .order('created_at', { ascending: false })
    .limit(50)
  res.json(data || [])
})

tasksRouter.post('/refresh-token', async (req, res) => {
  const { refreshToken: rawToken } = req.body
  const refreshToken = sanitizeString(rawToken, 2000)
  if (!refreshToken) return res.status(400).json({ error: 'Missing or invalid refresh token' })
  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data.session) throw new Error('Refresh failed')
    res.json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token })
  } catch (err) {
    res.status(401).json({ error: String(err) })
  }
})

tasksRouter.post('/create-scheduled-task', async (req, res) => {
  const { prompt: rawPrompt, userId: rawUserId, scheduleText: rawSchedule } = req.body
  const prompt = sanitizeString(rawPrompt, 2000)
  const userId = sanitizeString(rawUserId, 100)
  const scheduleText = sanitizeString(rawSchedule, 100)
  if (!prompt || !userId || !scheduleText) {
    return res.status(400).json({ error: 'Missing or invalid prompt, userId, or scheduleText' })
  }

  const parsed = await parseSchedule(scheduleText)
  if (!parsed) {
    return res.status(400).json({ error: 'Could not understand that schedule. Try "every day at 9am" or "every monday at 8am".' })
  }

  const nextRun = computeNextRun(userId, parsed.cron)

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      user_id: userId,
      prompt,
      output: '',
      status: 'idle',
      schedule: parsed.cron,
      schedule_human: parsed.human,
      is_recurring: true,
      requires_extension: true,
      next_run: new Date(nextRun).toISOString()
    })
    .select()
    .single()

  if (error || !data) {
    return res.status(500).json({ error: 'Failed to create scheduled task' })
  }

  // Register with in-memory scheduler
  scheduleTask(data.id, userId, prompt, parsed.cron)

  // Send confirmation to inbox
  await createMessage(userId, data.id, `📅 Scheduled: "${prompt}" — ${parsed.human}`)

  res.json({ taskId: data.id, schedule: parsed.human, nextRun: new Date(nextRun).toISOString() })
})

tasksRouter.delete('/scheduled-tasks/:userId', async (req, res) => {
  const { userId } = req.params

  // Get all recurring tasks for this user
  const { data: tasks } = await supabase
    .from('tasks')
    .select('id')
    .eq('user_id', userId)
    .eq('is_recurring', true)

  if (!tasks?.length) {
    return res.json({ cancelled: 0 })
  }

  // Cancel all from in-memory scheduler
  const { cancelTask } = await import('../lib/scheduler.js')
  for (const task of tasks) {
    cancelTask(task.id)
  }

  // Update all to idle in Supabase
  await supabase
    .from('tasks')
    .update({
      is_recurring: false,
      schedule: null,
      schedule_human: null,
      next_run: null,
      status: 'idle'
    })
    .eq('user_id', userId)
    .eq('is_recurring', true)

  res.json({ cancelled: tasks.length })
})

tasksRouter.get('/executions/:userId', async (req, res) => {
  const { data, error } = await supabase
    .from('task_executions')
    .select('id, task_id, task_prompt, plan, status, result_summary, steps_log, started_at, completed_at, duration_ms, created_at')
    .eq('user_id', req.params.userId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})
