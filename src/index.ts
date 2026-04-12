import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { createClient } from '@supabase/supabase-js'
import { createHmac } from 'node:crypto'
import { tasksRouter } from './routes/tasks.js'
import { messagesRouter } from './routes/messages.js'
import { oauthRouter } from './routes/oauth.js'
import { ensureChromeExtensionRelayServer } from './browser/extension-relay.js'

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (recovered):', err.message)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (recovered):', reason)
})

const app = express()
const PORT = process.env.PORT || 3001
const RELAY_PORT = 18792

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

function deriveRelayToken(gatewayToken: string, port: number): string {
  return createHmac('sha256', gatewayToken)
    .update(`openclaw-extension-relay-v1:${port}`)
    .digest('hex')
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.sendStatus(200); return }
  next()
})

app.use(express.json())

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`)
  next()
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date() })
})

app.post('/api/generate-key', async (req, res) => {
  const { userId } = req.body
  if (!userId) return res.status(400).json({ error: 'Missing userId' })
  const key = 'felo_' + [...Array(40)].map(() => Math.random().toString(36)[2]).join('')
  const { error } = await supabase
    .from('api_keys')
    .upsert({ user_id: userId, key }, { onConflict: 'user_id' })
  if (error) return res.status(500).json({ error: 'Failed to generate key' })
  res.json({ key })
})

app.get('/api/get-key/:userId', async (req, res) => {
  const { data } = await supabase
    .from('api_keys')
    .select('key')
    .eq('user_id', req.params.userId)
    .single()
  res.json({ key: data?.key || null })
})

app.get('/api/extension-status/:userId', (req, res) => {
  res.json({ connected: isExtensionConnected(req.params.userId) })
})

app.use('/api', tasksRouter)
app.use('/api', messagesRouter)
app.use('/api', oauthRouter)

const server = createServer(app)
const wss = new WebSocketServer({ noServer: true })

export const extensionConnections = new Map<string, WebSocket>()
export const pendingCdpCommands = new Map<string, Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>>()

const relayBridges = new Map<string, WebSocket>()

server.on('upgrade', (request, socket, head) => {
  console.log('🔌 WebSocket upgrade:', request.url?.slice(0, 80))
  const url = new URL(request.url || '', 'http://localhost')
  if (url.pathname === '/extension') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  } else {
    socket.destroy()
  }
})

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '', 'http://localhost')
  const token = url.searchParams.get('token')

  if (!token) { ws.close(1008, 'Missing token'); return }

  let userId: string
  try {
    const { data, error } = await supabase
      .from('api_keys')
      .select('user_id')
      .eq('key', token)
      .single()
    if (error || !data) throw new Error('Key not found')
    userId = data.user_id
    console.log(`✅ API key valid for user: ${userId}`)
  } catch (err) {
    console.error('Extension auth failed:', String(err))
    ws.close(1008, 'Invalid token')
    return
  }

  const existing = extensionConnections.get(userId)
  if (existing?.readyState === WebSocket.OPEN) {
    existing.close(1000, 'Replaced by new connection')
  }

  extensionConnections.set(userId, ws)
  pendingCdpCommands.set(userId, new Map())
  console.log(`✅ Extension connected: ${userId} (total: ${extensionConnections.size})`)

  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  const relayToken = deriveRelayToken(gatewayToken, RELAY_PORT)

  try {
    const relay = await ensureChromeExtensionRelayServer({ cdpUrl: `http://127.0.0.1:${RELAY_PORT}` })
    console.log(`📡 Extension relay ready: ${relay.cdpWsUrl}`)
  } catch (err) {
    console.error(`Failed to start extension relay:`, err)
  }

  // Close existing relay bridge for this user if one exists
  const existingBridge = relayBridges.get(userId)
  if (existingBridge) {
    existingBridge.close()
    relayBridges.delete(userId)
    await new Promise(r => setTimeout(r, 500))
  }

  const relayExtUrl = `ws://127.0.0.1:${RELAY_PORT}/extension?token=${encodeURIComponent(relayToken)}`
  const relayWs = new WebSocket(relayExtUrl)
  relayBridges.set(userId, relayWs)

  relayWs.on('open', () => {
    console.log(`🌉 Relay bridge open for ${userId}`)
  })

  relayWs.on('error', (err) => {
    console.error(`Relay bridge error for ${userId}:`, err.message)
  })

  relayWs.on('close', () => {
    console.log(`Relay bridge closed for ${userId}`)
    relayBridges.delete(userId)
  })

  relayWs.on('message', (data) => {
    const text = data instanceof Buffer ? data.toString() : String(data)
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(text)
    }
  })

  drainQueueForUser(userId)

  ws.send(JSON.stringify({ method: 'connected', params: { userId } }))

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'ping' }))
  }, 25000)

  ws.on('message', (data) => {
    const text = data instanceof Buffer ? data.toString() : String(data)
    try {
      const msg = JSON.parse(text)

      if (msg.method === 'pong') return

      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const userPending = pendingCdpCommands.get(userId)
        const pending = userPending?.get(msg.id)
        if (pending) {
          userPending!.delete(msg.id)
          if (msg.error) pending.reject(new Error(String(msg.error)))
          else pending.resolve(msg.result)
          return
        }
      }

      if (relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(text)
      }

      if (msg.method === 'forwardCDPEvent') {
        console.log(`CDP event from ${userId}: ${msg.params?.method}`)
        if (relayWs.readyState === WebSocket.OPEN) {
          relayWs.send(text)
        }
      }
    } catch (err) {
      console.error('Extension message error:', err)
    }
  })

  ws.on('close', () => {
    clearInterval(pingInterval)
    if (extensionConnections.get(userId) === ws) {
      extensionConnections.delete(userId)
      pendingCdpCommands.delete(userId)
    }
    const bridge = relayBridges.get(userId)
    if (bridge) {
      bridge.close()
      relayBridges.delete(userId)
    }
    console.log(`Extension disconnected: ${userId} (total: ${extensionConnections.size})`)
  })

  ws.on('error', (err) => console.error(`WS error for ${userId}:`, err))
})

export let cdpCommandId = 1

export async function sendCdpCommand(
  userId: string,
  method: string,
  params?: object,
  tabId?: number,
  timeoutMs = 15000
): Promise<any> {
  const ws = extensionConnections.get(userId)
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Extension not connected for this user')
  const id = cdpCommandId++
  const userPending = pendingCdpCommands.get(userId) || new Map()
  pendingCdpCommands.set(userId, userPending)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      userPending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, timeoutMs)
    userPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    ws.send(JSON.stringify({ id, method: 'forwardCDPCommand', params: { method, params, tabId } }))
  })
}

export async function sendExtensionMessage(
  userId: string,
  method: string,
  params?: object,
  timeoutMs = 10000
): Promise<any> {
  const ws = extensionConnections.get(userId)
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Extension not connected for this user')
  const id = cdpCommandId++
  const userPending = pendingCdpCommands.get(userId) || new Map()
  pendingCdpCommands.set(userId, userPending)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      userPending.delete(id)
      reject(new Error(`Extension message timeout: ${method}`))
    }, timeoutMs)
    userPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

export function isExtensionConnected(userId: string): boolean {
  const ws = extensionConnections.get(userId)
  const connected = !!ws && ws.readyState === WebSocket.OPEN
  console.log(`isExtensionConnected(${userId}): ${connected}, total: ${extensionConnections.size}`)
  return connected
}

async function drainQueueForUser(userId: string) {
  const { data: queuedTasks } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'queued')
    .order('created_at', { ascending: true })

  if (!queuedTasks?.length) return
  console.log(`🔄 Draining ${queuedTasks.length} queued tasks for ${userId}`)

  const { runTaskInBackground } = await import('./routes/tasks.js')
  for (const task of queuedTasks) {
    await supabase.from('tasks').update({ status: 'running' }).eq('id', task.id)
    runTaskInBackground(task.id, task.prompt, userId)
  }
}

server.listen(PORT, async () => {
  console.log(`✅ Felo backend running on port ${PORT}`)
  console.log(`✅ Supabase URL: ${process.env.SUPABASE_URL}`)
  const { loadScheduledTasks } = await import('./lib/scheduler.js')
  const { runTaskInBackground } = await import('./routes/tasks.js')
  await loadScheduledTasks(runTaskInBackground)
})