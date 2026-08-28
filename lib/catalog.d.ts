export { CODEX_CLIENT_VERSION } from './upstream.js';
export declare const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
export declare const CODEX_CATALOG_CACHE_TTL_MS: number;
/** One request-scoped credential for native Codex backend calls. */
export interface NativeCodexCredential {
    accessToken: string;
    accountId: string;
}
/** Resolve current native Codex authority without retaining it across operations. */
export type NativeCodexCredentialResolver = (signal?: AbortSignal) => Promise<NativeCodexCredential>;
export interface NativeCodexReasoningLevel {
    effort: string;
    description?: string;
}
export interface NativeCodexServiceTier {
    id: string;
    name?: string;
    description?: string;
}
/** Validated subset of codex-rs ModelInfo used by DSH metadata and later transport milestones. */
export interface NativeCodexModel {
    slug: string;
    displayName: string;
    description?: string;
    defaultReasoningLevel?: string;
    supportedReasoningLevels: readonly NativeCodexReasoningLevel[];
    multiAgentReasoningEffort?: string;
    visibility: string;
    supportedInApi: boolean;
    priority: number;
    additionalSpeedTiers: readonly string[];
    serviceTiers: readonly NativeCodexServiceTier[];
    defaultServiceTier?: string;
    contextWindow?: number;
    inputModalities: readonly string[];
}
export interface NativeCodexCatalogView {
    models: readonly NativeCodexModel[];
    authorityHash?: string;
}
/** Narrow catalog seam consumed by the adapter and injectable in tests. */
export interface NativeCodexModelCatalog {
    list(signal?: AbortSignal): Promise<readonly NativeCodexModel[]>;
    listWithAuthority?(signal?: AbortSignal): Promise<NativeCodexCatalogView>;
    etag(): string | undefined;
}
export interface NativeCodexCatalogOptions {
    resolveCredential: NativeCodexCredentialResolver;
    endpoint?: string;
    clientVersion?: string;
    cacheTtlMs?: number;
    maxStaleMs?: number;
    timeoutMs?: number;
    fetch?: typeof fetch;
    now?: () => number;
    warn?: (message: string) => void;
}
export declare function nativeCodexAuthorityHash(accountId: string): string;
/** Codex-compatible live catalog with bounded stale fallback and no credential retention. */
export declare class NativeCodexCatalog implements NativeCodexModelCatalog {
    private readonly options;
    private readonly endpoint;
    private readonly clientVersion;
    private readonly cacheTtlMs;
    private readonly maxStaleMs;
    private readonly timeoutMs;
    private readonly fetchImpl;
    private readonly now;
    private snapshot;
    private readonly refreshes;
    private currentEtag;
    constructor(options: NativeCodexCatalogOptions);
    etag(): string | undefined;
    list(signal?: AbortSignal): Promise<readonly NativeCodexModel[]>;
    listWithAuthority(signal?: AbortSignal): Promise<NativeCodexCatalogView>;
    private fetchCatalog;
}
