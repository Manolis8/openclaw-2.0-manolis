import { ExecutionPlan, ExecutionStep, ExecutionResult, StepUpdate } from './types.js'
import { getRelayPage } from './relay-browser.js'
import { snapshotRoleViaPlaywright } from '../browser/pw-tools-core.snapshot.js'
import {
  clickViaPlaywright,
  typeViaPlaywright,
} from '../browser/pw-tools-core.interactions.js'
import type { RoleRefMap } from '../browser/pw-role-snapshot.js'

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

          // 'retry' — already exhausted inside executeStepWithRetry, continue to next step
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
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000))
      }
    }
    throw lastError || new Error('Step execution failed')
  }

  private async executeStep(
    step: ExecutionStep,
    userId: string,
    inputValues: Record<string, string>
  ): Promise<void> {
    const timeoutMs = (step.timeout || 10) * 1000

    switch (step.action) {
      case 'navigate':
        await this.runNavigate(step.url!, userId, timeoutMs)
        break

      case 'click':
        await this.runInteract('click', step.selectors, step.fallbackSelectors, step.description, undefined, userId, timeoutMs)
        break

      case 'type': {
        const value = this.replaceVariables(step.value || '', inputValues)
        await this.runInteract('type', step.selectors, step.fallbackSelectors, step.description, value, userId, timeoutMs)
        break
      }

      case 'verify':
        if (step.expected) await this.runVerify(step.expected, userId, timeoutMs)
        break

      case 'wait': {
        const waitMs = (Number(step.value) || 1) * 1000
        await new Promise(r => setTimeout(r, waitMs))
        break
      }

      default:
        throw new Error(`Unknown action: ${(step as any).action}`)
    }
  }

  private async runNavigate(url: string, userId: string, timeoutMs: number): Promise<void> {
    console.log(`[RelayExecutor] Navigating to: ${url}`)
    const { page } = await getRelayPage(userId)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await new Promise(r => setTimeout(r, url.includes('google.com') ? 2000 : 1000))
  }

  private async runInteract(
    action: 'click' | 'type',
    selectors: string[] | undefined,
    fallbackSelectors: string[] | undefined,
    description: string,
    value: string | undefined,
    userId: string,
    timeoutMs: number
  ): Promise<void> {
    const allSelectors = [...(selectors || []), ...(fallbackSelectors || [])]
    if (allSelectors.length === 0) throw new Error(`No selectors provided for ${action}`)

    console.log(`[RelayExecutor] ${action}: ${description}`)

    const { cdpUrl, targetId } = await getRelayPage(userId)

    const { refs } = await snapshotRoleViaPlaywright({
      cdpUrl,
      targetId: targetId || undefined,
      refsMode: 'role',
      options: { interactive: true, compact: true },
    })

    const ref = this.resolveRef(refs, allSelectors, description)
    if (!ref) {
      throw new Error(`Could not find element for ${action}. Tried selectors: ${allSelectors.join(', ')}`)
    }

    console.log(`[RelayExecutor] Resolved to ref: ${ref}`)

    if (action === 'click') {
      await clickViaPlaywright({ cdpUrl, targetId: targetId || undefined, ref, timeoutMs })
      await new Promise(r => setTimeout(r, 800))
    } else {
      await typeViaPlaywright({ cdpUrl, targetId: targetId || undefined, ref, text: value!, slowly: true, timeoutMs })
      await new Promise(r => setTimeout(r, 400))
    }
  }

  private async runVerify(expected: string, userId: string, timeoutMs: number): Promise<void> {
    console.log(`[RelayExecutor] Verifying: "${expected}"`)
    const { cdpUrl, targetId } = await getRelayPage(userId)
    const { snapshot } = await snapshotRoleViaPlaywright({
      cdpUrl,
      targetId: targetId || undefined,
      refsMode: 'role',
      options: { interactive: false, compact: false },
    })
    if (!snapshot.includes(expected)) {
      throw new Error(`Verification failed: expected to find "${expected}" on page`)
    }
  }

  /**
   * Match CSS selectors to an ARIA ref using the role+name map from the snapshot.
   * Uses the RoleRefMap (ref → {role, name}) rather than text-parsing the snapshot string.
   */
  private resolveRef(refs: RoleRefMap, selectors: string[], description: string): string | null {
    for (const selector of selectors) {
      const hint = this.extractNameHint(selector)
      if (!hint) continue

      const roleHint = this.extractRoleHint(selector)

      for (const [ref, info] of Object.entries(refs)) {
        if (!info.name) continue
        const nameMatch = info.name.toLowerCase().includes(hint.toLowerCase())
        const roleMatch = !roleHint || info.role === roleHint
        if (nameMatch && roleMatch) {
          console.log(`[RelayExecutor] Matched ref ${ref} (${info.role} "${info.name}") via selector "${selector}"`)
          return ref
        }
      }
    }

    // Fallback: search by description keywords against accessible names
    const keywords = description
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .split(' ')
      .filter(w => w.length > 3)

    for (const word of keywords) {
      for (const [ref, info] of Object.entries(refs)) {
        if (info.name?.toLowerCase().includes(word.toLowerCase())) {
          console.log(`[RelayExecutor] Matched ref ${ref} (${info.role} "${info.name}") via description keyword "${word}"`)
          return ref
        }
      }
    }

    console.warn(`[RelayExecutor] Could not resolve: ${selectors.join(', ')}`)
    return null
  }

  /**
   * Extract the semantic text hint from a CSS selector.
   * Handles: :contains("x"), [aria-label*="x"], [placeholder="x"], [name="x"], [id="x"]
   */
  private extractNameHint(selector: string): string | null {
    const patterns = [
      /:contains\(["']([^"']+)["']\)/,
      /\[aria-label[*^$]?=["']([^"']+)["']\]/,
      /\[placeholder[*^$]?=["']([^"']+)["']\]/,
      /\[name[*^$]?=["']([^"']+)["']\]/,
      /\[id[*^$]?=["']([^"']+)["']\]/,
      /\[value[*^$]?=["']([^"']+)["']\]/,
      /\[title[*^$]?=["']([^"']+)["']\]/,
    ]
    for (const p of patterns) {
      const m = selector.match(p)
      if (m) return m[1]
    }
    return null
  }

  /**
   * Map element-type prefixes in a selector to ARIA roles.
   */
  private extractRoleHint(selector: string): string | null {
    if (selector.startsWith('button')) return 'button'
    if (selector.startsWith('a[') || selector.startsWith('a ') || selector === 'a') return 'link'
    if (selector.startsWith('input[type="checkbox"]')) return 'checkbox'
    if (selector.startsWith('input[type="radio"]')) return 'radio'
    if (selector.startsWith('select')) return 'combobox'
    if (selector.startsWith('input') || selector.startsWith('textarea')) return 'textbox'
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
