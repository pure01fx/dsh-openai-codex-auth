import { CallId, LlmError, type ContentBlock, type GenerateOptions, type StreamChunk, type TokenUsage, type ToolSchema } from '@deepseek-ai/dsh-llm';
import { type ParseSseOptions } from './sse.js';
import { type NativeCodexReplaySource } from './replay.js';
export declare const DEFAULT_CODEX_INSTRUCTIONS = "You are Codex, an AI coding agent. Help the user with software engineering tasks.";
export interface ResolvedImagePart {
    type: 'image';
    mediaType: string;
    dataBase64: string;
}
export interface ResolvedToolResultPart {
    type: 'tool-result';
    toolCallId: CallId;
    content: readonly ResolvedContentPart[];
    isError?: boolean;
}
export type ResolvedContentPart = Exclude<ContentBlock, {
    type: 'image' | 'tool-result';
}> | ResolvedImagePart | ResolvedToolResultPart;
export interface ResolvedMessage {
    role: 'system' | 'user' | 'assistant';
    content: readonly ResolvedContentPart[];
    replaySource?: NativeCodexReplaySource;
}
export interface ResponsesRequestInput {
    instructions?: string;
    input: Record<string, unknown>[];
}
export declare function toResponsesTools(tools: readonly ToolSchema[]): Record<string, unknown>[];
/** Convert resolved DSH messages into Responses instructions and ordered input items. */
export declare function toResponsesInput(messages: readonly ResolvedMessage[], system?: string): ResponsesRequestInput;
/** Bound call ids while preserving every function call/result correlation. */
export declare function normalizeCodexCallIds(input: readonly Record<string, unknown>[]): Record<string, unknown>[];
export interface ResponsesRequestMode {
    serviceTier?: 'priority';
}
/** Build the canonical Standard/Fast HTTP Responses body. */
export declare function codexRequestBody(options: GenerateOptions, messages: readonly ResolvedMessage[], mode?: ResponsesRequestMode): Record<string, unknown>;
export interface ResponsesUsage {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: {
        cached_tokens?: number;
        cache_write_tokens?: number;
    };
    output_tokens_details?: {
        reasoning_tokens?: number;
    };
}
/** Map provider totals to DSH's strict disjoint token counts. */
export declare function mapResponsesUsage(usage: ResponsesUsage): TokenUsage;
/** Classify in-band failure data without reflecting provider text. */
export declare function responsesFailure(code?: string, message?: string): LlmError;
interface ResponsesOutputItem {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    encrypted_content?: string;
    summary?: unknown[];
    status?: string;
    content?: Array<{
        type?: string;
        text?: string;
    }>;
}
export interface ResponsesStreamEvent {
    type: string;
    item_id?: string;
    output_index?: number;
    content_index?: number;
    summary_index?: number;
    delta?: string;
    text?: string;
    call_id?: string;
    name?: string;
    item?: ResponsesOutputItem;
    response?: {
        status?: string;
        usage?: ResponsesUsage;
        error?: {
            code?: string;
            message?: string;
        };
        incomplete_details?: {
            reason?: string;
        };
    };
    code?: string;
    message?: string;
}
export interface ResponsesReplayContext {
    provider: string;
    model: string;
}
/** Stateful, transport-free Responses event to DSH chunk translator. */
export declare class ResponsesStreamTranslator {
    private readonly replayContext?;
    private readonly blocks;
    private readonly order;
    private readonly replayCapture;
    private nextIndex;
    private sawToolCall;
    terminated: boolean;
    constructor(replayContext?: ResponsesReplayContext | undefined);
    private open;
    private close;
    private closeItem;
    private closeAll;
    push(event: ResponsesStreamEvent): StreamChunk[];
    endOfStream(): never;
}
export interface StreamResponsesOptions extends ParseSseOptions {
    onMalformedEvent?: () => void;
    onEvent?: (event: ResponsesStreamEvent) => void;
    replayContext?: ResponsesReplayContext;
    maxResponseBytes?: number;
    maxResponseEvents?: number;
}
/** Validate one opaque sticky turn token before retaining or forwarding it. */
export declare function boundedCodexTurnState(value: unknown): string | undefined;
/** Extract the bounded sticky turn token from provider metadata/event shapes. */
export declare function codexResponseTurnState(event: ResponsesStreamEvent): string | undefined;
/** Consume framed SSE JSON into DSH chunks. */
export declare function streamResponses(stream: ReadableStream<Uint8Array>, options?: StreamResponsesOptions): AsyncGenerator<StreamChunk>;
export {};
