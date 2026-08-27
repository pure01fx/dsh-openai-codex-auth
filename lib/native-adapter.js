/** Experimental native Codex adapter seam; transport arrives in M3. */
import { LlmAdapter, LlmError, } from '@deepseek-ai/dsh-llm';
/** Provider route reserved for the package-owned native Codex adapter. */
export const NATIVE_CODEX_PROVIDER = 'openai-codex-native';
/**
 * M1 registration and metadata skeleton for the native Codex route.
 * HTTP request serialization and streaming transport intentionally belong to M3.
 */
export class NativeCodexAdapter extends LlmAdapter {
    assertProvider(provider) {
        if (provider !== NATIVE_CODEX_PROVIDER) {
            throw new LlmError(`native Codex adapter does not own provider "${provider}"`, 'NO_ADAPTER');
        }
    }
    assertNotAborted(signal) {
        if (signal?.aborted) {
            throw new LlmError('native Codex request was aborted', 'ABORTED');
        }
    }
    providerInfo(provider) {
        this.assertProvider(provider);
        return { id: provider, name: 'OpenAI Codex (Native, Experimental)' };
    }
    async listModels(provider) {
        this.assertProvider(provider);
        return [];
    }
    async resolveModel(provider, model, signal) {
        this.assertNotAborted(signal);
        this.assertProvider(provider);
        return { provider, id: model, name: model };
    }
    async *stream(options) {
        this.assertNotAborted(options.signal);
        this.assertProvider(options.provider);
        throw new LlmError('native Codex transport is not implemented in M1', 'NATIVE_TRANSPORT_NOT_READY');
    }
}
