import { Nango } from '@nangohq/node'

export const nango = new Nango({
  secretKey: process.env.NANGO_SECRET_KEY!,
  host: process.env.NANGO_HOST!
})

export const INTEGRATIONS = {
  github: 'github-app',
  googleCalendar: 'google-calendar',
  gmail: 'google-mail',
  googleSheets: 'google-sheet',
  notion: 'notion',
  slack: 'slack'
} as const

export type IntegrationId = typeof INTEGRATIONS[keyof typeof INTEGRATIONS]

// Get connection token for a user and provider
export async function getConnection(userId: string, integrationId: IntegrationId) {
  try {
    const connection = await nango.getConnection(integrationId, userId)
    return connection
  } catch {
    return null
  }
}

// Check if user has connected a specific integration
export async function isConnected(userId: string, integrationId: IntegrationId): Promise<boolean> {
  const connection = await getConnection(userId, integrationId)
  return !!connection
}

// Make an authenticated API call through Nango proxy
export async function proxyGet(
  userId: string,
  integrationId: IntegrationId,
  endpoint: string
) {
  return await nango.get({
    providerConfigKey: integrationId,
    connectionId: userId,
    endpoint
  })
}

export async function proxyPost(
  userId: string,
  integrationId: IntegrationId,
  endpoint: string,
  data: object
) {
  return await nango.post({
    providerConfigKey: integrationId,
    connectionId: userId,
    endpoint,
    data
  })
}
