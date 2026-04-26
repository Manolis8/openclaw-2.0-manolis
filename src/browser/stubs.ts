// Stubs for OpenClaw infra dependencies not needed in this project

// From ../infra/ws.js
export function rawDataToString(data: unknown): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return String(data)
}

// From ../infra/net/ssrf.js — no SSRF restrictions needed
// Additional SsrFPolicy fields OpenClaw uses
export type SsrFPolicy = {
  allowPrivateNetworks?: boolean
  allowPrivateNetwork?: boolean
  allowedOrigins?: string[]
  blockedOrigins?: string[]
  allowLoopback?: boolean
  blockFileUrls?: boolean
  hostnameAllowlist?: string[]
  allowedHostnames?: string[]
  dangerouslyAllowPrivateNetwork?: boolean
}
export type LookupFn = (hostname: string) => Promise<string[]>

export function isPrivateNetworkAllowedByPolicy(policy?: SsrFPolicy): boolean {
  return true // allow all in this context
}

export async function resolvePinnedHostnameWithPolicy(
  hostname: string,
  opts?: { lookupFn?: LookupFn; policy?: SsrFPolicy }
): Promise<void> {
  // no restrictions
}

export function withBrowserNavigationPolicy(ssrfPolicy?: SsrFPolicy) {
  return ssrfPolicy ? { ssrfPolicy } : {}
}

export function assertBrowserNavigationAllowed(opts: { url: string }): Promise<void> {
  return Promise.resolve() // allow all navigation
}

export function assertBrowserNavigationResultAllowed(opts: { url: string }): Promise<void> {
  return Promise.resolve()
}

export class SsrFBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrFBlockedError'
  }
}

export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidBrowserNavigationUrlError'
  }
}

// From ../gateway/net.js
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

// From ../infra/errors.js
export function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// From ../config/config.js — stub
export const CONFIG_DIR = '/tmp'
export function getConfig(): any { return {} }
export function resolveConfig(): any { return {} }

// From ../config/paths.js — stub
export function resolveOpenClawDataDir(): string { return '/tmp/openclaw' }
export function getBrowserExecutablePath(): string | null { return null }

// From ../config/port-defaults.js — stub
export const DEFAULT_PORTS = { extension: 9223 }

// From ../cli/command-format.js — stub
export function formatCommandOutput(data: unknown): string { return String(data) }

// From ../media/store.js — stub
export function createMediaStore(): any { return {} }

// From ../media/image-ops.js — stub
export function resizeImage(): Promise<Buffer> { return Promise.resolve(Buffer.alloc(0)) }

// From ../infra/fs-safe.js — stub
export function ensureDirectory(): Promise<void> { return Promise.resolve() }
export function writeFileAtomic(): Promise<void> { return Promise.resolve() }

// From ../infra/path-guards.js — stub
export function isPathWithin(): boolean { return true }

// From ../infra/tmp-openclaw-dir.js — stub
export function createTmpDir(): Promise<string> { return Promise.resolve('/tmp') }

// From ../infra/secure-random.js — stub
export function randomBytes(): Buffer { return Buffer.alloc(16) }

// From ../process/exec.js — stub
export function execCommand(): Promise<{ stdout: string; stderr: string }> { return Promise.resolve({ stdout: '', stderr: '' }) }

// From ../security/secret-equal.js — stub
export function secureCompare(a: string, b: string): boolean { return a === b }

// From ../../utils.js — stub
export function getUtils(): any { return {} }

// From ../../utils/boolean.js — stub
export function isTruthy(): boolean { return true }

// From ../test-utils/fetch-mock.js — stub (for tests)
export function createFetchMock(): any { return {} }