/** Experimental native Codex adapter with live catalog and HTTP transport delegation. */
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { NativeCodexModelCatalog } from './catalog.js';
/** Provider route reserved for the package-owned native Codex adapter. */
export declare const NATIVE_CODEX_PROVIDER = "openai-codex-native";
/** Request-scoped native Codex transport owned by this package. */
export interface NativeCodexTransport {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
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
