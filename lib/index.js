import { desktopRunner, runPluginCli } from './commands.js';
import { officialDesktopRunner } from './official-desktop.js';
import { resolveProfileDir } from './profile.js';
import { mountRoutes } from './routes.js';
import { createCliRestartScheduler } from './restart.js';
import { detectDshRuntime } from './runtime.js';
export const name = 'dsh-skin-market';
function argvProfile() {
    const index = process.argv.indexOf('--profile');
    return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : undefined;
}
export function apply(ctx, config) {
    // Agent coordination is optional.  The official Electron Desktop does not
    // expose the Web Agent registry in every generation, while the market only
    // needs it when a Web/Host restart is explicitly requested.
    ctx.inject(['webServer', 'loader'], hostContext => {
        const host = hostContext;
        const localServices = hostContext;
        const readService = (name) => {
            const rootValue = ctx.get(name);
            if (rootValue !== undefined)
                return rootValue;
            return localServices.get?.(name);
        };
        const desktopProfiles = readService('desktopProfiles');
        const profileContext = readService('profileContext');
        const contextName = typeof profileContext?.name === 'string' ? profileContext.name.trim() : '';
        const contextDir = typeof profileContext?.dir === 'string' ? profileContext.dir.trim() : '';
        const configuredProfile = typeof config?.profile === 'string' ? config.profile.trim() : undefined;
        const launchedProfile = contextName !== '' ? contextName : argvProfile();
        const agents = readService('agents');
        const pluginManager = readService('pluginManager');
        const officialDesktop = configuredProfile?.toLowerCase() === 'desktop'
            || (configuredProfile === undefined && launchedProfile?.toLowerCase() === 'desktop')
            || (desktopProfiles === undefined && pluginManager !== undefined);
        // Official Electron Desktop owns its profile through profileContext and
        // pluginManager; its CLI rejects `--profile desktop`. Resolve this branch
        // before the ordinary CLI fallback so actions mutate the visible profile.
        if (officialDesktop) {
            const profile = 'desktop';
            // An official Desktop generation may not expose profileContext.dir until
            // after startup. Never fall back to the Web profile in that case: the
            // canonical Desktop directory is the explicit profile name's directory.
            const profileDir = contextDir !== '' ? contextDir : resolveProfileDir(profile);
            const runner = officialDesktopRunner(() => readService('pluginManager'));
            host.effect(() => mountRoutes(host, { profile, profileDir, runner, hostKind: 'desktop', runtime: detectDshRuntime(), agents: undefined }), 'dsh-skin-market: official Desktop routes');
            return;
        }
        if (desktopProfiles === undefined) {
            const profile = configuredProfile ?? launchedProfile ?? 'web';
            const profileDir = configuredProfile === undefined && contextDir !== '' ? contextDir : resolveProfileDir(profile);
            const appExit = readService('appExit');
            const restart = appExit === undefined ? undefined : createCliRestartScheduler(appExit);
            host.effect(() => mountRoutes(host, { profile, profileDir, runner: runPluginCli, hostKind: 'dsh', runtime: detectDshRuntime(), restart, agents }), 'dsh-skin-market: routes');
            return;
        }
        hostContext.inject(['desktopPnpm'], desktopContext => {
            const current = desktopProfiles.current;
            const service = desktopContext.desktopPnpm;
            const desktopHost = desktopContext;
            desktopHost.effect(() => mountRoutes(host, { profile: current.name, profileDir: current.dir, runner: desktopRunner(service, current.dir), hostKind: 'desktop', runtime: detectDshRuntime(), agents }), 'dsh-skin-market: desktop routes');
        });
    });
}
export { mountRoutes } from './routes.js';
export { SkinLifecycle } from './lifecycle.js';
