import { chromium, type Browser, type Page } from 'playwright-core'
import { getRelayPortForUser } from '../index.js'

type RelayConn = { browser: Browser; port: number }
const connections = new Map<string, RelayConn>()
const targetIds = new Map<string, string>()

async function deriveRelayToken(gatewayToken: string, port: number): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(gatewayToken),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`openclaw-extension-relay-v1:${port}`))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Returns the active page + relay connection info for a user.
 * Mirrors the getBrowser() logic in agent-extension.ts but is fully independent —
 * agent-extension.ts is not imported or modified.
 */
export async function getRelayPage(userId: string): Promise<{
  page: Page
  cdpUrl: string
  targetId: string
}> {
  const port = getRelayPortForUser(userId)
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  const relayToken = await deriveRelayToken(token, port)
  const wsUrl = `ws://127.0.0.1:${port}/cdp`

  let conn = connections.get(userId)
  if (!conn || conn.port !== port) {
    try { if (conn) conn.browser.close().catch(() => {}) } catch {}
    const browser = await chromium.connectOverCDP(wsUrl, {
      headers: { 'x-openclaw-relay-token': relayToken },
    })
    conn = { browser, port }
    connections.set(userId, conn)
    browser.on('disconnected', () => {
      if (connections.get(userId) === conn) {
        connections.delete(userId)
        targetIds.delete(userId)
      }
    })
  }

  const pages = conn.browser.contexts().flatMap(c => c.pages())
  if (!pages.length) throw new Error('No pages found in browser. Is the extension connected?')
  const page = pages.find(p => p.url() !== 'about:blank') ?? pages[0]

  let targetId = targetIds.get(userId) || ''
  if (!targetId) {
    try {
      const session = await page.context().newCDPSession(page)
      const info = await session.send('Target.getTargetInfo') as any
      targetId = String(info?.targetInfo?.targetId || '').trim()
      await session.detach().catch(() => {})
      if (targetId) targetIds.set(userId, targetId)
    } catch {}
  }

  return { page, cdpUrl: `http://127.0.0.1:${port}`, targetId }
}
