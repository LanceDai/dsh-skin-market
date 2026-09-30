import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { apply } from '../src/index.ts'
import type { LoaderEntry } from '../src/types.ts'

describe('official Desktop entrypoint', () => {
  it('uses the Desktop route for explicit profile=desktop without profileContext.dir and fails closed without pluginManager', async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'dsh-skin-market-index-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = profileRoot
    let cleanup: (() => void | Promise<void>) | undefined
    try {
      const desktopDir = join(profileRoot, 'profiles', 'desktop')
      mkdirSync(desktopDir, { recursive: true })
      const handlers = new Map<string, (request: any, response: any) => void | Promise<void>>()
      const webServer = {
        register(route: { path: string; handler: (request: any, response: any) => void | Promise<void> }) {
          handlers.set(route.path, route.handler)
          return () => undefined
        },
      }
      const host = {
        webServer,
        loader: { entries: (): Iterable<LoaderEntry> => [] },
        effect(callback: () => (() => void | Promise<void>)) {
          cleanup = callback()
          return cleanup
        },
        // The official runner resolves this lazily. Keeping it absent proves
        // this branch never falls back to the CLI runner.
        get: vi.fn(() => undefined),
      }
      const context = {
        get: vi.fn(() => undefined),
        inject: vi.fn((_dependencies: readonly string[], callback: (value: unknown) => unknown) => callback(host)),
      } as unknown as Context

      apply(context, { profile: 'desktop' })

      const stateResponse = { writeHead: vi.fn(), end: vi.fn() }
      await handlers.get('/dsh-skin-market/state')?.({ method: 'GET', headers: {} }, stateResponse)
      const state = JSON.parse(stateResponse.end.mock.calls.at(-1)?.[0] as string) as { hostKind: string; runningAgentCount: number }
      expect(state.hostKind).toBe('desktop')
      expect(state.runningAgentCount).toBe(0)
      expect(existsSync(join(desktopDir, '.dsh-skin-market', 'state.json'))).toBe(true)
      expect(existsSync(join(profileRoot, 'profiles', 'web', '.dsh-skin-market', 'state.json'))).toBe(false)

      const managed = loadCatalog().skins.find(skin => skin.install.desktop?.mode === 'managed')
      expect(managed).toBeDefined()
      const operationResponse = { writeHead: vi.fn(), end: vi.fn() }
      const request = Readable.from([JSON.stringify({ skinId: managed!.id })])
      Object.assign(request, { method: 'POST', headers: { 'content-type': 'application/json' } })
      await handlers.get('/dsh-skin-market/install')?.(request, operationResponse)
      expect(operationResponse.end).toHaveBeenCalled()

      // The operation is asynchronous; wait until the manager lookup is
      // observed in the operation result rather than treating a 202 as success.
      const operationId = JSON.parse(operationResponse.end.mock.calls.at(-1)?.[0] as string).operationId as string
      let operation: { phase: string; message?: string } | undefined
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = { writeHead: vi.fn(), end: vi.fn() }
        await handlers.get('/dsh-skin-market/operations')?.({ method: 'GET', url: `/dsh-skin-market/operations/${operationId}`, headers: {} }, response)
        if (response.end.mock.calls.length > 0) {
          const value = JSON.parse(response.end.mock.calls.at(-1)?.[0] as string) as { phase: string; message?: string }
          operation = value
          if (value.phase === 'failed' || value.phase === 'done') break
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(operation?.phase).toBe('failed')
      expect(operation?.message).toContain('pluginManager')
      expect(host.get).toHaveBeenCalledWith('pluginManager')
    } finally {
      await cleanup?.()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(profileRoot, { recursive: true, force: true })
    }
  })
})
