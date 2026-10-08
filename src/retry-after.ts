/** Server advice is separate from the client's bounded exponential backoff. */
import { LlmError } from '@deepseek-ai/dsh-llm'

const deadlines = new WeakMap<LlmError, number>()

function httpDate(value: string): number | undefined {
  const standard = /^([A-Za-z]{3}), ([0-9]{2}) ([A-Za-z]{3}) ([0-9]{4}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) GMT$/.exec(value)
  const obsolete = /^([A-Za-z]+), ([0-9]{2})-([A-Za-z]{3})-([0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) GMT$/.exec(value)
  const ascii = /^([A-Za-z]{3}) ([A-Za-z]{3}) ([ 0-9][0-9]) ([0-9]{2}:[0-9]{2}:[0-9]{2}) ([0-9]{4})$/.exec(value)
  const parts = standard ?? obsolete
  const weekday = parts?.[1] ?? ascii?.[1]
  const day = parts?.[2] ?? ascii?.[3]
  const month = parts?.[3] ?? ascii?.[2]
  const year = parts?.[4] ?? ascii?.[5]
  const time = parts?.[5] ?? ascii?.[4]
  if (!weekday || !day || !month || !year || !time) return undefined
  const timestamp = Date.parse(value.endsWith('GMT') ? value : value + ' GMT')
  if (!Number.isFinite(timestamp)) return undefined
  const date = new Date(timestamp)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const weekdays = obsolete
    ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  // Date.parse normalizes impossible dates; HTTP header parsing must reject them.
  if (date.getUTCDate() !== Number(day) || months[date.getUTCMonth()] !== month
    || weekdays[date.getUTCDay()] !== weekday
    || (obsolete ? date.getUTCFullYear() % 100 : date.getUTCFullYear()) !== Number(year)
    || date.toISOString().slice(11, 19) !== time) return undefined
  return timestamp
}

export function retryAfterMs(raw: unknown): number | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
  const text = String(raw)
  if (/[^\t\x20-\x7e]/.test(text)) return undefined
  const value = text.trim()
  let delay: number
  if (/^\d+$/.test(value)) delay = Number(value) * 1000
  else {
    const timestamp = httpDate(value)
    if (timestamp === undefined) return undefined
    delay = Math.max(0, timestamp - Date.now())
  }
  return Number.isSafeInteger(delay) && delay >= 0 ? delay : undefined
}

export function jsonRetryAfterMs(headers: unknown): number | undefined {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return undefined
  let value: unknown
  // serde_json's ordered map inserts later case variants over earlier ones.
  for (const key of Object.keys(headers).sort()) {
    const raw = (headers as Record<string, unknown>)[key]
    if (key.toLowerCase() === 'retry-after'
      && (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean')
      && !/[^\t\x20-\x7e]/.test(String(raw))) value = raw
  }
  return retryAfterMs(value)
}

export function retryError(message: string, code: string, options?: ConstructorParameters<typeof LlmError>[2]): LlmError {
  const delay = options?.providerRetryAfterMs
  // The host permits only positive duration metadata; retain zero advice locally.
  const normalized = { ...options }
  if (delay === 0) delete normalized.providerRetryAfterMs
  const error = new LlmError(message, code, normalized)
  const inherited = options?.cause instanceof LlmError ? deadlines.get(options.cause) : undefined
  if (inherited !== undefined || delay !== undefined) {
    deadlines.set(error, inherited ?? performance.now() + delay!)
  }
  return error
}

export function inheritRetryDeadline(error: LlmError, source: LlmError): LlmError {
  const deadline = deadlines.get(source)
  if (deadline !== undefined) deadlines.set(error, deadline)
  return error
}

export function remainingRetryDelay(error: LlmError): number | undefined {
  let deadline = deadlines.get(error)
  if (deadline === undefined) {
    const delay = error.failure.providerRetryAfterMs
    if (delay === undefined) return undefined
    deadline = performance.now() + delay
    deadlines.set(error, deadline)
  }
  return Math.max(0, Math.ceil(deadline - performance.now()))
}

/** Node timers overflow above 2^31-1; chunk long waits without shortening advice. */
export async function sleepRetry(delay: number, signal?: AbortSignal): Promise<void> {
  const deadline = performance.now() + delay
  do {
    if (signal?.aborted) throw signal.reason instanceof LlmError ? signal.reason : new LlmError('native Codex retry wait was aborted', 'ABORTED')
    const remaining = Math.max(0, Math.ceil(deadline - performance.now()))
    if (remaining === 0) return
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(signal?.reason instanceof LlmError ? signal.reason : new LlmError('native Codex retry wait was aborted', 'ABORTED')) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, Math.min(remaining, 2_147_483_647))
      signal?.addEventListener('abort', abort, { once: true })
    })
  } while (true)
}
