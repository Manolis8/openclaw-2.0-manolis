// Stub — extension relay only, no Chrome executable management
export type RunningChrome = {
  pid: number
  cdpUrl: string
  exe: string
  userDataDir: string
  proc: any
}

export async function getChromeWebSocketUrl(...args: any[]): Promise<string> {
  throw new Error('Chrome executable mode not supported')
}
export async function launchOpenClawChrome(opts: unknown): Promise<RunningChrome> {
  throw new Error('Chrome executable mode not supported')
}
export async function stopOpenClawChrome(opts: unknown): Promise<void> {}
export async function isChromeCdpReady(opts: unknown): Promise<boolean> { return false }
export async function isChromeReachable(opts: unknown): Promise<boolean> { return false }
export async function findChromeExecutableMac(): Promise<string | null> { return null }
export async function findChromeExecutableWindows(): Promise<string | null> { return null }
export async function resolveBrowserExecutableForPlatform(): Promise<string | null> { return null }
export async function ensureProfileCleanExit(opts: unknown): Promise<void> {}
export async function decorateOpenClawProfile(opts: unknown): Promise<void> {}
export function resolveOpenClawUserDataDir(opts?: unknown): string { return '/tmp/openclaw' }