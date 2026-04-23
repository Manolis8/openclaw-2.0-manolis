import Anthropic from '@anthropic-ai/sdk'
import { chromium, type Page } from 'playwright-core'
import { supabase } from './supabase.js'
import { getRelayPortForUser } from '../index.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── Browser connection ───────────────────────────────────────────────────

const connections = new Map<string, { browser: any; port: number }>()

async function getPage(userId: string): Promise<Page> {
  const port = getRelayPortForUser(userId)
  let conn = connections.get(userId)
  if (!conn || conn.port !== port) {
    if (conn) conn.browser.close().catch(() => {})
    const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`openclaw-extension-relay-v1:${port}`))
    const relayToken = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/cdp`, {
      headers: { 'x-openclaw-relay-token': relayToken }
    })
    conn = { browser, port }
    connections.set(userId, conn)
    browser.on('disconnected', () => { if (connections.get(userId) === conn) connections.delete(userId) })
  }
  const pages = conn.browser.contexts().flatMap((c: any) => c.pages())
  if (!pages.length) throw new Error('No pages in browser')
  return pages.find((p: any) => p.url() !== 'about:blank') ?? pages[0]
}

// ─── Refs storage ─────────────────────────────────────────────────────────

const pageRefs = new Map<string, Record<string, { role: string; name?: string; nth?: number }>>()
const INTERACTIVE = new Set(['button','link','textbox','checkbox','radio','combobox','listbox','menuitem','option','searchbox','slider','switch','tab'])

// ─── Tools ────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'navigate',
    description: 'Navigate browser to a URL. You automatically receive page content after navigation.',
    input_schema: {
      type: 'object' as const,
      properties: { url: { type: 'string', description: 'Full URL with https://' } },
      required: ['url']
    }
  },
  {
    name: 'read_page',
    description: 'Read all text content from the current page. Use to read articles, news, search results.',
    input_schema: { type: 'object' as const, properties: {}, required: [] }
  },
  {
    name: 'snapshot',
    description: 'Get interactive elements on page with refs for clicking. Use when you need to click something.',
    input_schema: { type: 'object' as const, properties: {}, required: [] }
  },
  {
    name: 'click',
    description: 'Click an element by ref from snapshot.',
    input_schema: {
      type: 'object' as const,
      properties: { ref: { type: 'string' } },
      required: ['ref']
    }
  },
  {
    name: 'type',
    description: 'Type text into an input field.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ref: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter after typing' }
      },
      required: ['ref', 'text']
    }
  },
  {
    name: 'scroll',
    description: 'Scroll the page up or down.',
    input_schema: {
      type: 'object' as const,
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number' }
      },
      required: ['direction']
    }
  },
  {
    name: 'key_press',
    description: 'Press a keyboard key or shortcut like Enter, Tab, Escape, Control+c.',
    input_schema: {
      type: 'object' as const,
      properties: { key: { type: 'string' } },
      required: ['key']
    }
  },
  {
    name: 'dismiss_cookie',
    description: 'Dismiss any cookie or consent popup blocking the page.',
    input_schema: { type: 'object' as const, properties: {}, required: [] }
  },
  {
    name: 'wait',
    description: 'Wait for page to load.',
    input_schema: {
      type: 'object' as const,
      properties: { ms: { type: 'number' } },
      required: ['ms']
    }
  },
  {
    name: 'ask_permission',
    description: 'Ask user before doing something potentially irreversible like submitting a form, sending an email, posting, buying, or deleting.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', description: 'What you are about to do' },
        details: { type: 'string', description: 'Specific details of the action' }
      },
      required: ['action', 'details']
    }
  },
  {
    name: 'task_complete',
    description: 'Mark task as done with the full detailed result. Minimum 200 words for research tasks.',
    input_schema: {
      type: 'object' as const,
      properties: { result: { type: 'string' } },
      required: ['result']
    }
  },
  {
    name: 'task_failed',
    description: 'Mark task as failed after exhausting all approaches.',
    input_schema: {
      type: 'object' as const,
      properties: { reason: { type: 'string' } },
      required: ['reason']
    }
  }
]

// ─── Tool execution ───────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  input: Record<string, any>,
  userId: string,
  taskId: string,
  onProgress: (msg: string) => Promise<void>
): Promise<string> {
  const page = await getPage(userId)

  switch (toolName) {
    case 'navigate': {
      await onProgress(`🌐 Navigating to ${input.url}...`)
      await page.goto(input.url, { timeout: 30000, waitUntil: 'domcontentloaded' })
      const isGoogle = input.url.includes('google.com/search')
      await new Promise(r => setTimeout(r, isGoogle ? 2000 : 1200))

      // Auto dismiss cookie
      await page.evaluate(() => {
        const sels = ['#onetrust-reject-all-handler','#onetrust-accept-btn-handler','button[id*="reject"]','button[id*="accept"]','.cc-dismiss','[id*="cookie"] button']
        for (const sel of sels) {
          const el = document.querySelector(sel) as HTMLElement
          if (el && el.offsetParent !== null) { el.click(); break }
        }
      }).catch(() => {})
      await new Promise(r => setTimeout(r, 600))

      // Read content after navigation
      const content = await page.evaluate((isGoogle: boolean) => {
        if (isGoogle) {
          const results: string[] = []
          document.querySelectorAll('.g, .Gx5Zad, .tF2Cxc').forEach(el => {
            const title = el.querySelector('h3')
            const snippet = el.querySelector('.VwiC3b, .MUxGbd, .yXK7lf')
            if (title) {
              const t = (title as HTMLElement).innerText?.trim()
              const s = snippet ? (snippet as HTMLElement).innerText?.trim() : ''
              if (t && t.length > 5 && !t.includes('Skip to main')) {
                results.push(s ? `${t}: ${s}` : t)
              }
            }
          })
          if (results.length > 0) return results.slice(0, 15).join('\n')
          return Array.from(document.querySelectorAll('h3'))
            .map(el => (el as HTMLElement).innerText?.trim())
            .filter(t => t && t.length > 5 && !t.includes('Skip'))
            .slice(0, 15).join('\n') || 'No results found'
        }
        const remove = document.querySelectorAll('script,style,nav,header,footer,aside,[class*="cookie"],[id*="cookie"],[class*="popup"]')
        remove.forEach(el => el.remove())
        const main = document.querySelector('main,article,[role="main"],[class*="content"],[id*="content"]') as HTMLElement
        return (main || document.body).innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000)
      }, isGoogle).catch(() => 'Could not read page')

      return `Navigated to ${input.url}\n\nPAGE CONTENT:\n${content}`
    }

    case 'read_page': {
      await onProgress('📖 Reading page...')
      const content = await page.evaluate(() => {
        const remove = document.querySelectorAll('script,style,nav,header,footer,aside')
        remove.forEach(el => el.remove())
        const main = document.querySelector('main,article,[role="main"]') as HTMLElement
        return (main || document.body).innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000)
      })
      return `PAGE CONTENT:\n${content}`
    }

    case 'snapshot': {
      await onProgress('📸 Reading page elements...')
      const ariaRaw = await (page.locator(':root') as any).ariaSnapshot()
      const lines = String(ariaRaw).split('\n')
      const refs: Record<string, any> = {}
      const roleCounts = new Map<string, number>()
      let counter = 0
      const out: string[] = []
      for (const line of lines) {
        const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?(.*)$/)
        if (!match) { out.push(line); continue }
        const [, indent, role, name, rest] = match
        const roleLower = role.toLowerCase()
        if (INTERACTIVE.has(roleLower)) {
          counter++
          const ref = `e${counter}`
          const key = `${roleLower}:${name ?? ''}`
          const nth = roleCounts.get(key) ?? 0
          roleCounts.set(key, nth + 1)
          refs[ref] = { role: roleLower, name: name || undefined, nth: nth > 0 ? nth : undefined }
          out.push(`${indent}- ${role}${name ? ` "${name}"` : ''} [ref=${ref}]${nth > 0 ? ` [nth=${nth}]` : ''}${rest}`)
        } else {
          out.push(line)
        }
      }
      pageRefs.set(userId, refs)
      return `URL: ${page.url()}\n${out.join('\n') || '(no interactive elements)'}`
    }

    case 'click': {
      await onProgress(`🖱️ Clicking ${input.ref}...`)
      const refs = pageRefs.get(userId) || {}
      const info = refs[input.ref]
      if (!info) return `Unknown ref ${input.ref}. Call snapshot first.`
      try {
        const locator = info.name
          ? page.getByRole(info.role as any, { name: info.name, exact: true })
          : page.getByRole(info.role as any)
        const resolved = info.nth !== undefined ? locator.nth(info.nth) : locator
        await resolved.click({ timeout: 8000 })
        await new Promise(r => setTimeout(r, 600))
        const content = await page.evaluate(() => {
          const main = document.querySelector('main,article,[role="main"]') as HTMLElement
          return (main || document.body).innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000)
        })
        return `Clicked ${input.ref}. Page content:\n${content}`
      } catch (err: any) {
        if (err.message?.includes('intercepts pointer')) return `Blocked by overlay. Call dismiss_cookie first.`
        if (err.message?.includes('outside of the viewport')) return `Element outside viewport. Call scroll first.`
        if (err.message?.includes('strict mode')) return `Multiple elements matched. Call snapshot for fresh refs.`
        return `Click failed: ${err.message}. Call snapshot to get fresh refs.`
      }
    }

    case 'type': {
      await onProgress(`⌨️ Typing "${input.text}"...`)
      const refs = pageRefs.get(userId) || {}
      const info = refs[input.ref]
      if (!info) return `Unknown ref ${input.ref}. Call snapshot first.`
      const locator = info.name
        ? page.getByRole(info.role as any, { name: info.name, exact: true })
        : page.getByRole(info.role as any)
      await locator.fill(input.text, { timeout: 8000 })
      if (input.submit) await page.keyboard.press('Enter')
      await new Promise(r => setTimeout(r, 500))
      const content = await page.evaluate(() => {
        const main = document.querySelector('main,article,[role="main"]') as HTMLElement
        return (main || document.body).innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000)
      })
      return `Typed "${input.text}". Page:\n${content}`
    }

    case 'scroll': {
      const delta = input.direction === 'down' ? (input.amount || 400) : -(input.amount || 400)
      await page.evaluate(`window.scrollBy(0, ${delta})`)
      await new Promise(r => setTimeout(r, 300))
      return `Scrolled ${input.direction}`
    }

    case 'key_press': {
      await onProgress(`⌨️ Pressing ${input.key}...`)
      await page.keyboard.press(input.key)
      await new Promise(r => setTimeout(r, 300))
      return `Pressed ${input.key}`
    }

    case 'dismiss_cookie': {
      await onProgress('🍪 Dismissing cookie popup...')
      const result = await page.evaluate(() => {
        const SELS = ['#onetrust-reject-all-handler','#onetrust-accept-btn-handler','button[id*="reject"]','button[id*="decline"]','button[id*="accept"]','button[class*="reject"]','button[class*="cookie"]','.cc-dismiss','.cc-btn','[id*="cookie"] button','[id*="consent"] button']
        for (const sel of SELS) {
          const el = document.querySelector(sel) as HTMLElement
          if (el && el.offsetParent !== null) { el.click(); return `Clicked: ${sel}` }
        }
        const overlays = ['#onetrust-consent-sdk','.onetrust-pc-dark-filter','[id*="cookie-banner"]','.cc-window','#CybotCookiebotDialog']
        let removed = 0
        overlays.forEach(sel => { document.querySelectorAll(sel).forEach(el => { el.remove(); removed++ }) })
        return removed > 0 ? `Removed ${removed} overlays` : 'No cookie popup found'
      })
      await new Promise(r => setTimeout(r, 600))
      return `Cookie handled: ${result}`
    }

    case 'wait': {
      await new Promise(r => setTimeout(r, Math.min(input.ms || 1000, 8000)))
      return `Waited ${input.ms}ms`
    }

    case 'ask_permission': {
      await onProgress(`🔐 Asking permission: ${input.action}`)
      // Store permission request in Supabase
      const { error: permissionInsertError } = await supabase.from('task_permissions' as any).insert({
        task_id: taskId,
        action: input.action,
        details: input.details,
        status: 'pending'
      })
      // Keep previous behavior: continue even if logging the permission request fails.
      void permissionInsertError
      // Update task status
      await supabase.from('tasks').update({ status: 'waiting_permission' }).eq('id', taskId)
      // Wait for response (poll every 2 seconds, max 5 minutes)
      for (let i = 0; i < 150; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const { data } = await supabase
          .from('task_permissions' as any)
          .select('status')
          .eq('task_id', taskId)
          .order('created_at', { ascending: false })
          .limit(1)
          .single()
        if (data?.status === 'approved') {
          await supabase.from('tasks').update({ status: 'running' }).eq('id', taskId)
          return 'User approved. Proceed.'
        }
        if (data?.status === 'denied') {
          await supabase.from('tasks').update({ status: 'running' }).eq('id', taskId)
          return 'User denied. Stop this action and ask what they want to do instead.'
        }
      }
      return 'Permission request timed out. Stop the action.'
    }

    default:
      return `Unknown tool: ${toolName}`
  }
}

// ─── System Prompt ────────────────────────────────────────────────────────

function buildSystemPrompt(context?: string): string {
  return `You are Unclawned, a powerful personal AI assistant that controls a real Chrome browser.

The user is already logged into all their accounts. You never need to log in.

## Your Capabilities
- Navigate to any website and read its content
- Click, type, scroll, and interact with any element
- Search Google and read full articles
- Fill forms, submit data, interact with web apps
- Ask permission before irreversible actions

## Core Workflow
1. Navigate to the right page — you automatically get page content
2. Use the content to answer or act
3. If you need to click something: call snapshot to get refs, then click
4. For research: navigate to multiple sources and read them with read_page
5. Call task_complete with comprehensive detailed results

## Quality Standards
- Always include real specific data — never vague summaries
- For news: minimum 5 headlines with details each
- For research: actual findings, numbers, quotes from sources
- task_complete must be detailed and complete — minimum 200 words for research

## Permission Rules
Call ask_permission before: submitting forms, sending emails, posting, buying, deleting, or any action that cannot be undone

## Google Search
Navigate to: https://www.google.com/search?q=your+query
You get results automatically — read them and call task_complete

## Error Recovery
- Element blocked by popup → dismiss_cookie
- Element outside viewport → scroll down then snapshot
- Ref not found → snapshot for fresh refs
- Page not loading → wait 2000 then read_page

## Rules
- Never click "Skip to main content"
- Never try to log in
- Always end with task_complete or task_failed

${context ? `## Conversation Context\n${context}` : ''}`
}

// ─── Main agent loop ──────────────────────────────────────────────────────

export async function runAgentV2(
  task: string,
  userId: string,
  onProgress: (msg: string) => Promise<void>,
  taskId?: string,
  keepTabOpen = false,
  abortSignal?: AbortSignal,
  context?: string
): Promise<string> {
  if (abortSignal?.aborted) return 'Task stopped by user.'

  const fullTask = context
    ? `CONVERSATION CONTEXT:\n${context}\n\n---\nCURRENT TASK: ${task}\n\nIf this is a follow-up like "tell me more" or "do it again" — use the conversation context to identify the topic and expand on it.`
    : task

  let newTabId: number | null = null

  try {
    await onProgress('🔌 Connecting to browser...')
    const { sendExtensionMessage } = await import('../index.js')

    await onProgress('🌐 Opening new browser tab...')
    const tabResult = await sendExtensionMessage(userId, 'createAndAttachTab', { url: 'about:blank' }, 60000) as any
    newTabId = tabResult?.tabId ?? null
    if (!newTabId) throw new Error('Extension did not return a tab ID')

    await new Promise(r => setTimeout(r, 1500))
    await onProgress('✅ Tab ready. Starting task...')

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: fullTask }
    ]

    const MAX_TURNS = 30
    const deadline = Date.now() + 240_000

    for (let turn = 0; turn < MAX_TURNS && Date.now() < deadline; turn++) {
      if (abortSignal?.aborted) return 'Task stopped by user.'

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        system: buildSystemPrompt(context),
        tools: TOOLS,
        messages
      })

      messages.push({ role: 'assistant', content: response.content })

      if (response.stop_reason === 'end_turn') {
        const text = response.content.find((b: any) => b.type === 'text')
        return (text as any)?.text || 'Task completed.'
      }

      if (response.stop_reason === 'tool_use') {
        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue

          if (block.name === 'task_complete') {
            const result = (block.input as any).result
            await onProgress(`✅ ${result.slice(0, 100)}...`)
            return result
          }

          if (block.name === 'task_failed') {
            return `Task failed: ${(block.input as any).reason}`
          }

          const result = await executeTool(
            block.name,
            block.input as Record<string, any>,
            userId,
            taskId || '',
            onProgress
          )

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result
          })
        }

        messages.push({ role: 'user', content: toolResults })
      }
    }

    return 'Task exceeded time limit.'

  } catch (err: any) {
    return `Error: ${err.message}`
  } finally {
    if (!keepTabOpen && newTabId) {
      try {
        const { sendExtensionMessage } = await import('../index.js')
        await sendExtensionMessage(userId, 'closeTab', { tabId: newTabId })
      } catch {}
    }
    try {
      await supabase.from('task_executions').insert({
        user_id: userId,
        task_id: taskId || null,
        task_prompt: task,
        status: 'done',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 0
      })
    } catch {}
  }
}