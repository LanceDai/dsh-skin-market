import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { assertRestartClearOfSkinOperations, canRestartSkin, mountRoutes, runningAgentCount, waitForRestartSafety, type AgentLike, type WebServerService } from '../src/routes.ts'
import type { Operation } from '../src/types.ts'
import type { LoaderEntry } from '../src/types.ts'

describe('market routes', () => {
  it('blocks restart while an Agent is running and waits for idle maintenance', async () => {
    const idle = { status: 'idle', whenIdle: async () => undefined } satisfies AgentLike
    const running = { status: 'running', whenIdle: async () => undefined } satisfies AgentLike
    const host = { agents: { list: () => [idle, running] } }

    expect(runningAgentCount(host)).toBe(1)
    await expect(waitForRestartSafety(host)).rejects.toThrow('检测到 1 个 Agent 正在运行')

    let maintenanceFinished = false
    const maintaining = { status: 'idle', whenIdle: async () => { maintenanceFinished = true } } satisfies AgentLike
    await expect(waitForRestartSafety({ agents: { list: () => [maintaining] } })).resolves.toBeUndefined()
    expect(maintenanceFinished).toBe(true)
  })

  it('refuses restart while a skin install or market update is still running', () => {
    const downloading = {
      id: 'op', kind: 'install', skinId: 'skin', phase: 'downloading', startedAt: '2026-01-01T00:00:00Z',
    } satisfies Operation
    expect(() => assertRestartClearOfSkinOperations([downloading])).toThrow('正在安装或更新')
    expect(() => assertRestartClearOfSkinOperations([], { phase: 'installing' })).toThrow('皮肤市场正在更新')
    expect(() => assertRestartClearOfSkinOperations([{ ...downloading, kind: 'activate', phase: 'activating' }])).not.toThrow()
    expect(() => assertRestartClearOfSkinOperations([{ ...downloading, phase: 'done' }])).not.toThrow()
  })

  it('allows restart when the selected skin is Host-active or restart-required', () => {
    const base = { skinId: 'skin', installation: 'installed', installedVersion: '1.0.0', updateAvailable: false } as const
    expect(canRestartSkin({ ...base, activation: 'active' })).toBe(true)
    expect(canRestartSkin({ ...base, activation: 'restart-required' })).toBe(true)
    expect(canRestartSkin({ ...base, activation: 'inactive' })).toBe(false)
    expect(canRestartSkin({ ...base, installation: 'missing', activation: 'restart-required' })).toBe(false)
  })

  it('registers the operation poller as a valid DSH prefix route', () => {
    const routes: Array<{ kind: 'exact' | 'prefix'; path: string }> = []
    const webServer: WebServerService = {
      register(route) {
        routes.push({ kind: route.kind, path: route.path })
        return () => undefined
      },
    }
    const dispose = mountRoutes({
      webServer,
      agents: { list: () => [] },
      loader: { entries: (): Iterable<LoaderEntry> => [] },
    }, {
      profile: 'test',
      profileDir: '/tmp/dsh-skin-market-route-test-missing-profile',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    })

    expect(routes).toContainEqual({ kind: 'prefix', path: '/dsh-skin-market/operations' })
    expect(routes).not.toContainEqual({ kind: 'prefix', path: '/dsh-skin-market/operations/' })
    expect(routes).not.toContainEqual({ kind: 'exact', path: '/dsh-skin-market/catalog/refresh' })
    expect(routes).toContainEqual({ kind: 'exact', path: '/dsh-skin-market/market-update' })
    expect(routes).toContainEqual({ kind: 'prefix', path: '/dsh-skin-market/market-update/operations' })
    expect(routes).toContainEqual({ kind: 'exact', path: '/dsh-skin-market/logs' })
    expect(routes).toContainEqual({ kind: 'exact', path: '/dsh-skin-market/pin' })
    expect(routes).toContainEqual({ kind: 'exact', path: '/dsh-skin-market/unpin' })
    expect(routes).toContainEqual({ kind: 'exact', path: '/dsh-skin-market/migrate' })
    dispose()
  })

  it('exposes a pending market update restart in Host state', async () => {
    const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
    const webServer: WebServerService = {
      register(route) {
        handlers.set(route.path, route.handler)
        return () => undefined
      },
    }
    const marketUpdater = {
      restartRequired: true,
      status: async () => ({ currentVersion: '0.1.29', latestVersion: '0.1.29', updateAvailable: false }),
      update: async () => ({ currentVersion: '0.1.29', latestVersion: '0.1.29', updateAvailable: false }),
      startUpdate: () => { throw new Error('not used') },
      operation: () => null,
      currentOperation: () => null,
      cancel: () => { throw new Error('not used') },
    }
    const dispose = mountRoutes({
      webServer,
      agents: { list: () => [] },
      loader: { entries: (): Iterable<LoaderEntry> => [] },
    }, {
      profile: 'test',
      profileDir: '/tmp/dsh-skin-market-route-test-missing-profile',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      marketUpdater,
    })

    const response = {
      writeHead: (_status: number, _headers: Record<string, string>) => undefined,
      end: (body: string) => {
        expect(JSON.parse(body)).toMatchObject({ marketUpdateRestartRequired: true })
      },
    } as unknown as ServerResponse
    await handlers.get('/dsh-skin-market/state')?.({ method: 'GET', headers: {} } as IncomingMessage, response)
    dispose()
  })

  it('waits for the market updater before unregistering routes', async () => {
    const disposers: Array<() => void> = []
    const webServer: WebServerService = {
      register() {
        const dispose = () => { disposers.push(dispose) }
        return dispose
      },
    }
    let resolveUpdater!: () => void
    let updaterDisposed = false
    const updater = {
      restartRequired: false,
      status: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      update: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      startUpdate: () => { throw new Error('not used') },
      operation: () => null,
      currentOperation: () => null,
      cancel: () => { throw new Error('not used') },
      retry: () => { throw new Error('not used') },
      dispose: async () => {
        await new Promise<void>(resolve => { resolveUpdater = resolve })
        updaterDisposed = true
      },
    }
    const disposeRoutes = mountRoutes({
      webServer,
      agents: { list: () => [] },
      loader: { entries: (): Iterable<LoaderEntry> => [] },
    }, {
      profile: 'test',
      profileDir: '/tmp/dsh-skin-market-route-updater-dispose',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      marketUpdater: updater,
    })

    const disposing = disposeRoutes()
    expect(updaterDisposed).toBe(false)
    expect(disposers).toHaveLength(0)
    resolveUpdater()
    await disposing
    expect(updaterDisposed).toBe(true)
    expect(disposers.length).toBeGreaterThan(0)
  })

  it('returns a JSON diagnostic when Host state assembly throws', async () => {
    const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
    const webServer: WebServerService = {
      register(route) {
        handlers.set(route.path, route.handler)
        return () => undefined
      },
    }
    const marketUpdater = {
      restartRequired: false,
      status: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      update: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      startUpdate: () => { throw new Error('not used') },
      operation: () => null,
      currentOperation: () => { throw new Error('state probe failed') },
      cancel: () => { throw new Error('not used') },
      retry: () => { throw new Error('not used') },
    }
    const dispose = mountRoutes({
      webServer,
      agents: { list: () => [] },
      loader: { entries: (): Iterable<LoaderEntry> => [] },
    }, {
      profile: 'test',
      profileDir: '/tmp/dsh-skin-market-route-state-error',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      marketUpdater,
    })

    let status = 0
    let body = ''
    const response = {
      writeHead: (value: number) => { status = value },
      end: (value: string) => { body = value },
    } as unknown as ServerResponse
    await handlers.get('/dsh-skin-market/state')?.({ method: 'GET', headers: {} } as IncomingMessage, response)
    expect(status).toBe(500)
    expect(JSON.parse(body)).toEqual({ error: 'state probe failed' })
    await dispose()
  })

  it('shadows an unavailable lazy Agent service for official Desktop state', async () => {
    const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
    const webServer: WebServerService = {
      register(route) {
        handlers.set(route.path, route.handler)
        return () => undefined
      },
    }
    const host = Object.create({
      get agents(): never { throw new Error('cannot get property "agents" without inject') },
    }) as { webServer: WebServerService; loader: { entries(): Iterable<LoaderEntry> } }
    host.webServer = webServer
    host.loader = { entries: (): Iterable<LoaderEntry> => [] }
    const marketUpdater = {
      restartRequired: false,
      status: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      update: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      startUpdate: () => { throw new Error('not used') },
      operation: () => null,
      currentOperation: () => null,
      cancel: () => { throw new Error('not used') },
      retry: () => { throw new Error('not used') },
    }
    const dispose = mountRoutes(host, {
      profile: 'desktop',
      profileDir: '/tmp/dsh-skin-market-route-desktop-agents',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      hostKind: 'desktop',
      agents: undefined,
      marketUpdater,
    })

    let status = 0
    let body = ''
    const response = {
      writeHead: (value: number) => { status = value },
      end: (value: string) => { body = value },
    } as unknown as ServerResponse
    await handlers.get('/dsh-skin-market/state')?.({ method: 'GET', headers: {} } as IncomingMessage, response)
    expect(status).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ hostKind: 'desktop', runningAgentCount: 0 })
    await dispose()
  })

  it('exports a bounded diagnostic log as plain text', async () => {
    const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
    const webServer: WebServerService = {
      register(route) {
        handlers.set(route.path, route.handler)
        return () => undefined
      },
    }
    const dispose = mountRoutes({
      webServer,
      agents: { list: () => [] },
      loader: { entries: (): Iterable<LoaderEntry> => [] },
    }, {
      profile: 'test',
      profileDir: '/tmp/dsh-skin-market-route-test-missing-profile',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    })

    let contentType = ''
    let body = ''
    const response = {
      writeHead: (_status: number, headers: Record<string, string>) => { contentType = headers['content-type'] ?? '' },
      end: (value: string) => { body = value },
    } as unknown as ServerResponse
    await handlers.get('/dsh-skin-market/logs')?.({ method: 'GET', url: '/dsh-skin-market/logs?operationId=test-operation', headers: {} } as IncomingMessage, response)
    expect(contentType).toContain('text/plain')
    expect(body).toContain('# dsh-skin-market diagnostic log')
    expect(body).toContain('operationId: test-operation')
    dispose()
  })
})
