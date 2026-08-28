import { describe, expect, it, vi } from 'vitest'
import { normalizeUsage } from '../src/index.ts'
import { mergeDirectUsage } from '../src/usage.ts'

describe('normalizeUsage', () => {
  it('projects the Codex rate-limit response used by the settings card', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    expect(normalizeUsage({
      plan_type: 'plus',
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 2000 },
        secondary_window: { used_percent: 73, limit_window_seconds: 604_800, reset_at: 3000 },
      },
      rate_limit_reset_credits: { available_count: 2 },
    })).toEqual({
      planType: 'plus',
      primary: { usedPercent: 42, windowSeconds: 18_000, resetAt: 2000 },
      secondary: { usedPercent: 73, windowSeconds: 604_800, resetAt: 3000 },
      limitReached: false,
      resetCredits: 2,
      limits: [{
        id: 'codex',
        primary: { usedPercent: 42, windowSeconds: 18_000, resetAt: 2000 },
        secondary: { usedPercent: 73, windowSeconds: 604_800, resetAt: 3000 },
        limitReached: false,
      }],
      source: 'endpoint',
      fetchedAt: 1234,
    })
    vi.restoreAllMocks()
  })

  it('clamps malformed percentages and tolerates absent windows', () => {
    expect(normalizeUsage({ rate_limit: { primary_window: { used_percent: 120 } } }).primary)
      .toEqual({ usedPercent: 100 })
  })

  it('merges sparse direct windows field-wise and honors explicit null clears', () => {
    const previous = normalizeUsage({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 2000 },
        secondary_window: { used_percent: 5, limit_window_seconds: 604_800, reset_at: 3000 },
      },
      rate_limit_reset_credits: { available_count: 2 },
    })
    const metadataOnly = mergeDirectUsage(previous, [{
      limitId: 'codex', credits: { hasCredits: true, unlimited: false, balance: '8' },
    }])
    expect(metadataOnly.source).toBe('endpoint')
    expect(metadataOnly.fetchedAt).toBe(previous.fetchedAt)
    const updated = mergeDirectUsage(metadataOnly, [{
      limitId: 'codex', primary: { usedPercent: 42 },
    }])
    expect(updated).toMatchObject({
      planType: 'pro',
      primary: { usedPercent: 42, windowSeconds: 18_000, resetAt: 2000 },
      secondary: { usedPercent: 5, windowSeconds: 604_800, resetAt: 3000 },
      resetCredits: 2,
      source: 'response',
    })
    const cleared = mergeDirectUsage(updated, [{
      limitId: 'codex', secondary: null,
    }])
    expect(cleared).not.toHaveProperty('secondary')
    expect(cleared.limits?.[0]).not.toHaveProperty('secondary')
  })

  it('keeps additional metered limits and native credits distinct from reset credits', () => {
    expect(normalizeUsage({
      plan_type: 'pro',
      rate_limit: { primary_window: { used_percent: 10 } },
      additional_rate_limits: [{
        metered_feature: 'codex-other',
        limit_name: 'gpt-5.6-sol',
        rate_limit: { primary_window: { used_percent: 70, limit_window_seconds: 900 } },
      }],
      credits: { has_credits: true, unlimited: false, balance: '9.99' },
      rate_limit_reset_credits: { available_count: 3 },
    })).toMatchObject({
      credits: { hasCredits: true, unlimited: false, balance: '9.99' },
      resetCredits: 3,
      limits: [
        { id: 'codex', primary: { usedPercent: 10 } },
        {
          id: 'codex_other',
          name: 'gpt-5.6-sol',
          primary: { usedPercent: 70, windowSeconds: 900 },
        },
      ],
    })
  })
})
