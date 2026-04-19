export function formatMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`
  if (ms < 1_000) return `${ms.toFixed(1)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)}s`
  return `${(ms / 60_000).toFixed(2)}m`
}
