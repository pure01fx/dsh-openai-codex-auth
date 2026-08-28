import { describe, expect, it, vi } from 'vitest'
import {
  parseCodexRateLimitEvent,
  parseCodexRateLimitHeaders,
  publishCodexRateLimits,
} from '../src/rate-limits.ts'

describe('Codex rate-limit side channels', () => {
  it('parses the bounded WebSocket v2 codex.rate_limits event', () => {
    expect(parseCodexRateLimitEvent({
      type: 'codex.rate_limits',
      plan_type: 'plus',
      rate_limits: {
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 42, window_minutes: 60, reset_at: 1_700_000_000 },
        secondary: { used_percent: 7.5, window_minutes: 10_080, reset_at: 1_700_500_000 },
      },
      credits: { has_credits: true, unlimited: false, balance: '123' },
      metered_limit_name: 'codex',
    })).toEqual({
      limitId: 'codex',
      planType: 'plus',
      primary: { usedPercent: 42, windowSeconds: 3_600, resetAt: 1_700_000_000 },
      secondary: { usedPercent: 7.5, windowSeconds: 604_800, resetAt: 1_700_500_000 },
      limitReached: false,
      credits: { hasCredits: true, unlimited: false, balance: '123' },
    })
  })

  it('ignores unrelated or empty events and bounds provider-controlled metadata', () => {
    expect(parseCodexRateLimitEvent({ type: 'response.created' })).toBeUndefined()
    expect(parseCodexRateLimitEvent({
      type: 'codex.rate_limits',
      metered_limit_name: 'y'.repeat(129),
      rate_limits: { primary: { used_percent: 50 } },
    })).toBeUndefined()
    expect(parseCodexRateLimitEvent({
      type: 'codex.rate_limits',
      plan_type: 'x'.repeat(129),
      rate_limits: { primary: { used_percent: 120, window_minutes: -1, reset_at: -1 } },
      credits: { has_credits: true, unlimited: false, balance: 'z'.repeat(129) },
    })).toEqual({
      limitId: 'codex',
      primary: { usedPercent: 100 },
      limitReached: true,
      credits: { hasCredits: true, unlimited: false },
    })
    expect(parseCodexRateLimitEvent({ type: 'codex.rate_limits', rate_limits: {} }))
      .toBeUndefined()
  })

  it('parses default and additional HTTP header families including credits', () => {
    const updates = parseCodexRateLimitHeaders(new Headers({
      'x-codex-primary-used-percent': '12.5',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1704069000',
      'x-codex-secondary-used-percent': '33',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-credits-has-credits': 'true',
      'x-codex-credits-unlimited': 'false',
      'x-codex-credits-balance': '45',
      'x-codex-bengalfox-primary-used-percent': '80',
      'x-codex-bengalfox-primary-window-minutes': '1440',
      'x-codex-bengalfox-limit-name': 'gpt-5.6-sol',
    }))
    expect(updates).toEqual([
      {
        limitId: 'codex',
        primary: { usedPercent: 12.5, windowSeconds: 18_000, resetAt: 1_704_069_000 },
        secondary: { usedPercent: 33, windowSeconds: 604_800 },
        limitReached: false,
        credits: { hasCredits: true, unlimited: false, balance: '45' },
      },
      {
        limitId: 'codex_bengalfox',
        limitName: 'gpt-5.6-sol',
        primary: { usedPercent: 80, windowSeconds: 86_400 },
        limitReached: false,
      },
    ])
  })

  it('accepts numeric wrapped-WebSocket headers and credits-only snapshots', () => {
    expect(parseCodexRateLimitHeaders({
      'X-Codex-Primary-Used-Percent': 100,
      'X-Codex-Primary-Window-Minutes': 15,
    })).toEqual([{
      limitId: 'codex',
      primary: { usedPercent: 100, windowSeconds: 900 },
      limitReached: true,
    }])
    expect(parseCodexRateLimitHeaders({
      'x-codex-credits-has-credits': '1',
      'x-codex-credits-unlimited': 'true',
    })).toEqual([{
      limitId: 'codex',
      credits: { hasCredits: true, unlimited: true },
    }])
  })

  it('contains callback failures so quota diagnostics never break generation', () => {
    const callback = vi.fn(() => { throw new Error('broken consumer') })
    const warn = vi.fn()
    const updates = [{ limitId: 'codex', primary: { usedPercent: 1 } }]
    expect(() => { publishCodexRateLimits('acct_test', updates, callback, warn) }).not.toThrow()
    expect(callback).toHaveBeenCalledWith({ accountId: 'acct_test', updates })
    expect(warn).toHaveBeenCalledWith('native Codex rate-limit update could not be published')
    expect(() => {
      publishCodexRateLimits('acct_test', updates, callback, () => { throw new Error('broken logger') })
    }).not.toThrow()
  })
})
