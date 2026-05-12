// compaction.ts
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function estimateMessageTokens(msg: any): number {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  return estimateTokens(content) + (msg.tool_calls ? estimateTokens(JSON.stringify(msg.tool_calls)) : 0)
}

function estimateMessagesTokens(messages: any[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}

function stripSnapshotDetails(messages: any[]): any[] {
  return messages.map(msg => {
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      let summary = msg.content
      summary = summary.replace(/\[snapshot:openclaw\].*/g, '[snapshot: taken]')
      summary = summary.replace(/refs=\d+.*?interactive=true/g, '[refs available]')
      return { ...msg, content: summary }
    }
    return msg
  })
}

function summarizeOldMessages(messages: any[]): string {
  // Find the task_complete message (what was shown to user)
  let taskResult = ''
  
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string' ? msg.content : ''
      // Look for task_complete message (starts with ✅)
      if (content.includes('✅')) {
        const match = content.match(/✅ (.+)/)
        taskResult = match?.[1] || 'Task completed'
        break
      }
    }
  }
  
  // If we found a task result, return just that (what was shown to user)
  if (taskResult) {
    return `Previous task result: ✅ ${taskResult}`
  }
  
  // If no task_complete found, return neutral message
  return `Previous task context available`
}

export function compactMessages(
  messages: any[],
  maxTokens: number = 8000,
  keepRecentCount: number = 10
): any[] {  // ← EXPLICIT return type
  if (messages.length === 0) return messages
  
  const totalTokens = estimateMessagesTokens(messages)
  
  if (totalTokens <= maxTokens) {
    return stripSnapshotDetails(messages)
  }
  
  const systemMsg = messages[0]
  const rest = messages.slice(1)
  
  const recentCount = Math.min(keepRecentCount, rest.length)
  const recentMsgs = rest.slice(-recentCount)
  const oldMsgs = rest.slice(0, -recentCount)
  
  if (oldMsgs.length === 0) {
    return [systemMsg, ...stripSnapshotDetails(recentMsgs)]
  }
  
  const historySummary = summarizeOldMessages(oldMsgs)
  
  const compacted: any[] = [  // ← EXPLICIT type
    systemMsg,
    {
      role: 'user',
      content: historySummary
    },
    ...stripSnapshotDetails(recentMsgs)
  ]
  
  const compactedTokens = estimateMessagesTokens(compacted)
  
  if (compactedTokens > maxTokens && recentMsgs.length > 3) {
    const furtherReduced = compacted.slice(0, 2).concat(compacted.slice(-3))
    return furtherReduced
  }
  
  return compacted
}

export function logTokenUsage(messages: any[], label: string = 'Messages'): void {
  const tokens = estimateMessagesTokens(messages)
  console.log(`[tokens] ${label}: ${messages.length} messages, ~${tokens} tokens`)
}