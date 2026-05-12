// loop-detection.ts
// Detect when agent is stuck repeating actions without progress

interface ToolCallRecord {
  toolName: string
  argsHash: string
  resultHash?: string
  timestamp: number
}

interface LoopDetectionState {
  toolHistory: ToolCallRecord[]
}

// Simple hash of params
function hashParams(params: any): string {
  return JSON.stringify(params).slice(0, 100)
}

// Simple hash of result
function hashResult(result: any): string {
  if (typeof result === 'string') {
    return result.slice(0, 100)
  }
  return JSON.stringify(result).slice(0, 100)
}

export class LoopDetector {
  private state: LoopDetectionState = { toolHistory: [] }
  private readonly MAX_HISTORY = 50

  recordToolCall(toolName: string, params: any): void {
    this.state.toolHistory.push({
      toolName,
      argsHash: hashParams(params),
      timestamp: Date.now(),
    })

    // Keep only last 50 calls
    if (this.state.toolHistory.length > this.MAX_HISTORY) {
      this.state.toolHistory.shift()
    }
  }

  recordToolOutcome(toolName: string, params: any, result: any): void {
    const argsHash = hashParams(params)
    const resultHash = hashResult(result)

    // Find the matching call and add result
    for (let i = this.state.toolHistory.length - 1; i >= 0; i--) {
      const call = this.state.toolHistory[i]
      if (call.toolName === toolName && call.argsHash === argsHash && !call.resultHash) {
        call.resultHash = resultHash
        break
      }
    }
  }

  checkForLoop(toolName: string, params: any): { stuck: boolean; warning?: string } {
    const argsHash = hashParams(params)
    const history = this.state.toolHistory

    // Special handling for browser_evaluate - data extraction attempts
    if (toolName === 'browser_evaluate') {
      const evaluateCalls = history.filter(h => h.toolName === 'browser_evaluate')
      const lastResult = evaluateCalls[evaluateCalls.length - 1]?.resultHash

      const sameResultCount = evaluateCalls
        .slice(-5)
        .filter(h => h.resultHash === lastResult).length

      if (sameResultCount >= 4) {
        return {
          stuck: true,
          warning: `⚠️ You've tried to extract data 4 times with no change. The information might not be on this page. Try navigating elsewhere or call task_failed.`,
        }
      }
    }

    // Special handling for browser_click - same button clicked repeatedly
    if (toolName === 'browser_click') {
      const clickCalls = history.filter(h => h.toolName === 'browser_click')
      const lastClickResult = clickCalls[clickCalls.length - 1]?.resultHash

      const sameClickCount = clickCalls
        .slice(-4)
        .filter(h => h.argsHash === argsHash && h.resultHash === lastClickResult).length

      if (sameClickCount >= 3) {
        return {
          stuck: true,
          warning: `⚠️ You clicked this element 3 times with no effect. Try a different approach or call task_failed.`,
        }
      }
    }

    // Detect ping pong - alternating between 2 actions
    if (history.length >= 6) {
      const last = history[history.length - 1]
      const secondLast = history[history.length - 2]

      if (last && secondLast && last.argsHash !== secondLast.argsHash) {
        // Check if alternating
        let alternatingCount = 0
        for (let i = history.length - 1; i >= Math.max(0, history.length - 6); i--) {
          const call = history[i]
          if (!call) continue
          
          const expected = alternatingCount % 2 === 0 ? last.argsHash : secondLast.argsHash
          if (call.argsHash !== expected) break
          alternatingCount++
        }

        if (alternatingCount >= 6) {
          return {
            stuck: true,
            warning: `⚠️ You're alternating between the same actions repeatedly with no progress. This looks like a stuck loop. Call task_failed.`,
          }
        }
      }
    }

    return { stuck: false }
  }
}

export function createLoopDetector(): LoopDetector {
  return new LoopDetector()
}