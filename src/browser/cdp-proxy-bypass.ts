// Stub — no proxy bypass needed
export function withNoProxyForCdpUrl<T>(cdpUrl: string, fn: () => Promise<T>): Promise<T> {
  return fn()
}
export function withNoProxyForLocalhost<T>(fn: () => Promise<T>): Promise<T> {
  return fn()
}
export function getDirectAgentForCdp(cdpUrl: string): unknown { return null }
export function hasProxyEnv(): boolean { return false }
export function hasProxyEnvConfigured(): boolean { return false }