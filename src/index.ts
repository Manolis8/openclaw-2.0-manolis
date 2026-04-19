import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { createClient } from '@supabase/supabase-js'
import { createHmac } from 'node:crypto'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
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
const BASE_RELAY_PORT = 18792
const userRelayPorts = new Map<string, number>()
const usedPorts = new Set<number>()
const activeTaskTimeouts = new Map<string, NodeJS.Timeout>()

const generalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
})

const generateKeyRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many key generation requests, please try again later' }
})

function getRelayPortForUser(userId: string): number {
  if (userRelayPorts.has(userId)) return userRelayPorts.get(userId)!
  for (let port = BASE_RELAY_PORT; port < BASE_RELAY_PORT + 100; port++) {
    if (!usedPorts.has(port)) {
      usedPorts.add(port)
      userRelayPorts.set(userId, port)
      return port
    }
  }
  throw new Error('No relay ports available')
}

function freeRelayPort(userId: string) {
  const port = userRelayPorts.get(userId)
  if (port) {
    usedPorts.delete(port)
    userRelayPorts.delete(userId)
  }
}

function setTaskTimeout(taskId: string, userId: string) {
  const timer = setTimeout(async () => {
    activeTaskTimeouts.delete(taskId)
    await supabase.from('tasks').update({
      status: 'error',
      output: '⏱️ Task timed out. The task took too long to complete. Please try again with a simpler request.'
    }).eq('id', taskId).eq('status', 'running')
  }, 180_000) // 3 minutes
  activeTaskTimeouts.set(taskId, timer)
}

function clearTaskTimeout(taskId: string) {
  const timer = activeTaskTimeouts.get(taskId)
  if (timer) {
    clearTimeout(timer)
    activeTaskTimeouts.delete(taskId)
  }
}

export { getRelayPortForUser, freeRelayPort, BASE_RELAY_PORT }

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

function deriveRelayToken(gatewayToken: string, port: number): string {
  return createHmac('sha256', gatewayToken)
    .update(`openclaw-extension-relay-v1:${port}`)
    .digest('hex')
}

const allowedOrigins = [
  'https://unclawned.com',
  'https://www.unclawned.com',
  'https://test-frontend-unclawned.vercel.app',
  'https://www.test-frontend-unclawned.vercel.app'
]

app.use(helmet())
// Apply rate limiter globally EXCEPT extension-status
app.use((req, res, next) => {
  if (req.path.startsWith('/api/extension-status')) {
    return next()
  }

  return generalRateLimiter(req, res, next)
})

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin)
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.sendStatus(200); return }
  next()
})

app.use(express.json({ limit: '10kb' }))

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`)
  next()
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date() })
})

app.post('/api/generate-key', generateKeyRateLimiter, async (req, res) => {
  const { userId } = req.body
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Missing userId' })
  const sanitizedUserId = userId.trim().replace(/\0/g, '')
  if (!sanitizedUserId || sanitizedUserId.length > 100) return res.status(400).json({ error: 'Invalid userId' })
  const key = 'felo_' + [...Array(40)].map(() => Math.random().toString(36)[2]).join('')
  const { error } = await supabase
    .from('api_keys')
    .upsert({ user_id: sanitizedUserId, key }, { onConflict: 'user_id' })
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

const wsConnectionsPerIp = new Map<string, { count: number, windowStart: number }>()
const WS_MAX_CONNECTIONS = 10
const WS_WINDOW_MS = 60 * 1000

function checkWsRateLimit(ip: string): boolean {
  const now = Date.now()
  const record = wsConnectionsPerIp.get(ip)
  if (!record || now - record.windowStart > WS_WINDOW_MS) {
    wsConnectionsPerIp.set(ip, { count: 1, windowStart: now })
    return true
  }
  if (record.count >= WS_MAX_CONNECTIONS) return false
  record.count++
  return true
}

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
  const clientIp = req.socket.remoteAddress || 'unknown'
  if (!checkWsRateLimit(clientIp)) {
    console.log(`WS rate limit exceeded for IP: ${clientIp}`)
    ws.close(1008, 'Rate limit exceeded')
    return
  }

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
  const relayPort = getRelayPortForUser(userId)
  const relayToken = deriveRelayToken(gatewayToken, relayPort)

  try {
    const relay = await ensureChromeExtensionRelayServer({ cdpUrl: `http://127.0.0.1:${relayPort}` })
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

  const relayExtUrl = `ws://127.0.0.1:${relayPort}/extension?token=${encodeURIComponent(relayToken)}`
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

      // Handle CDP responses for pending commands
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

      // Forward everything else to relay bridge once
      if (relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(text)
      }

      if (msg.method === 'forwardCDPEvent') {
        console.log(`CDP event from ${userId}: ${msg.params?.method}`)
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
    freeRelayPort(userId)
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
    setTaskTimeout(task.id, userId)
    runTaskInBackground(task.id, task.prompt, userId).then(() => {
      clearTaskTimeout(task.id)
    }).catch(() => {
      clearTaskTimeout(task.id)
    })
  }
}

server.listen(PORT, async () => {
  console.log(`✅ Felo backend running on port ${PORT}`)
  console.log(`✅ Supabase URL: ${process.env.SUPABASE_URL}`)
  const { loadScheduledTasks } = await import('./lib/scheduler.js')
  const { runTaskInBackground } = await import('./routes/tasks.js')
  await loadScheduledTasks(runTaskInBackground)
})