import type { Context } from '@deepseek-ai/cordis'
import { desktopRunner, runPluginCli, type DesktopPnpmLike } from './commands.ts'
import { officialDesktopRunner, type OfficialPluginManagerLike } from './official-desktop.ts'
import { resolveProfileDir } from './profile.ts'
import { mountRoutes, type SkinMarketHost } from './routes.ts'
import { createCliRestartScheduler } from './restart.ts'
import { detectDshRuntime } from './runtime.ts'

export const name = 'dsh-skin-market'
export interface Config { profile?: string }

interface DesktopProfilesLike { current: { name: string; dir: string } }
interface ProfileContextLike { name?: unknown; dir?: unknown }
interface EffectHost extends SkinMarketHost {
  effect(callback: () => (() => void | Promise<void>), label: string): void
}

interface LocalServiceReader {
  get?(name: string): unknown
}

function argvProfile(): string | undefined {
  const index = process.argv.indexOf('--profile')
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : undefined
}

export function apply(ctx: Context, config?: Config): void {
  // Agent coordination is optional.  The official Electron Desktop does not
  // expose the Web Agent registry in every generation, while the market only
  // needs it when a Web/Host restart is explicitly requested.
  ctx.inject(['webServer', 'loader'], hostContext => {
    const host = hostContext as unknown as EffectHost
    const localServices = hostContext as unknown as LocalServiceReader
    const readService = (name: string): unknown => {
      const rootValue = ctx.get(name)
      if (rootValue !== undefined) return rootValue
      return localServices.get?.(name)
    }
    const desktopProfiles = readService('desktopProfiles') as DesktopProfilesLike | undefined
    const profileContext = readService('profileContext') as ProfileContextLike | undefined
    const contextName = typeof profileContext?.name === 'string' ? profileContext.name.trim() : ''
    const contextDir = typeof profileContext?.dir === 'string' ? profileContext.dir.trim() : ''
    const configuredProfile = typeof config?.profile === 'string' ? config.profile.trim() : undefined
    const launchedProfile = contextName !== '' ? contextName : argvProfile()
    const agents = readService('agents') as SkinMarketHost['agents']
    const pluginManager = readService('pluginManager') as OfficialPluginManagerLike | undefined
    const officialDesktop = configuredProfile?.toLowerCase() === 'desktop'
      || (configuredProfile === undefined && launchedProfile?.toLowerCase() === 'desktop')
      || (desktopProfiles === undefined && pluginManager !== undefined)
    // Official Electron Desktop owns its profile through profileContext and
    // pluginManager; its CLI rejects `--profile desktop`. Resolve this branch
    // before the ordinary CLI fallback so actions mutate the visible profile.
    if (officialDesktop) {
      const profile = 'desktop'
      // An official Desktop generation may not expose profileContext.dir until
      // after startup. Never fall back to the Web profile in that case: the
      // canonical Desktop directory is the explicit profile name's directory.
      const profileDir = contextDir !== '' ? contextDir : resolveProfileDir(profile)
      const runner = officialDesktopRunner(() => (readService('pluginManager') as OfficialPluginManagerLike | undefined))
      host.effect(
        () => mountRoutes(host, { profile, profileDir, runner, hostKind: 'desktop', runtime: detectDshRuntime(), agents: undefined }),
        'dsh-skin-market: official Desktop routes',
      )
      return
    }
    if (desktopProfiles === undefined) {
      const profile = configuredProfile ?? launchedProfile ?? 'web'
      const profileDir = configuredProfile === undefined && contextDir !== '' ? contextDir : resolveProfileDir(profile)
      const appExit = readService('appExit') as ((code: number) => void) | undefined
      const restart = appExit === undefined ? undefined : createCliRestartScheduler(appExit)
      host.effect(() => mountRoutes(host, { profile, profileDir, runner: runPluginCli, hostKind: 'dsh', runtime: detectDshRuntime(), restart, agents }), 'dsh-skin-market: routes')
      return
    }
    hostContext.inject(['desktopPnpm'], desktopContext => {
      const current = desktopProfiles.current
      const service = (desktopContext as unknown as { desktopPnpm: DesktopPnpmLike }).desktopPnpm
      const desktopHost = desktopContext as unknown as EffectHost
      desktopHost.effect(
        () => mountRoutes(host, { profile: current.name, profileDir: current.dir, runner: desktopRunner(service, current.dir), hostKind: 'desktop', runtime: detectDshRuntime(), agents }),
        'dsh-skin-market: desktop routes',
      )
    })
  })
}

export { mountRoutes } from './routes.ts'
export { SkinLifecycle } from './lifecycle.ts'
