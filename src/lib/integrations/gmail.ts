import { getAndRefreshToken, makeApiCall } from '../api-caller.js'

const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1/users/me'

export async function listEmails(
  userId: string,
  options: { maxResults?: number; q?: string } = {}
): Promise<any> {
  const token = await getAndRefreshToken(userId, 'gmail')
  if (!token) throw new Error('Gmail not connected')

  const params = new URLSearchParams({
    maxResults: String(options.maxResults || 10),
    ...(options.q && { q: options.q })
  })

  return makeApiCall(`${GMAIL_API_BASE}/messages?${params}`, {
    authorization: `Bearer ${token.accessToken}`
  })
}

export async function getEmail(userId: string, messageId: string): Promise<any> {
  const token = await getAndRefreshToken(userId, 'gmail')
  if (!token) throw new Error('Gmail not connected')

  return makeApiCall(`${GMAIL_API_BASE}/messages/${messageId}`, {
    authorization: `Bearer ${token.accessToken}`
  })
}

export async function sendEmail(
  userId: string,
  to: string,
  subject: string,
  body: string
): Promise<any> {
  const token = await getAndRefreshToken(userId, 'gmail')
  if (!token) throw new Error('Gmail not connected')

  // Create RFC 2822 formatted message
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body
  ].join('\n')

  const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')

  return makeApiCall(`${GMAIL_API_BASE}/messages/send`, {
    method: 'POST',
    authorization: `Bearer ${token.accessToken}`,
    body: { raw: encodedMessage }
  })
}

export async function getEmailContent(userId: string, messageId: string): Promise<string> {
  const email = await getEmail(userId, messageId)
  if (!email.payload?.parts) return email.snippet || ''

  // Find text part
  const textPart = email.payload.parts.find((p: any) => p.mimeType === 'text/plain')
  if (!textPart) return email.snippet || ''

  const data = textPart.body?.data || ''
  return Buffer.from(data, 'base64').toString('utf-8')
}

export async function summarizeEmails(userId: string): Promise<string> {
  const result = await listEmails(userId, { maxResults: 5 })
  if (!result.messages || result.messages.length === 0) {
    return 'No recent emails'
  }

  const summaries = []
  for (const msg of result.messages.slice(0, 3)) {
    const email = await getEmail(userId, msg.id)
    const headers = email.payload?.headers || []
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)'
    const from = headers.find((h: any) => h.name === 'From')?.value || '(unknown)'
    summaries.push(`From: ${from} - Subject: ${subject}`)
  }

  return summaries.join('\n')
}
