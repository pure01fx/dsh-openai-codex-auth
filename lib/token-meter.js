/** Codex hidden-replay pricing layered over the host's ordinary token meter. */
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { capturePressureRegistration, codexPressureProjection } from './pressure-projection.js';
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate';
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm';
import { canonicalHeader, deriveEventMessage, headerEquals, isSurfaceEvent, SessionSeq, } from '@deepseek-ai/dsh-session';
import { canReplayNativeCodex, nativeCodexReplayGroups } from './native-adapter.js';
import { estimateNativeCodexReplayTokens } from './replay.js';
function replayPrice(message, usage) {
    if (message?.role !== 'assistant' || message.source.kind !== 'model')
        return undefined;
    return { source: message.source, usage };
}
function sameHeader(a, b) {
    return a === undefined || b === undefined ? a === b : headerEquals(a, b);
}
/**
 * Replacement tokenMeter service that charges native Codex encrypted reasoning.
 * Ordinary prices, usage, and breakdown projections come from the host meter.
 * The UI pressure unit adds the same hidden pricing per logged request route. Hidden prices apply
 * only between routes currently owned by the same native adapter; fixed
 * heuristicTokens stay unchanged. Provider usage is not charged a second time.
 */
export class CodexTokenMeter extends TokenMeter {
    static inject = ['sessionProjections', 'llm'];
    hiddenFolds = new WeakMap();
    constructor(ctx, config) {
        const capture = capturePressureRegistration(ctx);
        super(capture.context, config);
        let unregister;
        let policy;
        const refresh = () => {
            const groups = nativeCodexReplayGroups(ctx.get('llm'));
            const fingerprint = JSON.stringify(groups);
            if (fingerprint === policy)
                return;
            unregister?.();
            unregister = capture.register(codexPressureProjection(capture.definition, groups));
            policy = fingerprint;
        };
        refresh();
        ctx.on('codex/replay-owners-updated', refresh);
        ctx.effect(() => () => { unregister?.(); });
    }
    /**
     * Return a detached measurement including opaque native replay in node prices,
     * surface totals, and signed anchor deltas. Recheck usage conservatism against
     * the corrected full anchor before reusing the provider sample.
     * @param session - session to price through its current durable tail.
     * @param requestHeader - optional effective routed request envelope.
     * @returns immutable request pressure and positional message prices.
     */
    measure(session, requestHeader) {
        const base = super.measure(session, requestHeader);
        const state = this.syncHidden(session, base.logRevision);
        const header = requestHeader === undefined ? state.header : canonicalHeader(requestHeader);
        const runtime = this.ctx.get('llm');
        const provider = header?.config?.provider;
        if (runtime === undefined || provider === undefined)
            return base;
        const price = (replay) => {
            if (replay === undefined || !canReplayNativeCodex(runtime, replay.source.provider, provider))
                return 0;
            return replay.tokens ??= estimateNativeCodexReplayTokens(replay.source, replay.usage);
        };
        const current = new Map(state.nodes.map(node => [node.seq, price(node.replay)]));
        const hiddenCurrent = base.nodes.reduce((total, node) => total + (current.get(node.seq) ?? 0), 0);
        const anchor = state.anchor;
        const matched = anchor !== undefined && sameHeader(anchor.header, header);
        const hiddenAnchor = matched
            ? anchor.nodes.reduce((total, node) => total + price(node.replay), 0) + price(anchor.assistant)
            : 0;
        if (hiddenCurrent === 0 && hiddenAnchor === 0)
            return base;
        let baseline = base.baseline;
        let surfaceDeltaTokens = base.surfaceDeltaTokens;
        if (matched) {
            surfaceDeltaTokens += hiddenCurrent - hiddenAnchor;
            if (base.baseline.kind === 'usage') {
                const estimatedAnchor = estimateToolsTokens(header)
                    + base.surfaceTokens - base.surfaceDeltaTokens + hiddenAnchor;
                if (base.baseline.tokens < estimatedAnchor) {
                    baseline = Object.freeze({ kind: 'estimated', tokens: estimatedAnchor });
                }
            }
            else if (base.baseline.kind === 'estimated') {
                baseline = Object.freeze({ kind: 'estimated', tokens: base.baseline.tokens + hiddenAnchor });
            }
        }
        else if (base.baseline.kind === 'estimated') {
            baseline = Object.freeze({ kind: 'estimated', tokens: base.baseline.tokens + hiddenCurrent });
        }
        const nodes = Object.freeze(base.nodes.map(node => Object.freeze({
            ...node, tokens: node.tokens + (current.get(node.seq) ?? 0),
        })));
        return Object.freeze({
            ...base,
            baseline,
            surfaceDeltaTokens,
            totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
            surfaceTokens: base.surfaceTokens + hiddenCurrent,
            nodes,
        });
    }
    /** Track only replay metadata and surface positions; the host validates each event first. */
    syncHidden(session, revision) {
        let state = this.hiddenFolds.get(session);
        if (state === undefined) {
            state = { consumed: 0, header: undefined, nodes: [], anchor: undefined };
            this.hiddenFolds.set(session, state);
        }
        while (state.consumed < revision) {
            const event = session.eventAt(SessionSeq(state.consumed));
            if (event === undefined)
                throw new Error('Codex token meter: missing consumed session event');
            this.foldHidden(state, event);
            state.consumed++;
        }
        return state;
    }
    foldHidden(state, event) {
        const header = event.type === 'request/header' ? canonicalHeader(event.data.header) : state.header;
        const node = isSurfaceEvent(event) ? {
            seq: event.seq,
            replay: replayPrice(deriveEventMessage(event), event.type === 'assistant/message' ? event.data.usage : undefined),
        } : undefined;
        let anchor = state.anchor;
        if (event.type === 'assistant/message') {
            const route = header?.config;
            const original = event.data.usage !== undefined && route !== undefined
                ? { source: {
                        provider: route.provider,
                        model: route.model,
                        replayState: assembleAssistantStream(event.data.stream).replayState,
                    }, usage: event.data.usage }
                : node?.replay;
            anchor = { header, nodes: state.nodes.slice(), assistant: original };
        }
        if (node !== undefined && isSurfaceEvent(event)) {
            if (event.surfaceOp === 'append') {
                state.nodes.push(node);
            }
            else {
                const { startSeq, endSeq } = event.surfaceOp;
                const first = state.nodes.findIndex(item => item.seq === startSeq);
                const last = state.nodes.findIndex(item => item.seq === endSeq);
                if (first < 0 || last < first)
                    throw new Error('Codex token meter: invalid surface replacement');
                state.nodes.splice(first, last - first + 1, node);
            }
        }
        state.header = header;
        state.anchor = anchor;
    }
}
export default CodexTokenMeter;
