import { SsrFBlockedError, InvalidBrowserNavigationUrlError, type SsrFPolicy } from './stubs.js'

export { SsrFBlockedError, InvalidBrowserNavigationUrlError }
export type { SsrFPolicy }
export type LookupFn = (hostname: string) => Promise<string[]>

const NETWORK_NAVIGATION_PROTOCOLS = new Set(['http:', 'https:'])
const SAFE_NON_NETWORK_URLS = new Set(['about:blank'])

export type BrowserNavigationPolicyOptions = { ssrfPolicy?: SsrFPolicy }

export function withBrowserNavigationPolicy(ssrfPolicy?: SsrFPolicy): BrowserNavigationPolicyOptions {
  return ssrfPolicy ? { ssrfPolicy } : {}
}

export async function assertBrowserNavigationAllowed(opts: {
  url: string
  lookupFn?: LookupFn
} & BrowserNavigationPolicyOptions): Promise<void> {
  const rawUrl = String(opts.url ?? '').trim()
  if (!rawUrl) throw new InvalidBrowserNavigationUrlError('url is required')
  let parsed: URL
  try { parsed = new URL(rawUrl) } catch {
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`)
  }
  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    if (SAFE_NON_NETWORK_URLS.has(parsed.href)) return
    throw new InvalidBrowserNavigationUrlError(`Navigation blocked: unsupported protocol "${parsed.protocol}"`)
  }
  // No SSRF restrictions in this context
}

export async function assertBrowserNavigationResultAllowed(opts: {
  url: string
  lookupFn?: LookupFn
} & BrowserNavigationPolicyOptions): Promise<void> {
  const rawUrl = String(opts.url ?? '').trim()
  if (!rawUrl) return
  let parsed: URL
  try { parsed = new URL(rawUrl) } catch { return }
  if (NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) || SAFE_NON_NETWORK_URLS.has(parsed.href)) {
    await assertBrowserNavigationAllowed(opts)
  }
}