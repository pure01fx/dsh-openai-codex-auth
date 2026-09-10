/** Caller-visible context only; never project reasoning, plugin instructions or replay state. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { type Message } from '@deepseek-ai/dsh-llm';
import type { NativeCodexModel } from './catalog.js';
export declare function chooseCloudModel(params: {
    requested?: string | undefined;
    configured?: string | undefined;
    currentProvider?: string | undefined;
    currentModel?: string | undefined;
    purpose: 'search' | 'vision';
}, models: readonly NativeCodexModel[]): NativeCodexModel;
/** Only results paired with a preceding call and their owning source can grant image visibility. */
export declare function visibleCloudImages(messages: readonly Message[]): ImageAttachmentRef[];
/** Last two human texts plus intervening visible assistant text. UTF-8 bytes conservatively
 * upper-bound byte-level tokenizer tokens; a single 1000-byte assistant budget avoids
 * relying on an unavailable model tokenizer. User text has a separate 64 KiB cap. */
export declare function recentSearchInput(messages: readonly Message[]): {
    role: 'user' | 'assistant';
    content: string;
}[];
