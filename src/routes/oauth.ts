import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'
import { OAUTH_CONFIG, OAuthProvider } from '../lib/oauth-config.js'
import { encrypt, decrypt } from '../lib/encryption.js'

function sanitizeString(input: unknown, maxLength = 100): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/\0/g, '')
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null
}

export const oauthRouter = Router()



const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

// Step 1 — redirect user to provider OAuth page
oauthRouter.get('/oauth/:provider/connect', (req, res) => {
  const provider = req.params.provider as OAuthProvider
  const rawUserId = req.query.userId
  const userId = sanitizeString(rawUserId, 100)

  if (!userId || !OAUTH_CONFIG[provider]) {
    return res.status(400).json({ error: 'Invalid provider or missing userId' })
  }

  const config = OAUTH_CONFIG[provider]
  const state = Buffer.from(JSON.stringify({ userId, provider })).toString('base64')

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state,
    access_type: 'offline',
    prompt: 'consent'
  })

  if (config.scopes.length > 0) {
    params.set('scope', config.scopes.join(' '))
  }

  res.redirect(`${config.authUrl}?${params.toString()}`)
})

// Step 2 — handle callback from provider
oauthRouter.get('/oauth/:provider/callback', async (req, res) => {
  const provider = req.params.provider as OAuthProvider
  const { code, state, error } = req.query

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}?oauth_error=${error}`)
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state' })
  }

  let userId: string
  try {
    const decoded = JSON.parse(Buffer.from(state as string, 'base64').toString())
    userId = decoded.userId
  } catch {
    return res.status(400).json({ error: 'Invalid state' })
  }

  const config = OAUTH_CONFIG[provider]

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        ...(provider === 'notion' ? {
          'Authorization': 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
        } : {})
      },
      body: new URLSearchParams({
        code: code as string,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    })

    const tokens = await tokenRes.json()
    console.log(`OAuth tokens for ${provider}:`, JSON.stringify(tokens).slice(0, 200))

    if (!tokens.access_token && !tokens.authed_user) {
      throw new Error('No access token in response: ' + JSON.stringify(tokens))
    }

    // Handle Slack's different token structure
    const accessToken = provider === 'slack'
      ? tokens.authed_user?.access_token || tokens.access_token
      : tokens.access_token

    const refreshToken = tokens.refresh_token || null
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null

    // Store encrypted tokens in Supabase
    await supabase
      .from('oauth_tokens')
      .upsert({
        user_id: userId,
        provider,
        access_token: encrypt(accessToken),
        refresh_token: refreshToken ? encrypt(refreshToken) : null,
        expires_at: expiresAt,
        scope: tokens.scope || null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,provider' })

    // Redirect back to dashboard with success
    res.redirect(`${process.env.FRONTEND_URL}?oauth_success=${provider}`)

  } catch (err) {
    console.error(`OAuth callback error for ${provider}:`, err)
    res.redirect(`${process.env.FRONTEND_URL}?oauth_error=token_exchange_failed`)
  }
})

// Get connected providers for a user
oauthRouter.get('/oauth/status/:userId', async (req, res) => {
  const { userId } = req.params
  const { data } = await supabase
    .from('oauth_tokens')
    .select('provider')
    .eq('user_id', userId)

  const connected: Record<string, boolean> = {
    gmail: false,
    'google-calendar': false,
    'google-sheets': false,
    slack: false,
    notion: false,
    github: false
  }

  data?.forEach(row => {
    connected[row.provider] = true
  })

  res.json(connected)
})

// Disconnect a provider
oauthRouter.delete('/oauth/:provider/:userId', async (req, res) => {
  const { provider, userId } = req.params
  await supabase
    .from('oauth_tokens')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider)
  res.json({ ok: true })
})

// Get decrypted token for a user+provider (internal use by agent)
oauthRouter.get('/oauth/token/:provider/:userId', async (req, res) => {
  const { provider, userId } = req.params
  const { data } = await supabase
    .from('oauth_tokens')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .single()

  if (!data) return res.status(404).json({ error: 'Not connected' })

  // Check if token needs refresh
  if (data.expires_at && data.refresh_token) {
    const expiresAt = new Date(data.expires_at)
    const fiveMinutes = 5 * 60 * 1000
    if (expiresAt.getTime() - Date.now() < fiveMinutes) {
      try {
        const config = OAUTH_CONFIG[provider as OAuthProvider]
        const refreshRes = await fetch(config.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: decrypt(data.refresh_token),
            client_id: config.clientId,
            client_secret: config.clientSecret
          }).toString()
        })
        const refreshed = await refreshRes.json()
        if (refreshed.access_token) {
          const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
          await supabase
            .from('oauth_tokens')
            .update({
              access_token: encrypt(refreshed.access_token),
              expires_at: newExpiresAt,
              updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('provider', provider)
          return res.json({ accessToken: refreshed.access_token, expiresAt: newExpiresAt })
        }
      } catch (err) {
        console.error('Token refresh error:', err)
      }
    }
  }

  res.json({
    accessToken: decrypt(data.access_token),
    expiresAt: data.expires_at
  })
})
