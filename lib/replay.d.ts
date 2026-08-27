/** Bounded, versioned Codex Responses continuation state. */
import { type ContentBlock } from '@deepseek-ai/dsh-llm';
export declare const NATIVE_CODEX_REPLAY_KIND = "openai-codex-native.responses-replay";
export declare const NATIVE_CODEX_REPLAY_VERSION = 1;
export type NativeCodexReplayDescriptor = {
    type: 'message';
    id?: string;
    blocks: number[];
} | {
    type: 'reasoning';
    id?: string;
    blocks: number[];
    encryptedContent?: string;
} | {
    type: 'function_call';
    id?: string;
    block: number;
};
export interface NativeCodexReplayState {
    kind: typeof NATIVE_CODEX_REPLAY_KIND;
    version: typeof NATIVE_CODEX_REPLAY_VERSION;
    provider: string;
    model: string;
    items: NativeCodexReplayDescriptor[];
}
export interface NativeCodexReplaySource {
    provider: string;
    model: string;
    replayState: unknown;
}
/** Preserve only server item IDs that Codex itself would replay. */
export declare function replayableItemId(value: string | undefined): string | undefined;
/** Attempt-local bounded accumulator; no ciphertext can grow unchecked before completion. */
export declare class NativeCodexReplayCapture {
    private readonly provider;
    private readonly model;
    private readonly descriptors;
    private references;
    private stateBytes;
    constructor(provider: string, model: string);
    add(item: NativeCodexReplayDescriptor): void;
    finish(): NativeCodexReplayState | undefined;
}
/** Create state only for a successful response with completed replay descriptors. */
export declare function createNativeCodexReplayState(provider: string, model: string, items: readonly NativeCodexReplayDescriptor[]): NativeCodexReplayState | undefined;
/** Reconstruct provider items without duplicating durable visible block payloads in state. */
export declare function replayAssistantInput(content: readonly ContentBlock[], source: NativeCodexReplaySource): Record<string, unknown>[];
