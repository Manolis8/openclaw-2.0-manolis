import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { newPage } from '../lib/browser.js'
import { runAgent } from '../lib/agent.js'

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

async function runTaskInBackground(taskId: string, prompt: string) {
  const page = await newPage()
  try {
    const result = await runAgent(prompt, page, async (step) => {
      console.log(`[${taskId}] ${step}`)
      await appendOutput(taskId, step)
    })
    const { data } = await supabase
      .from('tasks')
      .select('output')
      .eq('id', taskId)
      .single()
    await supabase
      .from('tasks')
      .update({
        status: 'done',
        output: (data?.output || '') + `✅ Done: ${result}\n`
      })
      .eq('id', taskId)
  } catch (err) {
    const error = String(err)
    console.error(`[${taskId}] Error:`, error)
    const { data } = await supabase
      .from('tasks')
      .select('output')
      .eq('id', taskId)
      .single()
    await supabase
      .from('tasks')
      .update({
        status: 'error',
        output: (data?.output || '') + `❌ Error: ${error}\n`
      })
      .eq('id', taskId)
  } finally {
    await page.close()
  }
}

tasksRouter.post('/create-task', async (req, res) => {
  const { prompt, userId } = req.body
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
  runTaskInBackground(data.id, prompt)
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
