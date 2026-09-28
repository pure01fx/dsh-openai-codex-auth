import { readFile } from 'node:fs/promises'
import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const section = source.slice(source.indexOf('    function networkDuration('), source.indexOf('    function CodexQuotaRing('))
const snapshot = (updatedAt = 10000, receivedBytes = 1024) => ({
  startedAt: 1, updatedAt, activeCount: 1,
  totals: { requests: 1, succeeded: 0, failed: 0, cancelled: 0, retries: 2, receivedBytes },
  requests: [{ id: '1', state: 'retrying', transport: 'http', startedAt: 1000,
    lastActivityAt: 2000, lastOutputAt: null, retryAt: 15000, retries: 2, attempts: 3 }],
})
function mount(fetch: ReturnType<typeof vi.fn>) {
  const states: unknown[] = []
  let cursor = 0
  let cleanup: (() => void) | undefined
  let mounted = false
  const listeners = new Map<string, () => void>()
  const document = {
    visibilityState: 'visible',
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  }
  const context = createContext({
    BASE: '/openai-codex', fetch, AbortController, document,
    messageOf: (e: unknown) => String(e), React: { Fragment: 'fragment' },
    h: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    window: { setTimeout, clearTimeout },
    useState: (initial: unknown) => {
      const index = cursor++
      if (states.length <= index) states.push(initial)
      return [states[index], (value: unknown) => { states[index] = value }]
    },
    useEffect: (effect: () => () => void) => { if (!mounted) cleanup = effect() },
  })
  runInContext(section, context)
  const render = () => {
    cursor = 0
    const tree = runInContext('CodexNetworkStats(useNetworkStats(true))', context)
    mounted = true
    return JSON.stringify(tree)
  }
  render()
  return { render, document, listeners, unmount: () => cleanup?.() }
}
afterEach(() => vi.useRealTimers())

describe('quota network telemetry', () => {
  it('breathes only for live unlimited connection retries, including the next attempt', () => {
    const context = createContext({})
    runInContext(section, context)
    const reconnecting = (state: string, retryKind: string | null, error = '') => {
      context.network = { error, sample: { snapshot: { requests: [{ state, retryKind }] } } }
      return runInContext('networkReconnecting(network)', context)
    }
    for (const state of ['retrying', 'preparing', 'connecting']) expect(reconnecting(state, 'connection')).toBe(true)
    for (const state of ['waiting', 'streaming', 'completed', 'failed', 'cancelled']) expect(reconnecting(state, null)).toBe(false)
    expect(reconnecting('retrying', 'transient')).toBe(false)
    expect(reconnecting('retrying', 'connection', 'stale')).toBe(false)
  })
  it('shows stalled output and retries, samples throughput, and stops polling on close', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => snapshot() })
      .mockResolvedValue({ ok: true, json: async () => snapshot(12000, 3072) })
    const ui = mount(fetch)
    await vi.advanceTimersByTimeAsync(0)
    expect(ui.render()).toContain('等待重试')
    expect(ui.render()).toContain('尚无输出')
    expect(ui.render()).toContain('8 秒前')
    await vi.advanceTimersByTimeAsync(2000)
    expect(ui.render()).toContain('1.0 KB/s')
    expect(fetch.mock.calls.every(([url]) => url === '/openai-codex/network')).toBe(true)
    ui.unmount()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(ui.listeners.size).toBe(0)
  })

  it('marks a failed refresh stale and resumes after hiding without overlapping requests', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => snapshot() })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ok: true, json: async () => snapshot(16000, 2048) })
    const ui = mount(fetch)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ui.render()).toContain('数据已过期')
    expect(ui.render()).not.toContain('KB/s')
    ui.document.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(4000)
    expect(fetch).toHaveBeenCalledTimes(2)
    ui.document.visibilityState = 'visible'
    ui.listeners.get('visibilitychange')?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(ui.render()).not.toContain('数据已过期')
    ui.unmount()
  })

  it('aborts an in-flight local request on close', () => {
    vi.useFakeTimers()
    const fetch = vi.fn(() => new Promise(() => {}))
    const ui = mount(fetch)
    const signal = fetch.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(signal.aborted).toBe(false)
    ui.unmount()
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
