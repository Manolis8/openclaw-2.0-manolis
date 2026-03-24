import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

export const messagesRouter = Router()

// Get all messages for a user
messagesRouter.get('/messages/:userId', async (req, res) => {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('user_id', req.params.userId)
    .order('created_at', { ascending: false })
    .limit(50)
  res.json(data || [])
})

// Get unread count
messagesRouter.get('/messages/:userId/unread', async (req, res) => {
  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', req.params.userId)
    .eq('read', false)
  res.json({ count: count || 0 })
})

// Mark single message as read
messagesRouter.patch('/messages/:messageId/read', async (req, res) => {
  await supabase
    .from('messages')
    .update({ read: true })
    .eq('id', req.params.messageId)
  res.json({ ok: true })
})

// Mark all messages as read for user
messagesRouter.patch('/messages/:userId/read-all', async (req, res) => {
  await supabase
    .from('messages')
    .update({ read: true })
    .eq('user_id', req.params.userId)
    .eq('read', false)
  res.json({ ok: true })
})
