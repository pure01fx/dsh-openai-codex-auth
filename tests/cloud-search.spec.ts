import { describe, expect, it } from 'vitest'
import { buildCloudSearchRequest, parseCloudSearchArgs, parseCloudSearchResponse } from '../src/cloud-search.js'
const context = { sessionId: 'session-a', accountId: 'account-a', model: 'resolved-model' }
const commands = {
  search_query: [{ q: 'news', recency: 0, domains: ['example.com'] }],
  image_query: [{ q: 'photos', recency: 7, domains: ['example.org'] }],
  open: [{ ref_id: 'turn0search1', lineno: 0 }],
  click: [{ ref_id: 'turn0view0', id: 2 }],
  find: [{ ref_id: 'turn0view0', pattern: 'text' }],
  screenshot: [{ ref_id: 'https://example.com/doc.pdf', pageno: 0 }],
  finance: [{ ticker: 'BTC', type: 'crypto', market: '' }],
  weather: [{ location: 'US, CA, LA', start: '2026-03-01', duration: 7 }],
  sports: [{ tool: 'sports', fn: 'schedule', league: 'nba', team: 'LAL', opponent: 'BOS', date_from: '2026-03-01', date_to: '2026-03-02', num_games: 2, locale: 'en-US' }],
  time: [{ utc_offset: '+08:00' }],
}
describe('cloud search contract', () => {
  it.each(Object.entries(commands))('preserves full %s command payload', (key, operation) => {
    const args = parseCloudSearchArgs({ commands: { [key]: operation } })
    expect(buildCloudSearchRequest(args, context)).toEqual({ id: expect.stringMatching(/^[a-f0-9]{64}$/), model: 'resolved-model', commands: { [key]: operation }, settings: { allowed_callers: ['direct'], external_web_access: true } })
  })
  it('maps every approved setting and explicit context into the exact upstream envelope', () => {
    const args = parseCloudSearchArgs({ commands: { ...commands, response_length: 'long' }, model: 'alias', context: '', mode: 'indexed', search_context_size: 'high', user_location: { country: 'US', city: 'LA', region: 'CA', timezone: 'America/Los_Angeles' }, filters: { allowed_domains: ['example.com'], blocked_domains: ['example.org'] }, image_settings: { max_results: 10, caption: false } })
    expect(buildCloudSearchRequest(args, { ...context, input: 'automatic context' })).toEqual({ id: expect.any(String), model: 'resolved-model', commands: { ...commands, response_length: 'long' }, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] }], settings: { allowed_callers: ['direct'], external_web_access: 'indexed', search_context_size: 'high', user_location: { type: 'approximate', country: 'US', city: 'LA', region: 'CA', timezone: 'America/Los_Angeles' }, filters: { allowed_domains: ['example.com'], blocked_domains: ['example.org'] }, image_settings: { max_results: 10, caption: false } } })
  })
  it.each([['cached', false], ['indexed', 'indexed'], ['live', true]])('maps %s mode', (mode, expected) => {
    expect(buildCloudSearchRequest(parseCloudSearchArgs({ commands: { time: commands.time }, mode }), context).settings).toEqual({ allowed_callers: ['direct'], external_web_access: expected })
  })
  it('derives durable session/account identity independent of model, query and token', () => {
    const args = parseCloudSearchArgs({ commands: { search_query: commands.search_query } })
    const first = buildCloudSearchRequest(args, context).id
    expect(buildCloudSearchRequest(args, { ...context, model: 'different' }).id).toBe(first)
    expect(buildCloudSearchRequest(args, { ...context, sessionId: 'session-b' }).id).not.toBe(first)
    expect(buildCloudSearchRequest(args, { ...context, accountId: 'account-b' }).id).not.toBe(first)
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'visible' }] }]
    expect(buildCloudSearchRequest(args, { ...context, input }).input).toEqual(input)
  })
  it.each(['nba', 'wnba', 'nfl', 'nhl', 'mlb', 'epl', 'ncaamb', 'ncaawb', 'ipl'])('accepts pinned sports league %s', league => {
    expect(parseCloudSearchArgs({ commands: { sports: [{ fn: 'standings', league }] } }).commands).toEqual({ sports: [{ fn: 'standings', league }] })
  })
  it.each([
    {}, { response_length: 'short' }, { search_query: [] }, { unknown: [{}] },
    { search_query: [{ q: 'x', recency: -1 }] }, { open: [{ ref_id: 'ref', lineno: 1.2 }] },
    { click: [{ ref_id: 'ref' }] }, { find: [{ ref_id: 'ref', pattern: '' }] },
    { screenshot: [{ ref_id: 'ref', pageno: -1 }] }, { finance: [{ ticker: 'X', type: 'bond' }] },
    { weather: [{ location: 'LA', start: '2026-02-30' }] }, { sports: [{ fn: 'schedule', league: 'arbitrary' }] },
    { time: [{ utc_offset: '+25:00' }] }, { image_query: [{ q: 'x', domains: 'example.com' }] },
  ])('rejects malformed or empty commands %j', commands => expect(() => parseCloudSearchArgs({ commands })).toThrow('Invalid codex_web'))
  it.each([{ mode: 'other' }, { context: 1 }, { model: '' }, { filters: { allowed_domains: [1] } }, { image_settings: { caption: 'yes' } }, { user_location: { type: 'precise' } }, { request_id: 'user-id' }])('rejects invalid settings %j', setting => {
    expect(() => parseCloudSearchArgs({ commands: { time: commands.time }, ...setting })).toThrow()
  })
  it('forwards complete command arrays and full context', () => {
    const batch = { time: Array(101).fill({ utc_offset: '+08:00' }) }
    expect(parseCloudSearchArgs({ commands: batch }).commands).toEqual(batch)
    const text = 'x'.repeat(300_000)
    expect(buildCloudSearchRequest(parseCloudSearchArgs({ commands: { time: commands.time } }), { ...context, input: text }).input)
      .toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }])
  })
  it('preserves opaque results, references, link numbers and source URLs without encrypted output', () => {
    const results = [{ type: 'future_variant', ref_id: 'turn0search7', url: 'https://example.com', links: [{ id: 3, ref_id: 'turn0view8' }], nested: { arbitrary: [1, false, null] } }]
    expect(parseCloudSearchResponse({ output: 'Source [turn0search7]', results, encrypted_output: 'private' })).toEqual({ output: 'Source [turn0search7]', results, truncated: false })
    expect(parseCloudSearchResponse({ output: 'No sources' })).toEqual({ output: 'No sources', truncated: false })
  })
  it('preserves complete output and unknown result variants', () => {
    const output = '汉'.repeat(100_000)
    const results = [{ huge: 'x'.repeat(300_000) }, { ref_id: 'complete-ref', unknown: true }]
    expect(parseCloudSearchResponse({ output, results })).toEqual({ output, results, truncated: false })
  })
  it.each([null, [], {}, { output: 42 }, { output: 'ok', results: {} }])('rejects malformed responses %j', value => expect(() => parseCloudSearchResponse(value)).toThrow('Invalid Codex search response'))
})
