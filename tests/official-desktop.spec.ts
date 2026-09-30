import { describe, expect, it, vi } from 'vitest'
import { officialDesktopRunner, type OfficialPluginManagerLike } from '../src/official-desktop.ts'
import { createMarketUpdater, MARKET_NPM_PACKAGE } from '../src/self-update.ts'

describe('official Desktop runner', () => {
  it('installs through the profile plugin manager without enabling the bundle first', async () => {
    const installBundle = vi.fn(async () => ({ changed: 'applied' }))
    const manager: OfficialPluginManagerLike = {
      installBundle,
      removeBundle: vi.fn(async () => ({ changed: 'applied' })),
      cancelInstall: vi.fn(async () => ({ cancelled: true })),
    }
    const runner = officialDesktopRunner(() => manager)

    const result = await runner.installPlugin!(
      'desktop',
      { packageName: 'dsh-theme-endfield', packageVersion: '1.0.1', receiptId: 'receipt-1' },
    )

    expect(result.exitCode).toBe(0)
    expect(installBundle).toHaveBeenCalledWith('dsh-theme-endfield@1.0.1', { enabled: false, requestId: 'receipt-1' })
  })

  it('routes remove through the same manager and surfaces manager failures', async () => {
    const removeBundle = vi.fn(async () => ({ changed: 'failed', error: { message: 'profile is locked' } }))
    const manager: OfficialPluginManagerLike = { installBundle: vi.fn(), removeBundle }
    const runner = officialDesktopRunner(() => manager)

    const result = await runner('desktop', ['remove', 'dsh-theme-endfield'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('profile is locked')
    expect(removeBundle).toHaveBeenCalledWith('dsh-theme-endfield')
  })

  it('cancels a manager-owned install when the market operation is aborted', async () => {
    let resolveInstall!: (value: unknown) => void
    const cancelInstall = vi.fn(async () => ({ cancelled: true }))
    const installBundle = vi.fn(() => new Promise<unknown>(resolve => { resolveInstall = resolve }))
    const manager: OfficialPluginManagerLike = { installBundle, removeBundle: vi.fn(), cancelInstall }
    const runner = officialDesktopRunner(() => manager)
    const controller = new AbortController()
    const operation = runner.installPlugin!(
      'desktop',
      { packageName: 'dsh-theme-endfield', packageVersion: '1.0.1', receiptId: 'receipt-2' },
      { signal: controller.signal },
    )

    controller.abort()
    expect(cancelInstall).toHaveBeenCalledWith('receipt-2')
    resolveInstall({ cancelled: true })
    await expect(operation).resolves.toMatchObject({ exitCode: 0, aborted: true })
  })

  it('fails closed when the official manager is unavailable', async () => {
    const runner = officialDesktopRunner(() => undefined)
    const result = await runner('desktop', ['remove', 'dsh-theme-endfield'])
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toContain('pluginManager')
  })

  it('fails closed when an install cannot be cancelled by the host', async () => {
    const installBundle = vi.fn(async () => ({ application: 'applied' }))
    const runner = officialDesktopRunner(() => ({ installBundle, removeBundle: vi.fn() }))

    const result = await runner.installPlugin!(
      'desktop',
      { packageName: 'dsh-theme-endfield', packageVersion: '1.0.1', receiptId: 'receipt-no-cancel' },
    )

    expect(result.exitCode).toBeNull()
    expect(result.stderr).toContain('可取消')
    expect(installBundle).not.toHaveBeenCalled()
  })

  it('routes the market self-update through the official manager and leaves it disabled until restart', async () => {
    const installBundle = vi.fn(async () => ({ application: 'restart-required' }))
    const manager: OfficialPluginManagerLike = {
      installBundle,
      removeBundle: vi.fn(),
      cancelInstall: vi.fn(async () => undefined),
    }
    const updater = createMarketUpdater('desktop', officialDesktopRunner(() => manager), {
      currentVersion: '0.1.57',
      profileDir: '/tmp/dsh-skin-market-official-self-update',
      cacheMs: 0,
      fetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '0.1.58' },
          versions: {
            '0.1.58': {
              version: '0.1.58',
              gitHead: 'c'.repeat(40),
              dist: { tarball: `https://registry.npmjs.org/${MARKET_NPM_PACKAGE}/-/${MARKET_NPM_PACKAGE}-0.1.58.tgz` },
            },
          },
        }),
      })) as unknown as typeof fetch,
    })

    await expect(updater.update()).resolves.toEqual({ currentVersion: '0.1.58', latestVersion: '0.1.58', updateAvailable: false })
    expect(updater.restartRequired).toBe(true)
    expect(installBundle).toHaveBeenCalledWith('dsh-skin-market@0.1.58', { enabled: false, requestId: expect.any(String) })
  })

  it.each(['applied', 'restart-required', 'overridden'] as const)('accepts application=%s even with a package warning', async application => {
    const manager: OfficialPluginManagerLike = {
      installBundle: vi.fn(async () => ({ application, packageResult: { exitCode: 1, output: 'package warning' } })),
      removeBundle: vi.fn(),
      cancelInstall: vi.fn(async () => undefined),
    }
    const result = await officialDesktopRunner(() => manager).installPlugin!(
      'desktop',
      { packageName: 'dsh-theme-endfield', packageVersion: '1.0.1', receiptId: `receipt-${application}` },
    )
    expect(result.exitCode).toBe(0)
  })

  it.each(['failed', 'cancelled', 'rejected', 'unknown'] as const)('rejects application=%s', async application => {
    const manager: OfficialPluginManagerLike = {
      installBundle: vi.fn(async () => ({ application, error: { message: `${application} reason` } })),
      removeBundle: vi.fn(),
      cancelInstall: vi.fn(async () => undefined),
    }
    const result = await officialDesktopRunner(() => manager).installPlugin!(
      'desktop',
      { packageName: 'dsh-theme-endfield', packageVersion: '1.0.1', receiptId: `receipt-${application}` },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`${application} reason`)
  })

  it('surfaces package output after an error message', async () => {
    const manager: OfficialPluginManagerLike = {
      installBundle: vi.fn(async () => ({ packageResult: { output: 'pnpm output' } })),
      removeBundle: vi.fn(),
      cancelInstall: vi.fn(async () => undefined),
    }
    const result = await officialDesktopRunner(() => manager).installPlugin!(
      'desktop',
      { packageName: 'dsh-theme-endfield', packageVersion: '1.0.1', receiptId: 'receipt-output' },
    )
    expect(result.stdout).toContain('pnpm output')
  })

  it('cancels an in-flight install on AbortSignal and waits for the manager promise', async () => {
    let resolveInstall!: (value: unknown) => void
    const installBundle = vi.fn(() => new Promise(resolve => { resolveInstall = resolve }))
    const cancelInstall = vi.fn(async () => { resolveInstall({ application: 'cancelled' }) })
    const runner = officialDesktopRunner(() => ({ installBundle, removeBundle: vi.fn(), cancelInstall }))
    const controller = new AbortController()
    const resultPromise = runner.installPlugin!(
      'desktop',
      { packageName: 'dsh-theme-endfield', packageVersion: '1.0.1', receiptId: 'receipt-abort' },
      { signal: controller.signal },
    )

    controller.abort()
    const result = await resultPromise

    expect(cancelInstall).toHaveBeenCalledWith('receipt-abort')
    expect(result.exitCode).toBe(1)
    expect(result.aborted).toBe(true)
  })

  it('cancels an in-flight install on timeout and joins the manager promise', async () => {
    let resolveInstall!: (value: unknown) => void
    const installBundle = vi.fn(() => new Promise(resolve => { resolveInstall = resolve }))
    const cancelInstall = vi.fn(async () => { resolveInstall({ application: 'cancelled' }) })
    const runner = officialDesktopRunner(() => ({ installBundle, removeBundle: vi.fn(), cancelInstall }))

    const result = await runner.installPlugin!(
      'desktop',
      { packageName: 'dsh-theme-endfield', packageVersion: '1.0.1', receiptId: 'receipt-timeout' },
      { timeoutMs: 1 },
    )

    expect(cancelInstall).toHaveBeenCalledWith('receipt-timeout')
    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBe(true)
  })
})
