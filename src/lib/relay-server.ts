import { createServer, Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'

interface RelayInfo {
  server: Server
  cdpWsUrl: string
  port: number
}

const relayServers = new Map<string, RelayInfo>()

// Forward declarations — index.ts provides these via setExtensionBridge
let _getConnection: (userId: string) => WebSocket | undefined
let _getPending: (userId: string) => Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }> | undefined
let _getNextId: () => number

export function setExtensionBridge(opts: {
  getConnection: (userId: string) => WebSocket | undefined
  getPending: (userId: string) => Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }> | undefined
  getNextId: () => number
}) {
  _getConnection = opts.getConnection
  _getPending = opts.getPending
  _getNextId = opts.getNextId
}

function sendThroughRelay(
  userId: string,
  message: Record<string, unknown>
): Promise<any> {
  const ws = _getConnection(userId)
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Extension not connected')
  }
  const pending = _getPending(userId)
  if (!pending) throw new Error('No pending map for user')
  const id = _getNextId()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('CDP relay timeout'))
    }, 15000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    ws.send(JSON.stringify({ ...message, id }))
  })
}

export async function startRelayServer(userId: string): Promise<RelayInfo> {
  const existing = relayServers.get(userId)
  if (existing) return existing

  const server = createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        'Browser': 'Chrome/Extension-Relay',
        'Protocol-Version': '1.3',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'V8-Version': '12.0.0',
        'WebKit-Version': '537.36',
        webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as any)?.port}/cdp`
      }))
    } else if (req.url === '/json/list' || req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify([]))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
    if (req.url === '/cdp') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    } else {
      socket.destroy()
    }
  })

  // ── CDP session multiplexing ──
  // Playwright uses sessionId to multiplex commands on a single WebSocket.
  // The extension relay uses tabId. We bridge by mapping sessionId → tabId.

  type Session = { sessionId: string; tabId: number }
  const sessions = new Map<string, Session>()
  let sessionCounter = 0
  let browserContextId: string | null = null

  wss.on('connection', (ws: WebSocket) => {
    function sendResult(id: number, result: unknown) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, result }))
      }
    }

    function sendError(id: number, code: number, message: string) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, error: { code, message } }))
      }
    }

    function sendEvent(method: string, params: unknown) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method, params }))
      }
    }

    ws.on('message', async (raw: Buffer | string) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }

      const id = msg.id as number
      const method = msg.method as string
      const params = (msg.params ?? {}) as Record<string, unknown>
      const sessionId = msg.sessionId as string | undefined

      // ── Session-scoped commands (page-level CDP) ──
      if (sessionId) {
        const session = sessions.get(sessionId)
        if (!session) {
          sendError(id, -32001, `Session ${sessionId} not found`)
          return
        }
        try {
          const result = await sendThroughRelay(userId, {
            method: 'forwardCDPCommand',
            params: {
              method,
              params: { ...params },
              tabId: session.tabId
            }
          })
          sendResult(id, result ?? {})
        } catch (err) {
          sendError(id, -32000, String(err))
        }
        return
      }

      // ── Browser-scoped commands ──
      switch (method) {
        case 'Browser.getVersion': {
          sendResult(id, {
            protocolVersion: '1.3',
            product: 'Chrome/Extension-Relay',
            revision: '1.0',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            jsVersion: '12.0.0'
          })
          break
        }

        case 'Browser.getWindowForTarget': {
          sendResult(id, {
            windowId: 1,
            bounds: { left: 0, top: 0, width: 1280, height: 720, windowState: 'normal' }
          })
          break
        }

        case 'Target.getBrowserContexts': {
          if (!browserContextId) {
            browserContextId = `browser-context-${userId}`
          }
          sendResult(id, {
            browserContextIds: [{ browserContextId }]
          })
          break
        }

        case 'Target.getTargets': {
          try {
            const result = await sendThroughRelay(userId, {
              method: 'forwardCDPCommand',
              params: { method: 'Target.getTargets', params: {} }
            })
            sendResult(id, result ?? { targetInfos: [] })
          } catch {
            sendResult(id, { targetInfos: [] })
          }
          break
        }

        case 'Target.createTarget': {
          try {
            await sendThroughRelay(userId, {
              method: 'forwardCDPCommand',
              params: { method: 'Page.navigate', params: { url: (params.url as string) || 'about:blank' } }
            })
            sessionCounter++
            const newSessionId = `session-${sessionCounter}`
            sessions.set(newSessionId, { sessionId: newSessionId, tabId: sessionCounter })
            sendResult(id, { targetId: `target-${sessionCounter}` })
          } catch (err) {
            sendError(id, -32000, String(err))
          }
          break
        }

        case 'Target.attachToTarget': {
          const targetId = params.targetId as string
          // Use existing session or create one
          let session: Session | undefined
          for (const [, s] of sessions) {
            session = s
            break
          }
          if (!session) {
            sessionCounter++
            const sid = `session-${sessionCounter}`
            session = { sessionId: sid, tabId: sessionCounter }
            sessions.set(sid, session)
          }
          sendResult(id, { sessionId: session.sessionId })
          sendEvent('Target.attachedToTarget', {
            sessionId: session.sessionId,
            targetInfo: {
              targetId: targetId || `target-${session.tabId}`,
              type: 'page',
              title: '',
              url: '',
              attached: true,
              canAccessOpener: false
            },
            waitingForDebugger: false
          })
          break
        }

        case 'Target.setAutoAttach': {
          sendResult(id, {})
          break
        }

        case 'Target.detachFromTarget': {
          const sid = params.sessionId as string
          if (sid) sessions.delete(sid)
          sendResult(id, {})
          break
        }

        case 'Target.setDiscoverTargets': {
          sendResult(id, {})
          break
        }

        case 'Target.activateTarget': {
          sendResult(id, {})
          break
        }

        case 'Schema.getDomains': {
          sendResult(id, { domains: [] })
          break
        }

        default: {
          // Forward everything else through the relay
          try {
            const result = await sendThroughRelay(userId, {
              method: 'forwardCDPCommand',
              params: { method, params }
            })
            sendResult(id, result ?? {})
          } catch (err) {
            sendError(id, -32000, String(err))
          }
          break
        }
      }
    })
  })

  return new Promise<RelayInfo>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }
      const info: RelayInfo = {
        server,
        port: addr.port,
        cdpWsUrl: `ws://127.0.0.1:${addr.port}/cdp`
      }
      relayServers.set(userId, info)
      console.log(`📡 CDP relay for ${userId} on port ${addr.port}`)
      resolve(info)
    })
    server.on('error', reject)
  })
}

export function stopRelayServer(userId: string): void {
  const info = relayServers.get(userId)
  if (info) {
    info.server.close()
    relayServers.delete(userId)
  }
}

export function getRelayServerInfo(userId: string): RelayInfo | undefined {
  return relayServers.get(userId)
}

export function hasRelayServer(userId: string): boolean {
  return relayServers.has(userId)
}
