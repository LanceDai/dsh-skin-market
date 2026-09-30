import type { PluginRunner } from './commands.ts';
import type { OperationFailure } from './types.ts';
export declare const MARKET_NPM_PACKAGE = "dsh-skin-market";
export declare const MARKET_NPM_METADATA_URL = "https://registry.npmjs.org/dsh-skin-market";
export interface MarketUpdateStatus {
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
}
export type MarketUpdatePhase = 'queued' | 'checking' | 'downloading' | 'installing' | 'cancelling' | 'cancelled' | 'done' | 'failed';
export interface MarketUpdateOperation {
    id: string;
    phase: MarketUpdatePhase;
    message?: string;
    status?: MarketUpdateStatus;
    cancelable?: boolean;
    downloadedBytes?: number;
    totalBytes?: number;
    bytesPerSecond?: number;
    failure?: OperationFailure;
    startedAt: string;
    finishedAt?: string;
}
export interface MarketUpdater {
    status(force?: boolean): Promise<MarketUpdateStatus>;
    update(): Promise<MarketUpdateStatus>;
    startUpdate(): MarketUpdateOperation;
    operation(id: string): MarketUpdateOperation | null;
    currentOperation(): MarketUpdateOperation | null;
    cancel(id: string): MarketUpdateOperation;
    retry(id: string): MarketUpdateOperation;
    /** Stop a route mount cleanly, joining any host package-manager request. */
    dispose?(): Promise<void>;
    readonly restartRequired: boolean;
}
export declare function packageVersion(): string;
export { compareVersions } from './semver.ts';
export declare function createMarketUpdater(profile: string, runner: PluginRunner, options?: {
    currentVersion?: string;
    fetch?: typeof fetch;
    cacheMs?: number;
    profileDir?: string;
}): MarketUpdater;
