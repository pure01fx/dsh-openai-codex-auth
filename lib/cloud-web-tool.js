import { LlmError } from '@deepseek-ai/dsh-llm';
import { nativeCodexAuthorityHash } from './catalog.js';
import { buildCloudSearchRequest, parseCloudSearchArgs, parseCloudSearchResponse } from './cloud-search.js';
import { chooseCloudModel, recentSearchInput } from './cloud-context.js';
const str = { type: 'string' };
const uint = { type: 'integer', description: 'Nonnegative safe integer.' };
const bool = { type: 'boolean' };
const enumeration = (...values) => ({ type: 'string', enum: values });
const array = (items) => ({ type: 'array', items });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const query = object({ q: str, recency: uint, domains: array(str) }, ['q']);
const operations = {
    search_query: array(query), image_query: array(query),
    open: array(object({ ref_id: str, lineno: uint }, ['ref_id'])),
    click: array(object({ ref_id: str, id: uint }, ['ref_id', 'id'])),
    find: array(object({ ref_id: str, pattern: str }, ['ref_id', 'pattern'])),
    screenshot: array(object({ ref_id: str, pageno: uint }, ['ref_id', 'pageno'])),
    finance: array(object({ ticker: str, type: enumeration('equity', 'fund', 'crypto', 'index'), market: str }, ['ticker', 'type'])),
    weather: array(object({ location: str, start: { ...str, description: 'YYYY-MM-DD' }, duration: uint }, ['location'])),
    sports: array(object({ tool: enumeration('sports'), fn: enumeration('schedule', 'standings'), league: enumeration('nba', 'wnba', 'nfl', 'nhl', 'mlb', 'epl', 'ncaamb', 'ncaawb', 'ipl'), team: str, opponent: str, date_from: str, date_to: str, num_games: uint, locale: str }, ['fn', 'league'])),
    time: array(object({ utc_offset: { ...str, description: 'UTC offset such as +08:00.' } }, ['utc_offset'])),
    response_length: enumeration('short', 'medium', 'long'),
};
const parameters = object({
    commands: { ...object(operations), description: 'One or more nonempty command arrays. Dependent actions require separate calls. screenshot only supports zero-indexed PDF pages.' },
    model: { ...str, description: 'Explicit Codex catalog model; otherwise cloudTools.searchModel, then current openai-codex model. No guessed fallback.' },
    context: { ...str, description: 'Optional explicit text. Default includes last two visible human texts and at most 1000 UTF-8 bytes of visible assistant text.' },
    mode: enumeration('cached', 'indexed', 'live'), search_context_size: enumeration('low', 'medium', 'high'),
    user_location: object({ country: str, region: str, city: str, timezone: str }),
    filters: object({ allowed_domains: array(str), blocked_domains: array(str) }),
    image_settings: object({ max_results: uint, caption: bool }),
}, ['commands']);
const imageSchema = object({ attachmentId: str, mediaType: enumeration('image/png', 'image/jpeg', 'image/webp', 'image/gif'), bytes: uint, width: uint, height: uint, name: str, originalDimensions: object({ width: uint, height: uint }, ['width', 'height']) }, ['attachmentId', 'mediaType', 'bytes', 'width', 'height']);
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function publicUrl(value) {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    }
    catch {
        return false;
    }
}
/** Source: pinned protocol/src/models.rs ContentItem / FunctionCallOutputContentItem.
 * Search DTOs themselves remain opaque. Only exact known content tags are projected;
 * arbitrary image_url properties and future screenshot DTOs are never guessed. */
function inputImage(value) {
    return record(value) && value.type === 'input_image' && typeof value.image_url === 'string'
        && (value.detail == null || ['auto', 'low', 'high', 'original'].includes(value.detail));
}
async function admitSearchImages(body, attachments, signal) {
    const images = [];
    const notes = new Set();
    const visit = async (item) => {
        signal.throwIfAborted();
        if (inputImage(item)) {
            if (publicUrl(item.image_url)) {
                notes.add('Remote image unavailable: the public DSH web boundary has no binary image retrieval. Image and source links are preserved.');
                return item;
            }
            const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(item.image_url);
            if (!match)
                return item;
            let ref;
            try {
                if (!attachments)
                    throw new Error('Attachment service unavailable');
                const data = Buffer.from(match[2], 'base64');
                if (!data.length || data.toString('base64') !== match[2])
                    throw new Error('Invalid inline image');
                signal.throwIfAborted();
                ref = await attachments.saveImage({ data, mediaType: match[1] });
                signal.throwIfAborted();
                images.push(ref);
            }
            catch {
                signal.throwIfAborted();
                notes.add('Inline image unavailable: attachment service missing, image invalid, or image/storage limit reached. Text and source links are preserved.');
            }
            // Binary transfer data must not become historical text; unknown fields remain opaque.
            return { ...item, image_url: ref ? '[DSH attachment ' + ref.attachmentId + ']' : '[inline image unavailable]' };
        }
        // Visit known content blocks while keeping unknown object fields opaque.
        if (Array.isArray(item)) {
            const result = [];
            for (const value of item)
                result.push(await visit(value));
            return result;
        }
        if (record(item) && Array.isArray(item.content)) {
            return { ...item, content: await visit(item.content) };
        }
        return item;
    };
    if (!record(body) || !Array.isArray(body.results))
        return { body, images, notes };
    const results = [];
    for (const item of body.results)
        results.push(await visit(item));
    return { body: { ...body, results }, images, notes };
}
const markerPrefix = '[codex_web context: ';
function containsReference(text, ref) {
    let start = 0;
    for (;;) {
        const index = text.indexOf(ref, start);
        if (index < 0)
            return false;
        const before = text[index - 1] ?? '';
        const after = text[index + ref.length] ?? '';
        if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after))
            return true;
        start = index + ref.length;
    }
}
function checkReferences(args, messages, id, recent) {
    const refs = Object.values(args.commands).flatMap(value => Array.isArray(value) ? value.flatMap(row => record(row) && typeof row.ref_id === 'string' && !publicUrl(row.ref_id) ? [row.ref_id] : []) : []);
    if (!refs.length)
        return;
    const calls = new Map();
    const outputs = [];
    for (const message of messages) {
        if (message.role === 'assistant')
            for (const block of message.content)
                if (block.type === 'tool-call')
                    calls.set(block.id, block.name);
        if (message.source.kind !== 'tool' || !['codex_web', 'run_code'].includes(calls.get(message.source.callId) ?? ''))
            continue;
        for (const block of message.content)
            if (block.type === 'tool-result' && block.toolCallId === message.source.callId && !block.isError) {
                outputs.push(block.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
            }
    }
    outputs.push(...recent);
    for (const ref of refs) {
        const previous = outputs.findLast(text => containsReference(text.slice(0, text.lastIndexOf(markerPrefix)), ref) && text.includes(markerPrefix));
        // Marker is emitted last, overriding any marker-looking upstream prose. It is an
        // account/session digest, not a credential or an upstream encrypted continuation.
        if (!previous || previous.slice(previous.lastIndexOf(markerPrefix), previous.lastIndexOf(markerPrefix) + markerPrefix.length + 64) !== markerPrefix + id) {
            throw new LlmError('Search reference has no visible result in this account/session context. Search again or open its source URL; references can expire or belong to another account.', 'CODEX_SEARCH_REFERENCE_STALE');
        }
    }
}
function sourceLinks(results) {
    const links = new Set();
    const walk = (value, depth) => {
        if (depth > 8 || links.size >= 100)
            return;
        if (typeof value === 'string' && value.length <= 4096 && publicUrl(value))
            links.add(value);
        else if (Array.isArray(value))
            value.slice(0, 100).forEach(item => walk(item, depth + 1));
        else if (record(value))
            Object.values(value).slice(0, 100).forEach(item => walk(item, depth + 1));
    };
    walk(results, 0);
    return [...links];
}
export function registerCodexWeb(ctx, deps) {
    if (!ctx.tools)
        return;
    // Same-program Code Mode subcalls precede durable parent output. Keep a bounded
    // session-object cache of already returned visible text, partitioned by context id.
    const recentOutputs = new WeakMap();
    const definition = {
        name: 'codex_web',
        description: 'Search the web/images, open/click/find results, screenshot PDF pages, and query finance/weather/sports/time through Codex. Preserve returned source URLs and ref IDs for follow-up calls. Non-Codex sessions require explicit model or cloudTools.searchModel. Search references are scoped to the current account/session; expired references require a fresh search.',
        parameters: { ...parameters },
        output: {
            schema: object({ output: str, results: array({}), images: array(imageSchema), model: str, truncated: bool, image_output: bool }, ['output', 'model', 'truncated', 'image_output']),
            render: (_args, value) => {
                const result = value;
                const content = [{ type: 'text', text: result.output }];
                if (result.image_output)
                    for (const attachment of result.images ?? [])
                        content.push({ type: 'image', attachment });
                return content;
            },
        },
        async execute(value, exec) {
            const args = parseCloudSearchArgs(value);
            exec.signal.throwIfAborted();
            const agent = exec.agent;
            if (!agent?.session || !agent.ctx)
                throw new LlmError('codex_web requires a calling DSH agent session', 'CONTEXT_REQUIRED');
            const messages = agent.session.deriveMessages();
            const credential = await deps.client.resolveCredential(exec.signal);
            const view = await deps.catalog.listWithAuthority?.(exec.signal);
            exec.signal.throwIfAborted();
            if (!view || view.authorityHash !== nativeCodexAuthorityHash(credential.accountId))
                throw new LlmError('Codex model catalog authority changed; retry with the current account', 'CODEX_ACCOUNT_CHANGED');
            const model = chooseCloudModel({ requested: args.model, configured: deps.config.searchModel, currentProvider: agent.options.provider, currentModel: agent.options.model, purpose: 'search' }, view.models);
            const input = recentSearchInput(messages).map(item => ({ type: 'message', role: item.role, content: [{ type: item.role === 'user' ? 'input_text' : 'output_text', text: item.content }] }));
            const body = buildCloudSearchRequest({ ...args, mode: args.mode ?? deps.config.searchMode ?? 'live' }, { sessionId: agent.session.id, accountId: credential.accountId, model: model.slug, input });
            const id = body.id;
            const cached = recentOutputs.get(agent.session);
            const recent = cached?.id === id ? cached.texts : [];
            checkReferences(args, messages, id, recent);
            const response = await deps.client.post('alpha/search', body, { credential, signal: exec.signal });
            // Validate the envelope before any attachment write; image bytes are replaced
            // before the final result projection so inline images become attachments.
            if (!record(response.body) || typeof response.body.output !== 'string' || (response.body.results != null && !Array.isArray(response.body.results)))
                throw new LlmError('Invalid Codex search response', 'CODEX_CLOUD_FAILED');
            const media = await admitSearchImages(response.body, agent.ctx.attachments, exec.signal);
            const parsed = parseCloudSearchResponse(media.body);
            let image_output = false;
            const { provider: callerProvider, model: callerModel } = agent.options;
            if (media.images.length && callerProvider && callerModel && agent.ctx.llm) {
                try {
                    image_output = (await agent.ctx.llm.resolveModelInfo(callerProvider, callerModel, exec.signal)).inputModalities?.includes('image') ?? false;
                }
                catch {
                    exec.signal.throwIfAborted();
                }
            }
            exec.signal.throwIfAborted();
            let output = parsed.output;
            if (parsed.results?.length)
                output += '\nStructured search results:\n' + JSON.stringify(parsed.results);
            const links = sourceLinks(parsed.results ?? []);
            if (links.length)
                output += '\nSources and result links:\n' + links.map(url => '<' + url.replace(/[<>\s]/g, c => encodeURIComponent(c)) + '>').join('\n');
            if (media.notes.size)
                output += '\n' + [...media.notes].join('\n');
            output += '\n' + markerPrefix + id + ']';
            recentOutputs.set(agent.session, { id, texts: [...recent.slice(-7), output] });
            return { ...parsed, output, model: model.slug, image_output, ...(media.images.length ? { images: media.images } : {}) };
        },
    };
    ctx.tools.register(definition);
}
