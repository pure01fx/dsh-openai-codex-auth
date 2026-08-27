/** Experimental native Codex adapter; HTTP transport arrives in M3. */
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { NativeCodexModelCatalog } from './catalog.js';
/** Provider route reserved for the package-owned native Codex adapter. */
export declare const NATIVE_CODEX_PROVIDER = "openai-codex-native";
/** Package-owned DSH adapter with live catalog metadata and an M3 transport boundary. */
export declare class NativeCodexAdapter extends LlmAdapter {
    private readonly catalog?;
    constructor(catalog?: NativeCodexModelCatalog | undefined);
    private assertProvider;
    private assertNotAborted;
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
