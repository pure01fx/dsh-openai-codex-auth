/** Wire contract: Codex b348fc26674189f758d5941cdab3f78f258b2aa7, codex-api/src/search.rs. */
import { createHash } from 'node:crypto';
import { LlmError } from '@deepseek-ai/dsh-llm';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_RESULTS_BYTES = 256 * 1024;
const invalid = () => new LlmError('Invalid codex_web arguments; check command fields and limits', 'INVALID_ARGS');
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
        throw invalid();
    return value;
}
function text(value, empty = false) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > MAX_REQUEST_BYTES)
        throw invalid();
    return value;
}
const string = value => text(value);
const uint = value => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw invalid();
    return value;
};
const strings = value => {
    if (!Array.isArray(value) || value.length > 100)
        throw invalid();
    return value.map(item => text(item));
};
const bool = value => { if (typeof value !== 'boolean')
    throw invalid(); return value; };
const choice = (...values) => value => { if (typeof value !== 'string' || !values.includes(value))
    throw invalid(); return value; };
const date = value => {
    const s = text(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s)
        throw invalid();
    return s;
};
function fields(value, rules, required = []) {
    const input = object(value);
    if (required.some(key => input[key] === undefined))
        throw invalid();
    const result = {};
    for (const [key, item] of Object.entries(input)) {
        if (!Object.hasOwn(rules, key))
            throw invalid();
        if (item !== undefined)
            result[key] = rules[key](item);
    }
    return result;
}
const query = { q: string, recency: uint, domains: strings };
const operations = {
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
                const s = text(value);
                if (!/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(s))
                    throw invalid();
                return s;
            } }, required: ['utc_offset'] },
};
function boundedRequest(value) {
    try {
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_REQUEST_BYTES)
            throw invalid();
    }
    catch {
        throw invalid();
    }
}
export function parseCloudSearchArgs(value) {
    const input = object(value);
    const parsed = fields(input, {
        commands: value => {
            const commands = object(value);
            const result = {};
            let count = 0;
            for (const [key, items] of Object.entries(commands)) {
                if (key === 'response_length') {
                    result[key] = choice('short', 'medium', 'long')(items);
                    continue;
                }
                if (!Object.hasOwn(operations, key) || !Array.isArray(items) || items.length === 0 || items.length > 100)
                    throw invalid();
                const operation = operations[key];
                count += items.length;
                result[key] = items.map(item => fields(item, operation.rules, operation.required));
            }
            if (count === 0 || count > 100)
                throw invalid();
            return result;
        },
        model: string, context: value => text(value, true), mode: choice('cached', 'indexed', 'live'),
        search_context_size: choice('low', 'medium', 'high'),
        user_location: value => fields(value, { country: string, region: string, city: string, timezone: string }),
        filters: value => fields(value, { allowed_domains: strings, blocked_domains: strings }),
        image_settings: value => fields(value, { max_results: uint, caption: bool }),
    }, ['commands']);
    boundedRequest(parsed);
    return parsed;
}
/** The caller selects the model and visible context using the same request credential. */
export function buildCloudSearchRequest(args, context) {
    const parsed = parseCloudSearchArgs(args);
    const id = createHash('sha256').update(JSON.stringify(['dsh-codex-search-v1', text(context.sessionId), text(context.accountId)])).digest('hex');
    const settings = { allowed_callers: ['direct'], external_web_access: parsed.mode === 'cached' ? false : parsed.mode === 'indexed' ? 'indexed' : true };
    for (const key of ['search_context_size', 'filters', 'image_settings'])
        if (parsed[key] !== undefined)
            settings[key] = parsed[key];
    if (parsed.user_location !== undefined)
        settings.user_location = { type: 'approximate', ...parsed.user_location };
    const selected = parsed.context ?? context.input;
    const input = typeof selected === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: selected }] }] : selected;
    if (input !== undefined && typeof input !== 'string' && !Array.isArray(input))
        throw invalid();
    const result = { id, model: text(context.model), commands: parsed.commands, settings, ...(input === undefined ? {} : { input }) };
    boundedRequest(result);
    return result;
}
/** Keep whole opaque result entries and identify any omitted data explicitly. */
export function parseCloudSearchResponse(body) {
    let data;
    try {
        data = object(body);
    }
    catch {
        throw new LlmError('Invalid Codex search response', 'CODEX_CLOUD_FAILED');
    }
    if (typeof data.output !== 'string' || (data.results != null && !Array.isArray(data.results)))
        throw new LlmError('Invalid Codex search response', 'CODEX_CLOUD_FAILED');
    let output = data.output;
    let truncated = false;
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
        // Truncate only at complete UTF-8 boundaries; the notice warns that references may be omitted.
        output = new TextDecoder().decode(Buffer.from(output).subarray(0, MAX_OUTPUT_BYTES)).replace(/\uFFFD$/, '');
        truncated = true;
    }
    let results;
    if (Array.isArray(data.results)) {
        results = [];
        let bytes = 2;
        for (const item of data.results) {
            let serialized;
            try {
                serialized = JSON.stringify(item);
            }
            catch {
                throw new LlmError('Invalid Codex search results', 'CODEX_CLOUD_FAILED');
            }
            if (serialized === undefined)
                throw new LlmError('Invalid Codex search results', 'CODEX_CLOUD_FAILED');
            const size = Buffer.byteLength(serialized) + 1;
            if (results.length >= 100 || bytes + size > MAX_RESULTS_BYTES) {
                truncated = true;
                continue;
            }
            results.push(JSON.parse(serialized));
            bytes += size;
        }
    }
    if (truncated)
        output += '\n[Search response truncated; some content or references were omitted. Narrow the request to retrieve them.]';
    return { output, ...(results === undefined ? {} : { results }), truncated };
}
