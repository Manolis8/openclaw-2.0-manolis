import { Router } from 'express'
import { nango, INTEGRATIONS } from '../lib/nango.js'

export const connectionsRouter = Router()

// Get all connected integrations for a user
connectionsRouter.get('/connections/:userId', async (req, res) => {
  const { userId } = req.params
  const results: Record<string, boolean> = {}

  for (const [name, integrationId] of Object.entries(INTEGRATIONS)) {
    try {
      const connection = await nango.getConnection(integrationId, userId)
      results[name] = !!connection
    } catch {
      results[name] = false
    }
  }

  res.json(results)
})

// Create a Nango connect session for a user
connectionsRouter.post('/connections/session', async (req, res) => {
  const { userId, integrationId } = req.body
  if (!userId || !integrationId) {
    return res.status(400).json({ error: 'Missing userId or integrationId' })
  }

  try {
    const session = await nango.createConnectSession({
      end_user: { id: userId },
      allowed_integrations: [integrationId]
    })
    res.json({ sessionToken: session.data.token })
  } catch (err) {
    console.error('Nango session error:', err)
    res.status(500).json({ error: 'Failed to create connect session' })
  }
})

// Disconnect an integration for a user
connectionsRouter.delete('/connections/:userId/:integrationId', async (req, res) => {
  const { userId, integrationId } = req.params
  try {
    await nango.deleteConnection(integrationId, userId)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect' })
  }
})
