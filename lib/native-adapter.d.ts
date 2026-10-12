/** Native Codex adapter with live catalog and HTTP/WebSocket transport delegation. */
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmRuntime, type LlmProviderInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { type Context } from '@deepseek-ai/cordis';
import type { NativeCodexModel, NativeCodexModelCatalog } from './catalog.js';
/** Production provider route owned by the package native Codex adapter after M6 cutover. */
export declare const CODEX_PROVIDER = "openai-codex";
/** Compatibility route retained for sessions created during the native preview. */
export declare const NATIVE_CODEX_PROVIDER = "openai-codex-native";
/**
 * Register native routes and their replay-pricing ownership in the same Cordis scope.
 * @param ctx - scope owning the native adapter registration.
 * @param providers - canonical and optional compatibility routes for this instance.
 * @param adapter - native adapter that will replay its own continuation state.
 */
export declare function registerNativeCodexAdapter(ctx: Context, providers: string[], adapter: NativeCodexAdapter): void;
/**
 * Match the runtime's same-adapter ownership rule for native continuation replay.
 * @param runtime - current global LLM service instance.
 * @param sourceProvider - provider that produced the historical assistant message.
 * @param targetProvider - provider preparing the measured request.
 * @returns whether both routes are currently owned by the same native adapter.
 */
export declare function canReplayNativeCodex(runtime: LlmRuntime, sourceProvider: string, targetProvider: string): boolean;
export declare const CODEX_FAST_ALIAS_SUFFIX = "-fast";
export declare const CODEX_FAST_SERVICE_TIER = "priority";
/** Pure network establishment failure; retried without consuming the finite stream budget. */
export declare const NATIVE_CODEX_CONNECTION_FAILED_CODE = "NATIVE_CODEX_CONNECTION_FAILED";
/** Retryable only at DSH's durable failed-step boundary after output became visible. */
export declare const NATIVE_CODEX_STREAM_INTERRUPTED_CODE = "NATIVE_CODEX_STREAM_INTERRUPTED";
/** Identify only DNS/TCP/socket establishment failures suitable for unbounded recovery. */
export declare function isNativeCodexConnectionFailure(error: unknown, depth?: number): boolean;
/** Match Codex's model-aware mapping from UI reasoning choices to Responses wire values. */
export declare function nativeCodexWireReasoningEffort(effort: string | undefined, model?: NativeCodexModel): string | undefined;
/** Request-scoped native Codex transport owned by this package. */
export interface NativeCodexTransportMode {
    serviceTier?: typeof CODEX_FAST_SERVICE_TIER;
    /** Enables the model-specific Responses Lite request and routing contract. */
    responsesLite?: {
        defaultVerbosity?: string;
        instructionsTemplate?: string;
    };
    publicModel?: string;
    authorityHash?: string;
    /** Turn-scoped sticky routing state captured from a provider response. */
    turnState?: string;
    /** @internal Receives a newly observed bounded turn-state token. */
    captureTurnState?: (state: string) => void;
    /** @internal Pins WebSocket reconnects and HTTP fallback to one account. */
    pinnedAccountId?: string;
}
export interface NativeCodexTransport {
    stream(options: GenerateOptions, mode?: NativeCodexTransportMode): AsyncIterable<StreamChunk>;
}
/** Package-owned DSH adapter with live catalog metadata and native transport delegation. */
export declare class NativeCodexAdapter extends LlmAdapter {
    private readonly catalog?;
    private readonly transport?;
    constructor(catalog?: NativeCodexModelCatalog | undefined, transport?: NativeCodexTransport | undefined);
    private assertProvider;
    private assertNotAborted;
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(provider: string): ResolvedRetryPolicy;
    /**
     * Read model metadata, retrying once when a fetch returned nothing. The catalog
     * caches nothing on failure, so a momentary outage otherwise empties every model
     * list it touches; metadata is advisory and one extra request is cheaper than a
     * provider that disappears from the picker until the next attempt.
     */
    private catalogModels;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
