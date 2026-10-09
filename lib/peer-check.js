/**
 * peer 依赖预检：判断某个皮肤包「声明需要的 DSH 内部包版本」与本机实际版本是否匹配。
 *
 * 为什么需要它（真实踩坑）：`dsh-neu-theme@0.1.2` 的 peerDependencies 只写到 `^0.1.x`，
 * 而本机是 `0.2.0-rc.2`。安装会被 DSH 的版本闸门直接拒绝，但失败原因只写进 pnpm 日志 ——
 * 用户在市场上点「安装并使用」只会看到一个失败弹窗，无从判断"这个包根本装不了"。
 * 本模块把这一步提前：读取 npm 上的 peerDependencies，与本机版本比对，给出可解释的结论。
 *
 * 设计约束：
 *   - **只在用户明确要求时调用**（详情页/单卡），不做全量扫描 —— 302 个包逐个拉 npm 会很慢；
 *   - 带内存缓存（同一次运行内不重复请求），失败不抛错、降级为 'unknown'；
 *   - 只关心 DSH 自身的运行时包，忽略 react 等由包管理器解决的 peer。
 */
import { satisfiesVersionRange } from './semver.js';
/** 命中这些前缀的 peer 视为「DSH 自身运行时包」，需要与本机版本比对。 */
const DSH_RUNTIME_PEER_PATTERN = /^@deepseek-ai\/dsh-([a-z0-9-]+)$/;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const NPM_REGISTRY = 'https://registry.npmjs.org';
const cache = new Map();
async function fetchPackument(packageName) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const url = `${NPM_REGISTRY}/${packageName.replace('/', '%2F')}`;
        const response = await fetch(url, {
            headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
            signal: controller.signal,
        });
        if (!response.ok)
            return null;
        return (await response.json());
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 检查一个皮肤包的 peer 依赖兼容性。
 * @param packageName npm 包名（来自 catalog 的 install.desktop.packageName）
 * @param packageVersion 目录声明的版本；为空时取 npm 上的 latest
 * @param dshVersion 本机 DSH 版本（detectDshRuntime().version）
 */
export async function checkSkinPeers(packageName, packageVersion, dshVersion) {
    const cacheKey = `${packageName}@${packageVersion ?? 'latest'}#${dshVersion ?? 'unknown'}`;
    const hit = cache.get(cacheKey);
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) {
        return { ...hit.result, cached: true };
    }
    const base = {
        packageName,
        version: packageVersion,
    };
    const store = (result) => {
        const full = { ...result, cached: false };
        cache.set(cacheKey, { at: Date.now(), result: full });
        return full;
    };
    if (dshVersion === null) {
        return store({ ...base, verdict: 'unknown', reason: '无法确定本机 DSH 版本，跳过检查', offenders: [] });
    }
    const packument = await fetchPackument(packageName);
    if (packument?.versions === undefined) {
        return store({
            ...base,
            verdict: 'unknown',
            reason: '读取 npm 包信息失败（网络不可达或包不存在），无法预检',
            offenders: [],
        });
    }
    const version = packageVersion !== null && packageVersion !== '' && packument.versions[packageVersion] !== undefined
        ? packageVersion
        : (packument['dist-tags']?.latest ?? null);
    if (version === null || packument.versions[version] === undefined) {
        return store({ ...base, verdict: 'unknown', reason: 'npm 上没有可用版本，无法预检', offenders: [] });
    }
    const manifest = packument.versions[version] ?? {};
    const peers = manifest.peerDependencies ?? {};
    const meta = manifest.peerDependenciesMeta ?? {};
    const offenders = [];
    for (const [peerName, range] of Object.entries(peers)) {
        if (!DSH_RUNTIME_PEER_PATTERN.test(peerName))
            continue;
        // 显式标记为 optional 的 peer 不算阻碍（宿主可能本就不提供）
        if (meta[peerName]?.optional === true)
            continue;
        if (!satisfiesVersionRange(dshVersion, range))
            offenders.push(`${peerName}@${range}`);
    }
    if (offenders.length === 0) {
        return store({
            packageName,
            version,
            verdict: 'ok',
            reason: `声明的 peer 依赖与本机 DSH ${dshVersion} 兼容`,
            offenders: [],
        });
    }
    return store({
        packageName,
        version,
        verdict: 'blocked',
        reason: `该包声明的 peer 依赖与本机 DSH ${dshVersion} 不匹配，安装会被版本闸门拒绝：` +
            offenders.slice(0, 3).join('、') +
            (offenders.length > 3 ? ` 等 ${offenders.length} 项` : ''),
        offenders,
    });
}
/** 供调试/统计：当前缓存条目数。 */
export function peerCacheSize() {
    return cache.size;
}
