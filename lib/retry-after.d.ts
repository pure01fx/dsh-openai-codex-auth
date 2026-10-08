/** Server advice is separate from the client's bounded exponential backoff. */
import { LlmError } from '@deepseek-ai/dsh-llm';
export declare function retryAfterMs(raw: unknown): number | undefined;
export declare function jsonRetryAfterMs(headers: unknown): number | undefined;
export declare function retryError(message: string, code: string, options?: ConstructorParameters<typeof LlmError>[2]): LlmError;
export declare function inheritRetryDeadline(error: LlmError, source: LlmError): LlmError;
export declare function remainingRetryDelay(error: LlmError): number | undefined;
/** Node timers overflow above 2^31-1; chunk long waits without shortening advice. */
export declare function sleepRetry(delay: number, signal?: AbortSignal): Promise<void>;
