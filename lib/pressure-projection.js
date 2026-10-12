/** Pure, route-aware UI pressure pricing and scoped host registration forwarding. */
import { createHash } from 'node:crypto';
import { symbols } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm';
import { canonicalHeader, deriveEventMessage, isSurfaceEvent, SessionSeq, } from '@deepseek-ai/dsh-session';
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate';
import { CODEX_PROVIDER, NATIVE_CODEX_PROVIDER } from './native-adapter.js';
import { estimateNativeCodexReplayTokens, hasNativeCodexReplayKind } from './replay.js';
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const routeSchema = z.object({ provider: z.string(), model: z.string(), fingerprint: z.string(), tools: count }).strict();
const extraSchema = z.object({
    header: routeSchema.nullable(),
    sample: routeSchema.nullable(),
    sampleNative: z.boolean().nullable(),
    nativeHistory: z.boolean(),
    context: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
    nodes: z.array(z.object({ seq: sequence, position: sequence, provider: z.string(), tokens: count }).strict()),
    positions: z.array(z.object({ seq: sequence, position: sequence }).strict()),
    sampledHidden: z.record(z.string(), count),
}).strict();
function route(header) {
    const normalized = canonicalHeader(header);
    return {
        provider: normalized.config.provider,
        model: normalized.config.model,
        fingerprint: createHash('sha256').update(JSON.stringify({
            config: {
                provider: normalized.config.provider, model: normalized.config.model,
                reasoningEffort: normalized.config.reasoningEffort, temperature: normalized.config.temperature,
                maxTokens: normalized.config.maxTokens, stop: normalized.config.stop,
            },
            adapterDefaults: {
                reasoningEffort: normalized.adapterDefaults?.reasoningEffort,
                maxTokens: normalized.adapterDefaults?.maxTokens,
            },
            tools: normalized.tools ?? [],
        })).digest('hex'),
        tools: estimateToolsTokens(normalized),
    };
}
function sums(nodes) {
    const totals = {};
    for (const node of nodes)
        totals[node.provider] = (totals[node.provider] ?? 0) + node.tokens;
    return totals;
}
function sameView(a, b) {
    return a.pressureTokens === b.pressureTokens && a.projectedTokens === b.projectedTokens
        && a.contextWindow === b.contextWindow;
}
/**
 * Withhold only the host pressure registration in an isolated service view.
 * All other registrations use the original caller-traced registry and disposer.
 * @param ctx - scope owning the replacement meter.
 * @returns scoped constructor context and the captured host pressure definition.
 */
export function capturePressureRegistration(ctx) {
    const registry = ctx.sessionProjections;
    const originalRegister = registry.register;
    let captured;
    const register = (definition) => {
        if (definition.key === 'contextPressure') {
            if (definition.wire === undefined)
                throw new Error('host pressure projection has no wire view');
            captured = { ...definition, wire: definition.wire };
            return () => { };
        }
        return Reflect.apply(originalRegister, registry, [definition]);
    };
    const forwarded = new Proxy(registry, {
        get(target, key, receiver) {
            // Suppress another Cordis trace wrapper, which would bypass the register trap.
            if (key === symbols.tracker)
                return undefined;
            if (key === 'register')
                return register;
            return Reflect.get(target, key, receiver);
        },
    });
    const context = ctx.isolate('sessionProjections');
    context.provide('sessionProjections', forwarded);
    return { context, register(definition) {
            return Reflect.apply(originalRegister, registry, [definition]);
        }, get definition() {
            if (captured === undefined)
                throw new Error('host token meter did not register contextPressure');
            return captured;
        } };
}
/**
 * Add hidden replay to the existing UI pressure fields using only logged data.
 * Native groups are immutable policy; source prices and sample totals stay
 * policy-independent so checkpoints can be safely restored after ownership changes.
 * @param base - host pressure fold, schema, and wire view.
 * @param groups - provider routes grouped by their active native adapter.
 * @returns one pure pressure unit with a policy-independent checkpoint format.
 */
export function codexPressureProjection(base, groups) {
    const owners = new Map(groups.flatMap((group, index) => group.map(provider => [provider, index])));
    const hidden = (totals, target) => {
        const owner = owners.get(target);
        if (owner === undefined)
            return 0;
        return Object.entries(totals).reduce((n, [provider, tokens]) => n + (owners.get(provider) === owner ? tokens : 0), 0);
    };
    const view = (state, extra) => {
        const original = base.wire.view(state);
        const header = extra.header;
        if (header === null)
            return original;
        const native = owners.has(header.provider);
        const sampleProvider = extra.sample?.provider;
        const changedEnvelope = extra.sample !== null && extra.sample.fingerprint !== header.fingerprint;
        if (!native && !extra.nativeHistory && extra.sampleNative !== true
            && !owners.has(sampleProvider ?? '') && !changedEnvelope)
            return original;
        const current = hidden(sums(extra.nodes), header.provider);
        const sampled = hidden(extra.sampledHidden, header.provider);
        const sampledSources = Object.entries(extra.sampledHidden).filter(([, tokens]) => tokens > 0);
        const policyCompatible = native
            ? sampledSources.every(([source]) => source === extra.sample?.provider
                && owners.get(source) === owners.get(header.provider))
            : extra.sampleNative === false || sampledSources.length === 0 && extra.sampleNative !== true;
        const compatible = extra.sample?.fingerprint === header.fingerprint
            && (extra.sampleNative === null || extra.sampleNative === native) && policyCompatible
            && state.pressureTokens !== undefined
            && state.sampledSurfaceTokens !== undefined
            && state.pressureTokens >= state.sampledSurfaceTokens + header.tools + sampled;
        const projectedTokens = compatible
            ? Math.max(0, state.pressureTokens + state.surfaceTokens - state.sampledSurfaceTokens + current - sampled)
            : state.surfaceTokens + header.tools + current;
        const { contextWindow: _oldWindow, ...reported } = original;
        return {
            ...reported, projectedTokens,
            ...extra.context?.provider === header.provider && extra.context.model === header.model
                && original.contextWindow !== undefined ? { contextWindow: original.contextWindow } : {},
        };
    };
    const stateSchema = z.record(z.string(), z.unknown()).transform((value, ctx) => {
        const { codex, ...legacy } = value;
        const parsedBase = base.stateSchema.safeParse(legacy);
        const parsedExtra = extraSchema.safeParse(typeof codex === 'object' && codex !== null
            ? Object.fromEntries(Object.entries(codex).filter(([key]) => key !== 'view')) : codex);
        if (!parsedBase.success || !parsedExtra.success) {
            ctx.addIssue({ code: 'custom', message: 'invalid Codex pressure checkpoint' });
            return z.NEVER;
        }
        return { ...parsedBase.data, codex: { ...parsedExtra.data, view: view(parsedBase.data, parsedExtra.data) } };
    });
    return {
        key: 'contextPressure', stateVersion: 6, stateSchema,
        init: (header, inherited) => {
            const initial = base.init(header, inherited);
            const extra = {
                header: null, sample: null, sampleNative: null, nativeHistory: false, context: null,
                nodes: [], positions: [], sampledHidden: {},
            };
            return { ...initial, codex: { ...extra, view: view(initial, extra) } };
        },
        apply: (state, event) => {
            const next = base.apply(state, event);
            let extra = state.codex;
            if (event.type === 'request/header') {
                const nextRoute = route(event.data.header);
                if (nextRoute.fingerprint !== extra.header?.fingerprint)
                    extra = { ...extra, header: nextRoute };
            }
            if (event.type === 'request/context')
                extra = { ...extra, context: { provider: event.data.provider, model: event.data.model } };
            if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
                const usage = event.type === 'assistant/message' && event.data.usage !== undefined
                    ? event.data.usage : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage;
                if (usage !== undefined) {
                    const finish = lastAssistantStreamChunk(event.data.stream, 'finish');
                    const replay = finish?.replayState ?? (event.type === 'assistant/message'
                        && event.data.message.source.kind === 'model' ? event.data.message.source.replayState : undefined);
                    const native = replay === undefined || replay === null ? null : hasNativeCodexReplayKind(replay);
                    extra = { ...extra, sample: extra.header, sampledHidden: sums(extra.nodes), sampleNative: native,
                        nativeHistory: extra.nativeHistory || native === true };
                }
            }
            if (isSurfaceEvent(event)) {
                const message = deriveEventMessage(event);
                const source = message?.role === 'assistant' && message.source.kind === 'model' ? message.source : undefined;
                const originalNative = source !== undefined && hasNativeCodexReplayKind(source.replayState)
                    && (source.provider === CODEX_PROVIDER || source.provider === NATIVE_CODEX_PROVIDER);
                const price = originalNative ? estimateNativeCodexReplayTokens(source, event.type === 'assistant/message' ? event.data.usage : undefined) : 0;
                let nodes = extra.nodes;
                let positions = extra.positions;
                let position = event.seq;
                if (event.surfaceOp !== 'append') {
                    const { startSeq, endSeq } = event.surfaceOp;
                    const first = positions.find(node => node.seq === startSeq)?.position ?? startSeq;
                    const last = positions.find(node => node.seq === endSeq)?.position ?? endSeq;
                    if (last < first)
                        throw new Error('Codex pressure: invalid positional replacement');
                    position = first;
                    nodes = nodes.filter(node => node.position < first || node.position > last);
                    positions = [...positions.filter(node => node.position < first || node.position > last), { seq: event.seq, position }];
                }
                if (price > 0 && source !== undefined)
                    nodes = [...nodes, { seq: event.seq, position, provider: source.provider, tokens: price }];
                if (nodes !== extra.nodes || positions !== extra.positions || originalNative && !extra.nativeHistory) {
                    extra = { ...extra, nodes, positions, nativeHistory: extra.nativeHistory || originalNative };
                }
            }
            if (next === state && extra === state.codex)
                return state;
            const output = view(next, extra);
            return { ...next, codex: { ...extra, view: sameView(output, state.codex.view) ? state.codex.view : output } };
        },
        wire: { viewSchema: base.wire.viewSchema, view: state => state.codex.view },
    };
}
