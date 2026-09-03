/** Native Codex adapter with live catalog and HTTP/WebSocket transport delegation. */
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { NativeCodexModel, NativeCodexModelCatalog } from './catalog.js';
/** Production provider route owned by the package native Codex adapter after M6 cutover. */
export declare const CODEX_PROVIDER = "openai-codex";
/** Compatibility route retained for sessions created during the native preview. */
export declare const NATIVE_CODEX_PROVIDER = "openai-codex-native";
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
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
