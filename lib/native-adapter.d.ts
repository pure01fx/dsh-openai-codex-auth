/** Experimental native Codex adapter seam; transport arrives in M3. */
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
/** Provider route reserved for the package-owned native Codex adapter. */
export declare const NATIVE_CODEX_PROVIDER = "openai-codex-native";
/**
 * M1 registration and metadata skeleton for the native Codex route.
 * HTTP request serialization and streaming transport intentionally belong to M3.
 */
export declare class NativeCodexAdapter extends LlmAdapter {
    private assertProvider;
    private assertNotAborted;
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
