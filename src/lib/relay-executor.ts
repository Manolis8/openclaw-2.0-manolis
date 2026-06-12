import { ExecutionPlan, ExecutionStep, ExecutionResult, StepUpdate } from './types.js'
import {
  navigateTo,
  clickRef,
  typeInRefSmart,
  snapshotPage,
  selectOption,
  pressKey,
} from './browser-primitives.js'

export class RelayExecutor {
  async execute(
    plan: ExecutionPlan,
    userId: string,
    inputValues: Record<string, string>,
    onStepUpdate?: (update: StepUpdate) => void
  ): Promise<ExecutionResult> {
    const startTime = Date.now()
    const log: StepUpdate[] = []

    try {
      console.log(`[RelayExecutor] Starting execution for user: ${userId}`)

      for (const step of plan.steps) {
        const stepStartTime = Date.now()

        try {
          const runningUpdate: StepUpdate = {
            stepNumber: step.number,
            action: step.action,
            status: 'running',
            timestamp: new Date().toISOString(),
          }
          log.push(runningUpdate)
          onStepUpdate?.(runningUpdate)

          await this.executeStepWithRetry(step, userId, inputValues, plan.errorHandling.maxRetries)

          const successUpdate: StepUpdate = {
            stepNumber: step.number,
            action: step.action,
            status: 'success',
            duration: Date.now() - stepStartTime,
            timestamp: new Date().toISOString(),
          }
          log[log.length - 1] = successUpdate
          onStepUpdate?.(successUpdate)

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error'

          if (step.onError === 'pause') {
            const pausedUpdate: StepUpdate = {
              stepNumber: step.number,
              action: step.action,
              status: 'paused',
              error: errorMsg,
              timestamp: new Date().toISOString(),
            }
            log[log.length - 1] = pausedUpdate
            onStepUpdate?.(pausedUpdate)

            return {
              success: false,
              log,
              errorMessage: `Paused at step ${step.number}: ${errorMsg}`,
              durationMs: Date.now() - startTime,
            }
          }

          if (step.onError === 'abort') {
            const errorUpdate: StepUpdate = {
              stepNumber: step.number,
              action: step.action,
              status: 'error',
              error: errorMsg,
              timestamp: new Date().toISOString(),
            }
            log[log.length - 1] = errorUpdate
            onStepUpdate?.(errorUpdate)
            throw error
          }

          // 'retry' — step already exhausted retries inside executeStepWithRetry, continue to next
        }
      }

      console.log(`[RelayExecutor] Execution completed in ${Date.now() - startTime}ms`)
      return { success: true, log, durationMs: Date.now() - startTime }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      console.error('[RelayExecutor] Execution failed:', errorMsg)
      return { success: false, log, errorMessage: errorMsg, durationMs: Date.now() - startTime }
    }
  }

  private async executeStepWithRetry(
    step: ExecutionStep,
    userId: string,
    inputValues: Record<string, string>,
    maxRetries: number
  ): Promise<void> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.executeStep(step, userId, inputValues)
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        console.log(`[RelayExecutor] Step ${step.number} attempt ${attempt + 1} failed:`, lastError.message)
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    }

    throw lastError || new Error('Step execution failed')
  }

  private async executeStep(
    step: ExecutionStep,
    userId: string,
    inputValues: Record<string, string>
  ): Promise<void> {
    const timeout = (step.timeout || 10) * 1000

    switch (step.action) {
      case 'navigate':
        await this.runNavigate(step.url!, userId, timeout)
        break

      case 'click':
        await this.runClick(step.selectors, step.fallbackSelectors, step.description, userId, timeout)
        break

      case 'type': {
        const value = this.replaceVariables(step.value || '', inputValues)
        await this.runType(step.selectors, step.fallbackSelectors, step.description, value, userId, timeout)
        break
      }

      case 'verify':
        // Snapshot and check for expected text in page
        if (step.expected) await this.runVerify(step.expected, userId, timeout)
        break

      case 'wait': {
        const waitMs = (Number(step.value) || 1) * 1000
        await new Promise(resolve => setTimeout(resolve, waitMs))
        break
      }

      default:
        throw new Error(`Unknown action: ${(step as any).action}`)
    }
  }

  private async runNavigate(url: string, userId: string, timeout: number): Promise<void> {
    console.log(`[RelayExecutor] Navigating to: ${url}`)
    await Promise.race([
      navigateTo(url, userId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Navigation timeout')), timeout)
      ),
    ])
  }

  private async runClick(
    selectors: string[] | undefined,
    fallbackSelectors: string[] | undefined,
    description: string,
    userId: string,
    timeout: number
  ): Promise<void> {
    const allSelectors = [...(selectors || []), ...(fallbackSelectors || [])]
    if (allSelectors.length === 0) throw new Error('No selectors provided for click')

    console.log(`[RelayExecutor] Clicking: ${description}`)

    const snapshot = await Promise.race([
      snapshotPage(userId, '', true),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Snapshot timeout')), timeout)
      ),
    ])

    const ref = this.resolveRefFromSnapshot(snapshot, allSelectors, description)
    if (!ref) {
      throw new Error(`Could not resolve element for click. Tried: ${allSelectors.join(', ')}`)
    }

    console.log(`[RelayExecutor] Clicking ref: ${ref}`)
    await clickRef(userId, ref)
  }

  private async runType(
    selectors: string[] | undefined,
    fallbackSelectors: string[] | undefined,
    description: string,
    value: string,
    userId: string,
    timeout: number
  ): Promise<void> {
    const allSelectors = [...(selectors || []), ...(fallbackSelectors || [])]
    if (allSelectors.length === 0) throw new Error('No selectors provided for type')

    console.log(`[RelayExecutor] Typing into: ${description}`)

    const snapshot = await Promise.race([
      snapshotPage(userId, '', true),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Snapshot timeout')), timeout)
      ),
    ])

    const ref = this.resolveRefFromSnapshot(snapshot, allSelectors, description)
    if (!ref) {
      throw new Error(`Could not resolve element for type. Tried: ${allSelectors.join(', ')}`)
    }

    console.log(`[RelayExecutor] Typing into ref: ${ref}`)
    await typeInRefSmart(userId, ref, value)
  }

  private async runVerify(expected: string, userId: string, timeout: number): Promise<void> {
    console.log(`[RelayExecutor] Verifying: "${expected}"`)

    const snapshot = await Promise.race([
      snapshotPage(userId, '', false),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Snapshot timeout')), timeout)
      ),
    ])

    if (!snapshot.includes(expected)) {
      throw new Error(`Verification failed: expected to find "${expected}" on page`)
    }
  }

  /**
   * Resolve a CSS selector to an ARIA ref by searching the snapshot text.
   *
   * Tries each selector in order using pattern-specific heuristics:
   *   1. :contains("text")  — match by visible text
   *   2. [aria-label*="x"]  — match by aria-label
   *   3. [name="x"]         — match by name attribute / label proximity
   *   4. button / input etc — match by role keyword if only one role appears
   * Falls back to description keyword search if no selector matched.
   */
  private resolveRefFromSnapshot(
    snapshot: string,
    selectors: string[],
    description: string
  ): string | null {
    // Build map: ref → surrounding context (200 chars before, 100 after)
    const refPattern = /\[ref=(e\d+)\]/g
    const refs = new Map<string, string>()
    let m: RegExpExecArray | null
    while ((m = refPattern.exec(snapshot)) !== null) {
      refs.set(m[1], snapshot.substring(Math.max(0, m.index - 200), m.index + 100))
    }

    if (refs.size === 0) return null

    for (const selector of selectors) {
      // :contains("text")
      const containsMatch = selector.match(/:contains\(["']([^"']+)["']\)/)
      if (containsMatch) {
        const found = this.findRefByText(refs, containsMatch[1])
        if (found) return found
      }

      // [aria-label="x"] or [aria-label*="x"] or [aria-label^="x"]
      const ariaMatch = selector.match(/\[aria-label[*^]?=["']([^"']+)["']\]/)
      if (ariaMatch) {
        const found = this.findRefByText(refs, ariaMatch[1])
        if (found) return found
      }

      // [placeholder="x"]
      const placeholderMatch = selector.match(/\[placeholder[*^]?=["']([^"']+)["']\]/)
      if (placeholderMatch) {
        const found = this.findRefByText(refs, placeholderMatch[1])
        if (found) return found
      }

      // [name="x"] or [id="x"] — match against label text or nearby text
      const nameMatch = selector.match(/\[(?:name|id)[*^]?=["']([^"']+)["']\]/)
      if (nameMatch) {
        const found = this.findRefByText(refs, nameMatch[1])
        if (found) return found
      }

      // button[type="submit"] or input[type="submit"] → look for button/submit text
      if (selector.includes('[type="submit"]') || selector.includes('[type=submit]')) {
        const found = this.findRefByText(refs, 'submit') || this.findRefByText(refs, 'Submit')
        if (found) return found
      }
    }

    // Last resort: try keywords from the step description
    const descWords = description
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .split(' ')
      .filter(w => w.length > 3)
    for (const word of descWords) {
      const found = this.findRefByText(refs, word)
      if (found) {
        console.log(`[RelayExecutor] Resolved via description keyword "${word}"`)
        return found
      }
    }

    console.warn(`[RelayExecutor] Could not resolve selectors: ${selectors.join(', ')}`)
    return null
  }

  private findRefByText(refs: Map<string, string>, text: string): string | null {
    const lower = text.toLowerCase()
    for (const [ref, context] of refs) {
      if (context.toLowerCase().includes(lower)) {
        console.log(`[RelayExecutor] Resolved ref ${ref} via text match "${text}"`)
        return ref
      }
    }
    return null
  }

  private replaceVariables(template: string, values: Record<string, string>): string {
    let result = template
    for (const [key, value] of Object.entries(values)) {
      result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value)
    }
    return result
  }
}
