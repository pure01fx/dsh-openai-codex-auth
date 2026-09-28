/** Wire contract: Codex b348fc26674189f758d5941cdab3f78f258b2aa7, codex-api/src/search.rs. */
import { createHash } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type ObjectValue = Record<string, unknown>
export interface CloudSearchArgs {
  commands: Record<string, Json>
  model?: string
  context?: string
  mode?: 'cached' | 'indexed' | 'live'
  search_context_size?: 'low' | 'medium' | 'high'
  user_location?: Record<string, string>
  filters?: Record<string, string[]>
  image_settings?: { max_results?: number; caption?: boolean }
}
const invalid = () => new LlmError('Invalid codex_web arguments; check command fields and limits', 'INVALID_ARGS')
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid()
  return value as ObjectValue
}
function text(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw invalid()
  return value
}
type Rule = (value: unknown) => Json
const string: Rule = value => text(value)
const uint: Rule = value => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid()
  return value
}
const strings: Rule = value => {
  if (!Array.isArray(value)) throw invalid()
  return value.map(item => text(item))
}
const bool: Rule = value => { if (typeof value !== 'boolean') throw invalid(); return value }
const choice = (...values: string[]): Rule => value => { if (typeof value !== 'string' || !values.includes(value)) throw invalid(); return value }
const date: Rule = value => {
  const s = text(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw invalid()
  return s
}
function fields(value: unknown, rules: Record<string, Rule>, required: string[] = []): Record<string, Json> {
  const input = object(value)
  if (required.some(key => input[key] === undefined)) throw invalid()
  const result: Record<string, Json> = {}
  for (const [key, item] of Object.entries(input)) {
    if (!Object.hasOwn(rules, key)) throw invalid()
    if (item !== undefined) result[key] = rules[key]!(item)
  }
  return result
}
const query = { q: string, recency: uint, domains: strings }
const operations: Record<string, { rules: Record<string, Rule>; required: string[] }> = {
  search_query: { rules: query, required: ['q'] },
  image_query: { rules: query, required: ['q'] },
  open: { rules: { ref_id: string, lineno: uint }, required: ['ref_id'] },
  click: { rules: { ref_id: string, id: uint }, required: ['ref_id', 'id'] },
  find: { rules: { ref_id: string, pattern: string }, required: ['ref_id', 'pattern'] },
  screenshot: { rules: { ref_id: string, pageno: uint }, required: ['ref_id', 'pageno'] },
  finance: { rules: { ticker: string, type: choice('equity', 'fund', 'crypto', 'index'), market: value => text(value, true) }, required: ['ticker', 'type'] },
  weather: { rules: { location: string, start: date, duration: uint }, required: ['location'] },
  sports: { rules: { tool: choice('sports'), fn: choice('schedule', 'standings'), league: choice('nba', 'wnba', 'nfl', 'nhl', 'mlb', 'epl', 'ncaamb', 'ncaawb', 'ipl'), team: string, opponent: string, date_from: date, date_to: date, num_games: uint, locale: string }, required: ['fn', 'league'] },
  time: { rules: { utc_offset: value => {
    const s = text(value)
    if (!/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(s)) throw invalid()
    return s
  } }, required: ['utc_offset'] },
}
function validateRequestJson(value: unknown): void {
  try { JSON.stringify(value) } catch { throw invalid() }
}
export function parseCloudSearchArgs(value: unknown): CloudSearchArgs {
  const input = object(value)
  const parsed = fields(input, {
    commands: value => {
      const commands = object(value)
      const result: Record<string, Json> = {}
      let count = 0
      for (const [key, items] of Object.entries(commands)) {
        if (key === 'response_length') { result[key] = choice('short', 'medium', 'long')(items); continue }
        if (!Object.hasOwn(operations, key) || !Array.isArray(items) || items.length === 0) throw invalid()
        const operation = operations[key]!
        count += items.length
        result[key] = items.map(item => fields(item, operation.rules, operation.required))
      }
      if (count === 0) throw invalid()
      return result
    },
    model: string, context: value => text(value, true), mode: choice('cached', 'indexed', 'live'),
    search_context_size: choice('low', 'medium', 'high'),
    user_location: value => fields(value, { country: string, region: string, city: string, timezone: string }),
    filters: value => fields(value, { allowed_domains: strings, blocked_domains: strings }),
    image_settings: value => fields(value, { max_results: uint, caption: bool }),
  }, ['commands'])
  validateRequestJson(parsed)
  return parsed as unknown as CloudSearchArgs
}
/** The caller selects the model and visible context using the same request credential. */
export function buildCloudSearchRequest(args: CloudSearchArgs, context: { sessionId: string; accountId: string; model: string; input?: unknown }): Record<string, unknown> {
  const parsed = parseCloudSearchArgs(args)
  const id = createHash('sha256').update(JSON.stringify(['dsh-codex-search-v1', text(context.sessionId), text(context.accountId)])).digest('hex')
  const settings: Record<string, unknown> = { allowed_callers: ['direct'], external_web_access: parsed.mode === 'cached' ? false : parsed.mode === 'indexed' ? 'indexed' : true }
  for (const key of ['search_context_size', 'filters', 'image_settings'] as const) if (parsed[key] !== undefined) settings[key] = parsed[key]
  if (parsed.user_location !== undefined) settings.user_location = { type: 'approximate', ...parsed.user_location }
  const selected = parsed.context ?? context.input
  const input = typeof selected === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: selected }] }] : selected
  if (input !== undefined && typeof input !== 'string' && !Array.isArray(input)) throw invalid()
  const result = { id, model: text(context.model), commands: parsed.commands, settings, ...(input === undefined ? {} : { input }) }
  validateRequestJson(result)
  return result
}
/** Preserve complete output and opaque result entries. */
export function parseCloudSearchResponse(body: unknown): { output: string; results?: unknown[]; truncated: boolean } {
  let data: ObjectValue
  try { data = object(body) } catch { throw new LlmError('Invalid Codex search response', 'CODEX_CLOUD_FAILED') }
  if (typeof data.output !== 'string' || (data.results != null && !Array.isArray(data.results))) throw new LlmError('Invalid Codex search response', 'CODEX_CLOUD_FAILED')
  const output = data.output
  let results: unknown[] | undefined
  if (Array.isArray(data.results)) {
    results = []
    for (const item of data.results) {
      let serialized: string
      try { serialized = JSON.stringify(item) } catch { throw new LlmError('Invalid Codex search results', 'CODEX_CLOUD_FAILED') }
      if (serialized === undefined) throw new LlmError('Invalid Codex search results', 'CODEX_CLOUD_FAILED')
      results.push(JSON.parse(serialized))
    }
  }
  return { output, ...(results === undefined ? {} : { results }), truncated: false }
}
