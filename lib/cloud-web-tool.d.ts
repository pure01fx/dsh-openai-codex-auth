/** Native codex_web registration. No private host APIs or third-party OAuth requests. */
import type { Context } from '@deepseek-ai/cordis';
import { type NativeCodexModelCatalog } from './catalog.js';
import type { NativeCodexCloudClient } from './cloud-http.js';
export declare function registerCodexWeb(ctx: Context, deps: {
    client: NativeCodexCloudClient;
    catalog: NativeCodexModelCatalog;
    config: {
        searchModel?: string;
        searchMode?: 'live' | 'indexed' | 'cached';
    };
}): void;
