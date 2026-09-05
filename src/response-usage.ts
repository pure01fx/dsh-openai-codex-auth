/** Bounded per-response usage metadata emitted by the Codex Responses API. */

const MAX_AMOUNT_BYTES = 256
const MAX_RAW_USAGE_BYTES = 64 * 1024

export interface CodexResponseUsageMetadata {
  /** Exact provider representation; never coerce this high-precision value to a number. */
  amount?: string
  /** Complete bounded `response.usage` JSON, including fields unknown to this client. */
  metadata?: unknown
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

function boundedJson(value: unknown): unknown | undefined {
  if (value === undefined || value === null) return undefined
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined || Buffer.byteLength(encoded) > MAX_RAW_USAGE_BYTES) return undefined
    return JSON.parse(encoded) as unknown
  } catch {
    return undefined
  }
}

/** Preserve exact billing amount and the complete bounded response.usage payload. */
export function parseCodexResponseUsageMetadata(value: unknown): CodexResponseUsageMetadata | undefined {
  const event = record(value)
  if (event?.type !== 'response.completed') return undefined
  const response = record(event.response)
  const usageMetadata = record(response?.usage_metadata)
  const rawAmount = usageMetadata?.amount
  const amount = typeof rawAmount === 'string' && rawAmount.length > 0
      && Buffer.byteLength(rawAmount) <= MAX_AMOUNT_BYTES
    ? rawAmount : undefined
  const metadata = boundedJson(response?.usage)
  if (amount === undefined && metadata === undefined) return undefined
  return {
    ...amount === undefined ? {} : { amount },
    ...metadata === undefined ? {} : { metadata },
  }
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
