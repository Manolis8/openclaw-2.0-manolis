import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { newPage } from '../lib/browser.js'
import { runAgent } from '../lib/agent.js'
import { isExtensionConnected, extensionConnections } from '../index.js'
import { runAgentWithExtension } from '../lib/agent-extension.js'

export const tasksRouter = Router()

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

async function runTaskInBackground(taskId: string, prompt: string, userId: string) {
  console.log(`runTaskInBackground: taskId=${taskId} userId=${userId}`)
  console.log(`Extension connected for ${userId}: ${isExtensionConnected(userId)}`)
  console.log(`All connected users: ${[...extensionConnections.keys()].join(', ')}`)
  const usingExtension = isExtensionConnected(userId)

  if (usingExtension) {
    // Use user's real Chrome via extension
    await appendOutput(taskId, '🔌 Using your real browser via extension\n')
    try {
      const result = await runAgentWithExtension(prompt, userId, async (step) => {
        console.log(`[${taskId}] ${step}`)
        await appendOutput(taskId, step + '\n')
      })
      const { data } = await supabase.from('tasks').select('output').eq('id', taskId).single()
      await supabase.from('tasks').update({
        status: 'done',
        output: (data?.output || '') + `✅ Done: ${result}\n`
      }).eq('id', taskId)
    } catch (err) {
      const { data } = await supabase.from('tasks').select('output').eq('id', taskId).single()
      await supabase.from('tasks').update({
        status: 'error',
        output: (data?.output || '') + `❌ Error: ${String(err)}\n`
      }).eq('id', taskId)
    }
  } else {
    // Fall back to cloud Playwright browser
    await appendOutput(taskId, '☁️ Using cloud browser (connect extension for full access)\n')
    const page = await newPage()
    try {
      const result = await runAgent(prompt, page, async (step) => {
        console.log(`[${taskId}] ${step}`)
        await appendOutput(taskId, step + '\n')
      })
      const { data } = await supabase.from('tasks').select('output').eq('id', taskId).single()
      await supabase.from('tasks').update({
        status: 'done',
        output: (data?.output || '') + `✅ Done: ${result}\n`
      }).eq('id', taskId)
    } catch (err) {
      const { data } = await supabase.from('tasks').select('output').eq('id', taskId).single()
      await supabase.from('tasks').update({
        status: 'error',
        output: (data?.output || '') + `❌ Error: ${String(err)}\n`
      }).eq('id', taskId)
    } finally {
      await page.close()
    }
  }
}

tasksRouter.post('/create-task', async (req, res) => {
  const { prompt, userId } = req.body
  console.log(`Create task: userId=${userId}, extensionConnected=${isExtensionConnected(userId)}`)
  console.log(`All connected extensions: ${[...extensionConnections.keys()].join(', ')}`)
  if (!prompt || !userId) {
    return res.status(400).json({ error: 'Missing prompt or userId' })
  }
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
  runTaskInBackground(data.id, prompt, userId)
})

tasksRouter.get('/tasks/:userId', async (req, res) => {
  const { data } = await supabase
    .from('tasks')
    .select('id, prompt, status, output, created_at')
    .eq('user_id', req.params.userId)
    .order('created_at', { ascending: false })
    .limit(50)
  res.json(data || [])
})

tasksRouter.post('/refresh-token', async (req, res) => {
  const { refreshToken } = req.body
  if (!refreshToken) return res.status(400).json({ error: 'Missing refresh token' })
  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data.session) throw new Error('Refresh failed')
    res.json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token })
  } catch (err) {
    res.status(401).json({ error: String(err) })
  }
})
