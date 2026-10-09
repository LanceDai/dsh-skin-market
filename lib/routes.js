import { randomUUID } from 'node:crypto';
import { CatalogStore, catalogWithStars } from './catalog.js';
import { readOperationRetryAction, readRestartTarget, readSkinId, sameOrigin, sendJson, sendText } from './http.js';
import { SkinLifecycle } from './lifecycle.js';
import { installedClientPlugins, resolveProfileDir } from './profile.js';
import { createMarketUpdater, packageVersion } from './self-update.js';
import { exportLogs } from './log.js';
import { checkSkinPeers } from './peer-check.js';
export function canRestartSkin(state) {
    return state?.installation === 'installed'
        && (state.activation === 'active' || state.activation === 'restart-required');
}
export function runningAgentCount(host) {
    return host.agents?.list().filter(agent => agent.status === 'running').length ?? 0;
}
const RESTART_BLOCKING_KINDS = new Set(['install', 'update', 'migrate', 'uninstall']);
export function restartBlockingOperations(operations) {
    return operations.filter(operation => operation.phase !== 'done'
        && operation.phase !== 'failed'
        && operation.phase !== 'cancelled'
        && RESTART_BLOCKING_KINDS.has(operation.kind));
}
export function assertRestartClearOfSkinOperations(operations, marketUpdate) {
    const blocking = restartBlockingOperations(operations);
    if (blocking.length > 0) {
        throw new Error(`还有 ${blocking.length} 个皮肤正在安装或更新，现在不能重启。请等待完成或先取消，否则会中断下载并可能损坏 profile`);
    }
    if (marketUpdate !== undefined && marketUpdate !== null
        && marketUpdate.phase !== 'done' && marketUpdate.phase !== 'failed' && marketUpdate.phase !== 'cancelled') {
        throw new Error('皮肤市场正在更新，现在不能重启。请等待完成或先取消');
    }
}
export async function waitForRestartSafety(host) {
    const agents = host.agents?.list() ?? [];
    const running = agents.filter(agent => agent.status === 'running').length;
    if (running > 0)
        throw new Error(`检测到 ${running} 个 Agent 正在运行，请等待任务完全结束后再重启`);
    // An Agent can still be finishing maintenance while its public status is
    // idle. whenIdle() includes that maintenance and the turn checkpoint.
    await Promise.all(agents.map(agent => agent.whenIdle()));
    const startedDuringCheck = runningAgentCount(host);
    if (startedDuringCheck > 0)
        throw new Error(`检测到 ${startedDuringCheck} 个 Agent 刚刚开始运行，请稍后再重启`);
}
function method(request, response, expected) {
    if (request.method === expected)
        return true;
    response.writeHead(405, { allow: expected });
    response.end();
    return false;
}
export function mountRoutes(host, options) {
    // Resolve once at the route boundary so every lifecycle/catalog operation
    // uses the same profile. In particular, an official Desktop route with no
    // profileContext.dir resolves the Desktop profile and never silently uses
    // the Web profile.
    const profileDir = options.profileDir ?? resolveProfileDir(options.profile);
    const catalogStore = options.catalogStore ?? new CatalogStore(profileDir);
    const initialCatalog = catalogStore.snapshot().catalog;
    const hostKind = options.hostKind ?? options.runner.hostKind ?? 'dsh';
    // Keep the optional Agent registry on a prototype wrapper so Cordis host
    // methods and lifecycle services retain their original receiver. Official
    // Desktop simply leaves this undefined; Web keeps the existing restart
    // safety checks when the service is available.
    // An explicit `agents: undefined` is meaningful for official Desktop: its
    // host exposes a throwing lazy-injection getter when the Agent service is
    // absent. Shadow that getter while preserving the original host object when
    // callers omit the option entirely.
    let routeHost = host;
    if (Object.prototype.hasOwnProperty.call(options, 'agents')) {
        routeHost = Object.create(host);
        Object.defineProperty(routeHost, 'agents', {
            configurable: true,
            enumerable: true,
            value: options.agents,
            writable: true,
        });
    }
    const lifecycle = new SkinLifecycle(routeHost, { ...options, profileDir, hostKind }, initialCatalog.skins);
    lifecycle.start();
    let lifecycleCatalogGeneratedAt = initialCatalog.generatedAt;
    const instanceId = randomUUID();
    const marketUpdater = options.marketUpdater ?? createMarketUpdater(options.profile, options.runner, { profileDir });
    const catalogPayload = async (force) => {
        const snapshot = await catalogStore.refresh(force);
        if (snapshot.catalog.generatedAt !== lifecycleCatalogGeneratedAt) {
            await lifecycle.replaceCatalog(snapshot.catalog.skins);
            lifecycleCatalogGeneratedAt = snapshot.catalog.generatedAt;
        }
        return {
            schemaVersion: snapshot.catalog.schemaVersion,
            generatedAt: snapshot.catalog.generatedAt,
            skins: await catalogWithStars(profileDir, snapshot.catalog),
            catalogSource: snapshot.source,
            catalogLastCheckedAt: snapshot.lastCheckedAt,
            ...(snapshot.error ? { catalogError: snapshot.error } : {}),
        };
    };
    const mutation = (kind) => async (request, response) => {
        if (!method(request, response, 'POST'))
            return;
        if (!sameOrigin(request))
            return sendJson(response, 403, { error: 'same-origin request required' });
        try {
            const skinId = await readSkinId(request);
            const operation = lifecycle.begin(kind, skinId);
            sendJson(response, 202, { operationId: operation.id });
        }
        catch (error) {
            sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
        }
    };
    const disposers = [
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/catalog', handler: async (request, response) => {
                if (!method(request, response, 'GET'))
                    return;
                try {
                    sendJson(response, 200, await catalogPayload(false));
                }
                catch (error) {
                    sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
                }
            } }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/logs', handler: (request, response) => {
                if (!method(request, response, 'GET'))
                    return;
                const url = new URL(request.url ?? '/', 'http://localhost');
                const operationId = url.searchParams.get('operationId') ?? undefined;
                if (operationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
                    return sendText(response, 400, 'invalid operationId');
                }
                sendText(response, 200, exportLogs({
                    marketVersion: packageVersion(),
                    profile: options.profile,
                    hostKind,
                    dshVersion: options.runtime?.version ?? 'unknown',
                }, operationId));
            } }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/compatibility', handler: async (request, response) => {
                if (!method(request, response, 'GET'))
                    return;
                try {
                    const url = new URL(request.url ?? '/', 'http://localhost');
                    const packageName = url.searchParams.get('package') ?? '';
                    const packageVersion = url.searchParams.get('version');
                    // 只接受 npm 包名形态，避免这个路由被当成任意 URL 的代理
                    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]{0,213}$/i.test(packageName)) {
                        return sendJson(response, 400, { error: 'invalid package name' });
                    }
                    if (packageVersion !== null && !/^[\w.+-]{1,64}$/.test(packageVersion)) {
                        return sendJson(response, 400, { error: 'invalid version' });
                    }
                    const result = await checkSkinPeers(packageName, packageVersion, options.runtime?.version ?? null);
                    sendJson(response, 200, result);
                }
                catch (error) {
                    sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
                }
            } }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/state', handler: (request, response) => {
                if (!method(request, response, 'GET'))
                    return;
                try {
                    sendJson(response, 200, {
                        hostKind,
                        runtime: options.runtime,
                        skins: lifecycle.states(),
                        installedClientPlugins: installedClientPlugins(profileDir, lifecycle.catalog),
                        operation: lifecycle.currentOperation(),
                        operations: lifecycle.currentOperations(),
                        marketUpdateOperation: marketUpdater.currentOperation(),
                        instanceId,
                        restartAvailable: options.restart?.available === true,
                        marketUpdateRestartRequired: marketUpdater.restartRequired,
                        runningAgentCount: runningAgentCount(routeHost),
                    });
                }
                catch (error) {
                    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
                }
            } }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/market-update', handler: async (request, response) => {
                if (request.method !== 'GET' && request.method !== 'POST') {
                    response.writeHead(405, { allow: 'GET, POST' });
                    response.end();
                    return;
                }
                if (request.method === 'POST' && !sameOrigin(request))
                    return sendJson(response, 403, { error: 'same-origin request required' });
                try {
                    if (request.method === 'POST') {
                        const operation = marketUpdater.startUpdate();
                        return sendJson(response, 202, { operationId: operation.id });
                    }
                    sendJson(response, 200, { ...(await marketUpdater.status()), operation: marketUpdater.currentOperation() });
                }
                catch (error) {
                    sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
                }
            } }),
        host.webServer.register({ kind: 'prefix', path: '/dsh-skin-market/market-update/operations', handler: (request, response) => {
                const parts = new URL(request.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean);
                const cancelling = parts.at(-1) === 'cancel';
                const retrying = parts.at(-1) === 'retry';
                const id = cancelling || retrying ? parts.at(-2) ?? '' : parts.at(-1) ?? '';
                if (cancelling || retrying) {
                    if (!method(request, response, 'POST'))
                        return;
                    if (!sameOrigin(request))
                        return sendJson(response, 403, { error: 'same-origin request required' });
                    try {
                        return sendJson(response, 202, cancelling ? marketUpdater.cancel(id) : { operationId: marketUpdater.retry(id).id });
                    }
                    catch (error) {
                        return sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
                    }
                }
                if (!method(request, response, 'GET'))
                    return;
                const operation = marketUpdater.operation(id);
                if (operation === null)
                    return sendJson(response, 404, { error: '更新任务不存在' });
                sendJson(response, 200, operation);
            } }),
        // Prefix routes must not end in `/`: DSH matches descendants by appending
        // its own slash (`pathname.startsWith(`${prefix}/`)`). A trailing slash
        // here would therefore only match a double-slash URL and let normal
        // operation polling fall through to index.html.
        host.webServer.register({ kind: 'prefix', path: '/dsh-skin-market/operations', handler: async (request, response) => {
                const parts = new URL(request.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean);
                const cancelling = parts.at(-1) === 'cancel';
                const retrying = parts.at(-1) === 'retry';
                const id = cancelling || retrying ? parts.at(-2) ?? '' : parts.at(-1) ?? '';
                if (cancelling || retrying) {
                    if (!method(request, response, 'POST'))
                        return;
                    if (!sameOrigin(request))
                        return sendJson(response, 403, { error: 'same-origin request required' });
                    try {
                        if (cancelling)
                            return sendJson(response, 202, lifecycle.cancel(id));
                        const action = await readOperationRetryAction(request);
                        return sendJson(response, 202, { operationId: lifecycle.retry(id, action).id });
                    }
                    catch (error) {
                        return sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
                    }
                }
                if (!method(request, response, 'GET'))
                    return;
                const operation = lifecycle.operations.get(id);
                if (operation === undefined)
                    return sendJson(response, 404, { error: 'operation not found' });
                sendJson(response, 200, operation);
            } }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/install', handler: mutation('install') }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/activate', handler: mutation('activate') }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/deactivate', handler: mutation('deactivate') }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/pin', handler: mutation('pin') }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/unpin', handler: mutation('unpin') }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/update', handler: mutation('update') }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/migrate', handler: mutation('migrate') }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/uninstall', handler: mutation('uninstall') }),
        host.webServer.register({ kind: 'exact', path: '/dsh-skin-market/restart', handler: async (request, response) => {
                if (!method(request, response, 'POST'))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'same-origin request required' });
                if (options.restart?.available !== true)
                    return sendJson(response, 501, { error: 'restart is unavailable in this DSH host' });
                try {
                    const target = await readRestartTarget(request);
                    if (target.kind === 'market-update') {
                        if (!marketUpdater.restartRequired)
                            return sendJson(response, 409, { error: '皮肤市场没有待应用的更新' });
                    }
                    else {
                        const skinState = lifecycle.states().find(item => item.skinId === target.skinId);
                        // Browser and Host loaders are separate. The browser can correctly
                        // require a restart while the Host half is already live, so accept
                        // either active representation for the selected installed skin.
                        if (!canRestartSkin(skinState))
                            return sendJson(response, 409, { error: '请先选择并使用此皮肤，再重新启动 DeepSeek Harness' });
                    }
                    assertRestartClearOfSkinOperations(lifecycle.currentOperations(), marketUpdater.currentOperation());
                    await waitForRestartSafety(routeHost);
                    sendJson(response, 202, { restarting: true, instanceId });
                    options.restart.schedule();
                }
                catch (error) {
                    sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
                }
            } }),
    ];
    return () => {
        // Newer lifecycle implementations may make disposal asynchronous so an
        // in-flight official Desktop manager request can be cancelled and joined
        // before its routes disappear. Keep the synchronous path synchronous for
        // existing hosts and tests.
        const finish = () => {
            for (const dispose of disposers.reverse())
                dispose();
        };
        const disposed = Promise.all([
            Promise.resolve(lifecycle.dispose()),
            marketUpdater.dispose?.() ?? Promise.resolve(),
        ]);
        return disposed.then(finish);
    };
}
