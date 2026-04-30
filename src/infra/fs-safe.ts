export class SafeOpenError extends Error {}
export async function openFileWithinRoot(): Promise<never> {
  throw new SafeOpenError('Not implemented')
}
