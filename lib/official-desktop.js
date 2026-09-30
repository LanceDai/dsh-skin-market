import { randomUUID } from 'node:crypto';
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
function resultText(value) {
    const record = asRecord(value);
    const error = record?.error;
    if (typeof error === 'string' && error.trim() !== '')
        return error;
    const errorRecord = asRecord(error);
    if (typeof errorRecord?.message === 'string' && errorRecord.message.trim() !== '')
        return errorRecord.message;
    const packageResult = asRecord(record?.packageResult);
    if (typeof packageResult?.output === 'string' && packageResult.output.trim() !== '')
        return packageResult.output;
    if (typeof packageResult?.message === 'string' && packageResult.message.trim() !== '')
        return packageResult.message;
    try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
    }
    catch {
        return String(value);
    }
}
function resultFailed(value) {
    const record = asRecord(value);
    if (record === undefined)
        return false;
    // The official manager reports the host-side outcome separately from the
    // package-manager result.  Once that field is present it is authoritative:
    // a successful package install can still be rejected while applying the
    // profile, and a non-zero package exit can be wrapped by a successful host
    // application result.
    const application = record.application;
    if (application !== undefined) {
        return application !== 'applied' && application !== 'restart-required' && application !== 'overridden';
    }
    return record.ok === false
        || record.success === false
        || record.application === 'failed'
        || record.changed === 'failed'
        || asRecord(record.packageResult)?.exitCode !== undefined && asRecord(record.packageResult)?.exitCode !== 0;
}
function managerResult(value) {
    const output = resultText(value);
    if (resultFailed(value))
        return { exitCode: 1, stdout: '', stderr: output, timedOut: false, aborted: false };
    return { exitCode: 0, stdout: output, stderr: '', timedOut: false, aborted: false };
}
function managerError(error, options, timedOut = false) {
    return {
        exitCode: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut,
        aborted: options?.signal?.aborted === true,
    };
}
async function callManager(operation, options, cancel) {
    const stopped = options?.signal?.aborted === true || options?.timeoutMs !== undefined && options.timeoutMs <= 0;
    if (stopped)
        return {
            exitCode: null,
            stdout: '',
            stderr: '',
            timedOut: options?.signal?.aborted !== true && options?.timeoutMs !== undefined && options.timeoutMs <= 0,
            aborted: options?.signal?.aborted === true,
        };
    let timedOut = false;
    let cancellation;
    let cancelRequested = false;
    const requestCancel = () => {
        if (cancelRequested || cancel === undefined)
            return;
        cancelRequested = true;
        try {
            cancellation = Promise.resolve(cancel());
        }
        catch { /* the operation result remains authoritative */ }
    };
    const onAbort = () => requestCancel();
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = options?.timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        requestCancel();
    }, Math.max(0, options.timeoutMs));
    try {
        const value = await operation();
        if (cancellation !== undefined)
            await cancellation.catch(() => undefined);
        const result = managerResult(value);
        return { ...result, timedOut, aborted: options?.signal?.aborted === true };
    }
    catch (error) {
        if (cancellation !== undefined)
            await cancellation.catch(() => undefined);
        return managerError(error, options, timedOut);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
    }
}
function targetAfterVerb(args) {
    return args.slice(1).find(argument => !argument.startsWith('-'));
}
/**
 * Adapt the official Desktop plugin manager to the market's existing runner.
 * The manager is looked up for every operation because its Remote is owned by
 * the current Cordis generation and may not survive a profile switch.
 */
export function officialDesktopRunner(getManager) {
    const runner = async (_profile, args, options) => {
        const manager = getManager();
        if (manager === undefined)
            return managerError(new Error('官方 Desktop 未提供 pluginManager'), options);
        const verb = args[0];
        if (verb === 'remove') {
            const target = targetAfterVerb(args);
            if (target === undefined)
                return managerError(new Error('官方 Desktop remove 缺少插件名'), options);
            return await callManager(() => manager.removeBundle(target), options);
        }
        if (verb === 'add') {
            const target = targetAfterVerb(args);
            if (target === undefined)
                return managerError(new Error('官方 Desktop add 缺少插件目标'), options);
            if (manager.cancelInstall === undefined)
                return managerError(new Error('官方 Desktop pluginManager 不支持可取消的安装操作'), options);
            const requestId = randomUUID();
            return await callManager(() => manager.installBundle(target, { enabled: false, requestId }), options, () => manager.cancelInstall(requestId));
        }
        return managerError(new Error(`官方 Desktop pluginManager 不支持 ${verb ?? '空命令'}`), options);
    };
    runner.hostKind = 'desktop';
    runner.ensurePnpm = async () => undefined;
    runner.installPlugin = async (_profile, request, options) => {
        const manager = getManager();
        if (manager === undefined)
            return managerError(new Error('官方 Desktop 未提供 pluginManager'), options);
        if (manager.cancelInstall === undefined)
            return managerError(new Error('官方 Desktop pluginManager 不支持可取消的安装操作'), options);
        const target = `${request.packageName}@${request.packageVersion}`;
        return await callManager(() => manager.installBundle(target, { enabled: false, requestId: request.receiptId }), options, () => manager.cancelInstall(request.receiptId));
    };
    return runner;
}
