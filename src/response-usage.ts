/** Bounded per-response usage metadata emitted by the Codex Responses API. */

const MAX_AMOUNT_BYTES = 256

export interface CodexResponseUsageMetadata {
  /** Exact provider representation; never coerce this high-precision value to a number. */
  amount: string
}

export interface CodexResponseUsageObservation {
  accountId: string
  metadata: CodexResponseUsageMetadata
}

export type CodexResponseUsageCallback = (observation: CodexResponseUsageObservation) => void

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Parse only response.completed usage_metadata.amount and preserve its exact string value. */
export function parseCodexResponseUsageMetadata(value: unknown): CodexResponseUsageMetadata | undefined {
  const event = record(value)
  if (event?.type !== 'response.completed') return undefined
  const response = record(event.response)
  const metadata = record(response?.usage_metadata)
  const amount = metadata?.amount
  if (typeof amount !== 'string' || amount.length === 0
    || Buffer.byteLength(amount) > MAX_AMOUNT_BYTES) return undefined
  return { amount }
}

/** Publish optional response usage without allowing diagnostics to fail generation. */
export function publishCodexResponseUsage(
  accountId: string,
  metadata: CodexResponseUsageMetadata | undefined,
  callback: CodexResponseUsageCallback | undefined,
  warn: ((message: string) => void) | undefined,
): void {
  if (metadata === undefined || callback === undefined) return
  try {
    callback({ accountId, metadata })
  } catch {
    try { warn?.('native Codex response usage metadata could not be published') } catch {
      // Per-response usage is observational and must never fail generation.
    }
  }
}
