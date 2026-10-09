/** 结论类型：ok=可装；blocked=会被版本闸门拒绝；unknown=拿不到信息/无需判断。 */
export type PeerVerdict = 'ok' | 'blocked' | 'unknown';
export interface PeerCheckResult {
    packageName: string;
    version: string | null;
    verdict: PeerVerdict;
    /** 人类可读的原因（blocked 时列出具体不匹配的 peer） */
    reason: string;
    /** blocked 时列出不匹配项，供界面展示 */
    offenders: string[];
    /** 结论来自缓存还是本次网络请求 */
    cached: boolean;
}
/**
 * 检查一个皮肤包的 peer 依赖兼容性。
 * @param packageName npm 包名（来自 catalog 的 install.desktop.packageName）
 * @param packageVersion 目录声明的版本；为空时取 npm 上的 latest
 * @param dshVersion 本机 DSH 版本（detectDshRuntime().version）
 */
export declare function checkSkinPeers(packageName: string, packageVersion: string | null, dshVersion: string | null): Promise<PeerCheckResult>;
/** 供调试/统计：当前缓存条目数。 */
export declare function peerCacheSize(): number;
