/** Ordinary DSH image tools; cloud credentials never enter tool arguments. */
import type { Context } from '@deepseek-ai/cordis';
import { type NativeCodexModelCatalog } from './catalog.js';
import { NativeCodexCloudClient } from './cloud-http.js';
import type { NativeCodexHttpOptions } from './native-http.js';
import type { CodexImageDetail } from './responses.js';
export interface CloudToolsConfig {
    enabled?: boolean;
    search?: boolean;
    imageGeneration?: boolean;
    imageEditing?: boolean;
    imageInspection?: boolean;
    searchModel?: string;
    visionModel?: string;
    imageModel?: string;
    searchMode?: 'cached' | 'indexed' | 'live';
    visionDetail?: CodexImageDetail;
}
export interface CloudToolsDependencies {
    client: NativeCodexCloudClient;
    catalog: NativeCodexModelCatalog;
    transport: NativeCodexHttpOptions;
    config: CloudToolsConfig;
}
export declare function registerCodexImageTools(ctx: Context, deps: CloudToolsDependencies): void;
