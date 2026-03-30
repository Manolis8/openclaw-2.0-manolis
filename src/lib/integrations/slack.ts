import { getAndRefreshToken, makeApiCall } from '../api-caller.js'

const SLACK_API_BASE = 'https://slack.com/api'

export async function sendMessage(
  userId: string,
  channel: string,
  text: string
): Promise<any> {
  const token = await getAndRefreshToken(userId, 'slack')
  if (!token) throw new Error('Slack not connected')

  return makeApiCall(`${SLACK_API_BASE}/chat.postMessage`, {
    method: 'POST',
    authorization: `Bearer ${token.accessToken}`,
    body: { channel, text }
  })
}

export async function listChannels(userId: string): Promise<any> {
  const token = await getAndRefreshToken(userId, 'slack')
  if (!token) throw new Error('Slack not connected')

  return makeApiCall(`${SLACK_API_BASE}/conversations.list?limit=50`, {
    authorization: `Bearer ${token.accessToken}`
  })
}

export async function getMessages(userId: string, channel: string, limit = 10): Promise<any> {
  const token = await getAndRefreshToken(userId, 'slack')
  if (!token) throw new Error('Slack not connected')

  return makeApiCall(`${SLACK_API_BASE}/conversations.history?channel=${channel}&limit=${limit}`, {
    authorization: `Bearer ${token.accessToken}`
  })
}

export async function getChannelInfo(userId: string, channel: string): Promise<any> {
  const token = await getAndRefreshToken(userId, 'slack')
  if (!token) throw new Error('Slack not connected')

  return makeApiCall(`${SLACK_API_BASE}/conversations.info?channel=${channel}`, {
    authorization: `Bearer ${token.accessToken}`
  })
}

export async function getUserInfo(userId: string): Promise<any> {
  const token = await getAndRefreshToken(userId, 'slack')
  if (!token) throw new Error('Slack not connected')

  return makeApiCall(`${SLACK_API_BASE}/auth.test`, {
    authorization: `Bearer ${token.accessToken}`
  })
}
