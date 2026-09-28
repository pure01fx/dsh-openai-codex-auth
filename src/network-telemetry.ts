/** Process-wide, content-free inference telemetry. All mutations are synchronous. */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
export type NetworkState = 'preparing' | 'connecting' | 'waiting' | 'streaming' | 'retrying' | 'completed' | 'failed' | 'cancelled'
export type NetworkTransport = 'http' | 'websocket'
export interface NetworkRequest {
  id: string
  state: NetworkState
  transport: NetworkTransport
  startedAt: number
  lastActivityAt: number | null
  lastOutputAt: number | null
  retryAt: number | null
  retryKind: 'transient' | 'connection' | null
  retries: number
  receivedBytes: number
  attempts: number
}
export interface NetworkSnapshot {
  scope: 'process'
  startedAt: number
  updatedAt: number
  activeCount: number
  totals: { requests: number; succeeded: number; failed: number; cancelled: number; retries: number; receivedBytes: number }
  requests: NetworkRequest[]
  truncated: boolean
}
export interface NetworkRequestHandle {
  state(state: 'preparing' | 'waiting'): void
  attempt(transport: NetworkTransport): void
  activity(bytes?: number): void
  output(): void
  retry(delayMs: number, kind?: 'transient' | 'connection'): void
  finish(state: 'completed' | 'failed' | 'cancelled'): void
}

/** Keeps at most limit records, preferentially evicting terminal records. Handles
 * remain owned by running generators; overflow never loses aggregate accounting.
 * No timers, request content, external identifiers, or errors are retained. */
export class NetworkTelemetry {
  private readonly rows = new Map<string, NetworkRequest>()
  private readonly startedAt: number
  private activeCount = 0
  private sequence = 0
  private evicted = false
  private readonly totals = { requests: 0, succeeded: 0, failed: 0, cancelled: 0, retries: 0, receivedBytes: 0 }
  constructor(private readonly limit = 128, private readonly now = Date.now) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid telemetry limit')
    this.startedAt = now()
  }
  begin(transport: NetworkTransport): NetworkRequestHandle {
    const row: NetworkRequest = {
      id: String(++this.sequence), state: 'preparing', transport, startedAt: this.now(),
      lastActivityAt: null, lastOutputAt: null, retryAt: null, retryKind: null, retries: 0, receivedBytes: 0, attempts: 0,
    }
    if (this.rows.size >= this.limit) {
      const terminal = [...this.rows.values()].find(item => ['completed', 'failed', 'cancelled'].includes(item.state))
      this.rows.delete(terminal?.id ?? this.rows.keys().next().value!)
      this.evicted = true
    }
    this.rows.set(row.id, row)
    this.activeCount++
    this.totals.requests++
    let finished = false
    const mutate = (fn: () => void): void => {
      if (finished) return
      fn()
    }
    return {
      state: state => mutate(() => { row.state = state; row.retryAt = null; if (state === 'waiting') row.retryKind = null }),
      attempt: transport => mutate(() => {
        row.transport = transport; row.state = 'connecting'; row.retryAt = null; row.attempts++
      }),
      activity: (bytes = 0) => mutate(() => {
        row.lastActivityAt = this.now()
        if (Number.isSafeInteger(bytes) && bytes > 0) {
          row.receivedBytes += bytes; this.totals.receivedBytes += bytes
        }
      }),
      output: () => mutate(() => { row.state = 'streaming'; row.retryKind = null; row.lastOutputAt = this.now() }),
      retry: (delayMs, kind = 'transient') => mutate(() => {
        row.retryKind = kind
        row.state = 'retrying'; row.retryAt = this.now() + Math.max(0, delayMs)
        row.retries++; this.totals.retries++
      }),
      finish: state => mutate(() => {
        row.state = state; row.retryAt = null; row.retryKind = null; this.activeCount--
        this.totals[state === 'completed' ? 'succeeded' : state]++
        finished = true
      }),
    }
  }
  snapshot(): NetworkSnapshot {
    return {
      scope: 'process', startedAt: this.startedAt, updatedAt: this.now(),
      activeCount: this.activeCount, totals: { ...this.totals },
      requests: [...this.rows.values()].reverse().map(row => ({ ...row })), truncated: this.evicted,
    }
  }
}
export const networkTelemetry = new NetworkTelemetry()

export function observeNetworkOutput(handle: NetworkRequestHandle, chunk: StreamChunk): void {
  if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0
    || chunk.type === 'tool-call-delta') handle.output()
  if (chunk.type === 'finish' && chunk.reason.kind === 'error') handle.finish('failed')
}

/** Generator return/break is cancellation; fallback delegates with the same handle. */
export async function* trackNetwork<T>(
  telemetry: NetworkTelemetry, transport: NetworkTransport, signal: AbortSignal | undefined,
  run: (handle: NetworkRequestHandle) => AsyncIterable<T>,
): AsyncIterable<T> {
  const handle = telemetry.begin(transport)
  try {
    yield* run(handle)
    handle.finish('completed')
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    handle.finish(signal?.aborted || code === 'ABORTED' || code === 'DISPOSED' ? 'cancelled' : 'failed')
    throw error
  } finally {
    handle.finish('cancelled')
  }
}
