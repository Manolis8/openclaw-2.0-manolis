import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { isExtensionConnected, extensionConnections } from '../index.js'
import { runAgentWithExtension } from '../lib/agent-extension.js'
import { createMessage, parseSchedule, scheduleTask, computeNextRun } from '../lib/scheduler.js'
import OpenAI from 'openai'
import { createHash } from 'node:crypto'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function sanitizeString(input: unknown, maxLength = 100): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/\0/g, '')
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null
}

type ToolHistoryEntry = {
  toolName: string
  argsHash: string
  resultHash?: string
  timestamp: number
}

const taskToolHistory = new Map<string, ToolHistoryEntry[]>()

function hashValue(value: unknown): string {
  try {
    const str = JSON.stringify(value) || String(value)
    return createHash('sha256').update(str).digest('hex').slice(0, 16)
  } catch {
    return String(value).slice(0, 16)
  }
}

function detectLoop(taskId: string, toolName: string, args: unknown, result?: string): {
  stuck: boolean
  level?: 'warning' | 'critical'
  message?: string
} {
  if (!taskToolHistory.has(taskId)) {
    taskToolHistory.set(taskId, [])
  }
  const history = taskToolHistory.get(taskId)!
  const argsHash = `${toolName}:${hashValue(args)}`
  const resultHash = result ? hashValue(result.slice(0, 500)) : undefined

  history.push({ toolName, argsHash, resultHash, timestamp: Date.now() })

  if (history.length > 30) history.shift()

  const identicalResults = history.filter(h =>
    h.argsHash === argsHash && h.resultHash && h.resultHash === resultHash
  ).length

  if (identicalResults >= 5) {
    return {
      stuck: true,
      level: 'critical',
      message: `CRITICAL: You have called ${toolName} ${identicalResults} times and got the same result each time. Nothing is changing. You MUST now call task_failed with a clear explanation of what you tried.`
    }
  }

  if (identicalResults >= 3) {
    return {
      stuck: true,
      level: 'warning',
      message: `WARNING: ${toolName} returned the same result ${identicalResults} times in a row. The page is not changing. Try a completely different approach or call task_failed.`
    }
  }

  if (history.length >= 6) {
    const last6 = history.slice(-6)
    const tools = last6.map(h => h.toolName)
    const isPingPong = tools.every((t, i) => i === 0 || t === tools[i % 2])
    const allSameResults = last6.every(h => h.resultHash === last6[0]?.resultHash)
    if (isPingPong && allSameResults && new Set(tools).size === 2) {
      return {
        stuck: true,
        level: 'warning',
        message: `WARNING: You are alternating between ${tools[0]} and ${tools[1]} with no progress. This is a stuck loop. Stop and call task_failed.`
      }
    }
  }

  return { stuck: false }
}

function cleanupTaskHistory(taskId: string) {
  taskToolHistory.delete(taskId)
}

export { detectLoop, cleanupTaskHistory }

export const tasksRouter = Router()

type ChatSession = {
  messages: Array<{ role: string; content: string }>
  userId: string
  lastActive: number
}

const chatSessions = new Map<string, ChatSession>()

setInterval(() => {
  const cutoff = Date.now() - 3600000
  for (const [id, session] of chatSessions) {
    if (session.lastActive < cutoff) chatSessions.delete(id)
  }
}, 3600000)

function classifyMessage(message: string): boolean {
  const browserKeywords = [
    'open', 'go to', 'navigate', 'search for', 'find me', 'check',
    'look up', 'browse', 'visit', 'show me', 'get me', 'fetch',
    'click', 'fill', 'submit', 'post', 'buy', 'book',
    'gmail', 'linkedin', 'twitter', 'youtube', 'amazon', 'instagram',
    'website', 'webpage', 'url', 'link', 'browser', 'tab',
    'notification', 'email', 'inbox', 'summarize my', 'check my',
    'find plugins', 'find flights', 'find hotels', 'find prices',
    'what are the', 'what is the price', 'who won', 'latest news',
    'premier league', 'odeon', 'cinema', 'movie times', 'showtimes'
  ]
  const lower = message.toLowerCase()
  return browserKeywords.some(kw => lower.includes(kw))
}

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

export async function runTaskInBackground(taskId: string, prompt: string, userId: string, useApiMode?: boolean, keepTabOpen = false) {
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
    }, taskId, keepTabOpen)

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
    const realErrorMessage = String(err)
    const { data } = await supabase.from('tasks').select('output').eq('id', taskId).single()
    await supabase.from('tasks').update({
      status: 'error',
      output: (data?.output || '') + '❌ Error: Something went wrong. Our team is working on a fix.\n',
      error_details: realErrorMessage
    }).eq('id', taskId)

    await createMessage(userId, taskId, '❌ Task failed. Please try again.')
  } finally {
    runningTasksPerUser.delete(userId)
    cleanupTaskHistory(taskId)
  }
}

tasksRouter.post('/chat', async (req, res) => {
  const { message: rawMessage, userId: rawUserId, sessionId: rawSessionId } = req.body
  const message = sanitizeString(rawMessage, 2000)
  const userId = sanitizeString(rawUserId, 100)
  const sessionId = sanitizeString(rawSessionId, 100)
  if (!message || !userId || !sessionId) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  const today = new Date().toISOString().split('T')[0]
  const { count } = await supabase
    .from('tasks')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', `${today}T00:00:00.000Z`)

  const DAILY_LIMIT = 20

  let session = chatSessions.get(sessionId)
  if (!session) {
    session = { messages: [], userId, lastActive: Date.now() }
    chatSessions.set(sessionId, session)
  }
  session.lastActive = Date.now()

  const needsBrowser = classifyMessage(message)

  if (!needsBrowser) {
    session.messages.push({ role: 'user', content: message })
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are Unclawned, a helpful AI assistant that can also control the user's Chrome browser to do tasks on websites. Be concise, friendly, and helpful. If the user asks you to do something on a website, tell them you will open the browser and do it. If they ask a general question, answer it directly. Keep responses under 150 words.`
        },
        ...session.messages.slice(-10).map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        }))
      ],
      max_tokens: 300
    })
    const reply = response.choices[0].message.content || 'I am not sure how to help with that.'
    session.messages.push({ role: 'assistant', content: reply })
    return res.json({ reply, usesBrowser: false })
  }

  if ((count || 0) >= DAILY_LIMIT) {
    return res.json({
      reply: `You have reached your daily limit of ${DAILY_LIMIT} tasks. Come back tomorrow!`,
      usesBrowser: false
    })
  }

  const { data, error } = await supabase
    .from('tasks')
    .insert({ user_id: userId, prompt: message, output: '', status: 'running' })
    .select().single()

  if (error || !data) return res.status(500).json({ error: 'Failed to create task' })

  res.json({ taskId: data.id, usesBrowser: true })
  runTaskInBackground(data.id, message, userId, false, false)
})

tasksRouter.post('/create-task', async (req, res) => {
  const { prompt: rawPrompt, userId: rawUserId, useApiMode, keepTabOpen } = req.body
  const prompt = sanitizeString(rawPrompt, 2000)
  const userId = sanitizeString(rawUserId, 100)
  if (!prompt || !userId) {
    return res.status(400).json({ error: 'Missing or invalid prompt or userId' })
  }

  // Check daily task limit
  const today = new Date().toISOString().split('T')[0]
  const { count } = await supabase
    .from('tasks')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', `${today}T00:00:00.000Z`)

  const DAILY_LIMIT = 20
  if ((count || 0) >= DAILY_LIMIT) {
    return res.status(429).json({
      error: `Daily limit reached. You can run up to ${DAILY_LIMIT} tasks per day.`
    })
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
  runTaskInBackground(data.id, prompt, userId, useApiMode, keepTabOpen)
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

const ADMIN_USER_ID = '177794f8-f295-4154-a5ff-1db38eed28b1'

tasksRouter.get('/admin/stats', async (req, res) => {
  const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, '')
  if (authHeader !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const [users, tasks, feedback, proWaitlist, proInterest, referrals] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('tasks').select('id', { count: 'exact', head: true }),
    supabase.from('feedback').select('*'),
    supabase.from('pro_waitlist').select('id', { count: 'exact', head: true }),
    supabase.from('pro_interest').select('id', { count: 'exact', head: true }),
    supabase.from('referrals').select('id', { count: 'exact', head: true })
  ])

  res.json({
    totalUsers: users.count || 0,
    totalTasks: tasks.count || 0,
    feedback: feedback.data || [],
    proWaitlistCount: proWaitlist.count || 0,
    proInterestCount: proInterest.count || 0,
    referralCount: referrals.count || 0
  })
})
