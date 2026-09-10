type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export interface CloudSearchArgs {
    commands: Record<string, Json>;
    model?: string;
    context?: string;
    mode?: 'cached' | 'indexed' | 'live';
    search_context_size?: 'low' | 'medium' | 'high';
    user_location?: Record<string, string>;
    filters?: Record<string, string[]>;
    image_settings?: {
        max_results?: number;
        caption?: boolean;
    };
}
export declare function parseCloudSearchArgs(value: unknown): CloudSearchArgs;
/** The caller selects the model and visible context using the same request credential. */
export declare function buildCloudSearchRequest(args: CloudSearchArgs, context: {
    sessionId: string;
    accountId: string;
    model: string;
    input?: unknown;
}): Record<string, unknown>;
/** Keep whole opaque result entries and identify any omitted data explicitly. */
export declare function parseCloudSearchResponse(body: unknown): {
    output: string;
    results?: unknown[];
    truncated: boolean;
};
export {};
