import { chromium, Browser, Page, BrowserContext } from 'playwright'
import { ExecutionPlan, StepUpdate, ExecutionResult } from './types.js'

export class PlaywrightExecutor {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null

  async execute(
    plan: ExecutionPlan,
    inputValues: Record<string, string>,
    onStepUpdate?: (update: StepUpdate) => void
  ): Promise<ExecutionResult> {
    const startTime = Date.now()
    const log: StepUpdate[] = []

    try {
      await this.launch()

      for (const step of plan.steps) {
        const stepStartTime = Date.now()

        try {
          const runningUpdate: StepUpdate = {
            stepNumber: step.number,
            action: step.action,
            status: 'running',
            timestamp: new Date().toISOString()
          }
          log.push(runningUpdate)
          onStepUpdate?.(runningUpdate)

          await this.executeStepWithRetry(step, inputValues, plan.errorHandling.maxRetries)

          const duration = Date.now() - stepStartTime
          const successUpdate: StepUpdate = {
            stepNumber: step.number,
            action: step.action,
            status: 'success',
            duration,
            timestamp: new Date().toISOString()
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
              timestamp: new Date().toISOString()
            }
            log[log.length - 1] = pausedUpdate
            onStepUpdate?.(pausedUpdate)

            return {
              success: false,
              log,
              errorMessage: `Paused at step ${step.number}: ${errorMsg}`,
              durationMs: Date.now() - startTime
            }
          }

          if (step.onError === 'abort') {
            const errorUpdate: StepUpdate = {
              stepNumber: step.number,
              action: step.action,
              status: 'error',
              error: errorMsg,
              timestamp: new Date().toISOString()
            }
            log[log.length - 1] = errorUpdate
            onStepUpdate?.(errorUpdate)

            throw error
          }
        }
      }

      const finalUrl = this.page?.url() || ''
      console.log(`[Playwright] Execution completed in ${Date.now() - startTime}ms`)

      return { success: true, log, finalUrl, durationMs: Date.now() - startTime }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      console.error('[Playwright] Execution failed:', errorMsg)
      return { success: false, log, errorMessage: errorMsg, durationMs: Date.now() - startTime }

    } finally {
      await this.cleanup()
    }
  }

  private async executeStepWithRetry(
    step: any,
    inputValues: Record<string, string>,
    maxRetries: number
  ): Promise<void> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.executeStep(step, inputValues)
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        console.log(`[Playwright] Step ${step.number} attempt ${attempt + 1} failed:`, lastError.message)
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    }

    throw lastError || new Error('Step execution failed')
  }

  private async executeStep(step: any, inputValues: Record<string, string>): Promise<void> {
    if (!this.page) throw new Error('Page not initialized')

    const timeout = (step.timeout || 10) * 1000

    switch (step.action) {
      case 'navigate':
        await this.navigate(step.url, timeout)
        break

      case 'click':
        await this.click(step.selectors, step.fallbackSelectors, timeout)
        break

      case 'type': {
        const value = this.replaceVariables(step.value, inputValues)
        await this.type(step.selectors, step.fallbackSelectors, value, timeout)
        break
      }

      case 'verify':
        if (step.expected) await this.verify(step.expected, timeout)
        break

      case 'wait': {
        const waitMs = (Number(step.value) || 1) * 1000
        await new Promise(resolve => setTimeout(resolve, waitMs))
        break
      }

      default:
        throw new Error(`Unknown action: ${step.action}`)
    }
  }

  private async navigate(url: string, timeout: number): Promise<void> {
    if (!this.page) throw new Error('Page not initialized')
    console.log(`[Playwright] Navigating to: ${url}`)
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout })
      await this.page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 5000) })
        .catch(() => {})
    } catch (error) {
      throw new Error(`Failed to navigate to ${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async click(
    selectors: string[],
    fallbackSelectors: string[] | undefined,
    timeout: number
  ): Promise<void> {
    if (!this.page) throw new Error('Page not initialized')
    const allSelectors = [...(selectors || []), ...(fallbackSelectors || [])]

    for (const selector of allSelectors) {
      try {
        const element = await this.page.$(selector)
        if (element) {
          console.log(`[Playwright] Clicking: ${selector}`)
          await element.click({ timeout })
          return
        }
      } catch {
        // try next selector
      }
    }

    throw new Error(`Could not find element to click. Tried: ${allSelectors.join(', ')}`)
  }

  private async type(
    selectors: string[],
    fallbackSelectors: string[] | undefined,
    value: string,
    timeout: number
  ): Promise<void> {
    if (!this.page) throw new Error('Page not initialized')
    const allSelectors = [...(selectors || []), ...(fallbackSelectors || [])]

    for (const selector of allSelectors) {
      try {
        const element = await this.page.$(selector)
        if (element) {
          console.log(`[Playwright] Typing into: ${selector}`)
          await element.evaluate((el: any) => { el.value = '' })
          await element.type(value, { delay: 50 })
          return
        }
      } catch {
        // try next selector
      }
    }

    throw new Error(`Could not find element to type in. Tried: ${allSelectors.join(', ')}`)
  }

  private async verify(expected: string, timeout: number): Promise<void> {
    if (!this.page) throw new Error('Page not initialized')
    console.log(`[Playwright] Verifying: ${expected}`)
    try {
      await this.page.waitForFunction(
        (text: string) => document.body.innerText.includes(text),
        expected,
        { timeout }
      )
    } catch {
      throw new Error(`Verification failed: Expected to find "${expected}" on page`)
    }
  }

  private replaceVariables(template: string, values: Record<string, string>): string {
    let result = template
    for (const [key, value] of Object.entries(values)) {
      result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value)
    }
    return result
  }

  private async launch(): Promise<void> {
    console.log('[Playwright] Launching browser...')
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    })
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    })
    this.page = await this.context.newPage()
    this.page.setDefaultTimeout(10000)
    this.page.setDefaultNavigationTimeout(10000)
    console.log('[Playwright] Browser launched')
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.context) await this.context.close()
      if (this.browser) await this.browser.close()
      console.log('[Playwright] Browser closed')
    } catch (error) {
      console.error('[Playwright] Error during cleanup:', error)
    }
  }
}
