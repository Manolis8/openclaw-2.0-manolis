// Minimal subsystem logger stub
export type SubsystemLogger = {
  subsystem: string
  trace: (message: string, meta?: Record<string, unknown>) => void
  debug: (message: string, meta?: Record<string, unknown>) => void
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void 
  error: (message: string, meta?: Record<string, unknown>) => void
}

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  return {
    subsystem,
    trace: (msg, meta) => console.log(`[${subsystem}] TRACE: ${msg}`, meta || ''),
    debug: (msg, meta) => console.log(`[${subsystem}] DEBUG: ${msg}`, meta || ''),
    info: (msg, meta) => console.log(`[${subsystem}] INFO: ${msg}`, meta || ''),
    warn: (msg, meta) => console.log(`[${subsystem}] WARN: ${msg}`, meta || ''),
    error: (msg, meta) => console.error(`[${subsystem}] ERROR: ${msg}`, meta || '')
  }
}