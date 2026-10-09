import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 本 fork 的自定义功能「静态守卫」。
 *
 * 目的：这些能力是相对官方版新增的（筛选可一键安装、卡片状态徽标、peer 预检、自我更新保护），
 * 官方合入时如果发生冲突或有人回退，测试应当立刻失败 —— 与仓库既有的
 * static-guards 测试同一种做法（grep 源码），不需要渲染环境。
 */
const CLIENT = readFileSync(new URL('../src/client/SkinMarketSection.tsx', import.meta.url), 'utf8')
const CLIENT_CSS = readFileSync(new URL('../src/client/SkinMarket.module.css', import.meta.url), 'utf8')
const ROUTES = readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8')
const SELF_UPDATE = readFileSync(new URL('../src/self-update.ts', import.meta.url), 'utf8')
const PEER_CHECK = readFileSync(new URL('../src/peer-check.ts', import.meta.url), 'utf8')

describe('fork guards: 可一键安装筛选', () => {
  it('filter 状态包含 auto 取值', () => {
    expect(CLIENT).toMatch(/useState<'all' \| 'installed' \| 'auto'>/)
  })

  it('filtered 与 discoverySkins 都按 auto 过滤，且判定复用 isManualOnly', () => {
    expect(CLIENT).toMatch(/if \(filter === 'auto'\) return !isManualOnly\(skin\)/)
    expect(CLIENT).toMatch(/filter !== 'auto' \|\| !isManualOnly\(skin\)/)
  })

  it('首页与目录都渲染「可一键安装」入口', () => {
    const occurrences = CLIENT.split('可一键安装').length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
    expect(CLIENT).toMatch(/setFilter\('auto'\)/)
  })

  it('首页列表（发现更多）必须处理全部筛选取值，不能只处理 auto', () => {
    // 真实缺陷（用户实测发现）：首页列表只处理了 'auto'，点「已安装」时首页仍展示未安装的皮肤。
    const start = CLIENT.indexOf('const discoverySkins = useMemo')
    expect(start).toBeGreaterThan(-1)
    const head = CLIENT.slice(start, start + 700)
    expect(head).toMatch(/filter !== 'auto' \|\| !isManualOnly\(skin\)/)
    expect(head).toMatch(/filter !== 'installed' \|\| runtimeFor\(states, skin\.id\)\.installation !== 'missing'/)
    // 依赖数组必须包含 states，否则安装状态变化后列表不会重算
    expect(head).toMatch(/\[homeQuery, skins, sortBy, filter, hostKind, states\]/)
  })

  it('选中筛选时不再重复展示「已安装」区块', () => {
    // 真实缺陷（用户实测发现）：选中「已安装」时，顶部「已安装」区块与下方列表把同一批皮肤列了两遍。
    const marker = 'aria-labelledby="installed-skins-title"'
    const at = CLIENT.indexOf(marker)
    expect(at).toBeGreaterThan(-1)
    const condition = CLIENT.slice(Math.max(0, at - 240), at)
    expect(condition).toMatch(/homeQuery\.trim\(\) === '' && filter === 'all'/)
  })

  it('列表标题随筛选变化，避免「已安装」筛选下仍写着"发现更多"', () => {
    const at = CLIENT.indexOf('id="discover-skins-title"')
    expect(at).toBeGreaterThan(-1)
    const heading = CLIENT.slice(at, at + 320)
    expect(heading).toMatch(/'搜索结果'/)
    expect(heading).toMatch(/filter === 'installed'\s*\?\s*'已安装'/)
    expect(heading).toMatch(/filter === 'auto'\s*\?\s*'可一键安装'/)
  })
})

describe('fork guards: 卡片状态徽标', () => {
  it('预览图上渲染状态徽标', () => {
    expect(CLIENT).toMatch(/homeCardStateBadge/)
    expect(CLIENT).toMatch(/data-state=\{itemState\.activation === 'active' \? 'active' : 'installed'\}/)
    expect(CLIENT).toMatch(/'使用中' : itemState\.activation === 'restart-required' \? '待重启' : '已安装'/)
  })

  it('徽标样式存在且媒体区为其提供定位上下文', () => {
    expect(CLIENT_CSS).toMatch(/\.homeCardStateBadge\s*\{/)
    // .homeCardMedia 必须 position: relative，否则徽标会跑到卡片外
    expect(CLIENT_CSS).toMatch(/\.homeCardMedia\s*\{[^}]*position:\s*relative/)
  })
})

describe('fork guards: peer 依赖预检', () => {
  it('host 侧只比较 DSH 自身运行时包，并跳过 optional', () => {
    expect(PEER_CHECK).toMatch(/@deepseek-ai\\\/dsh-/)
    expect(PEER_CHECK).toMatch(/optional === true/)
  })

  it('结论失败时降级为 unknown 而不是抛错', () => {
    expect(PEER_CHECK).toMatch(/verdict: 'unknown'/)
    expect(PEER_CHECK).toMatch(/catch \{/)
  })

  it('路由暴露 compatibility 且校验包名形态（避免沦为开放代理）', () => {
    expect(ROUTES).toMatch(/path: '\/dsh-skin-market\/compatibility'/)
    expect(ROUTES).toMatch(/invalid package name/)
    expect(ROUTES).toMatch(/invalid version/)
  })

  it('客户端仅在查看 managed 皮肤时按需请求一次', () => {
    expect(CLIENT).toMatch(/selectedManaged/)
    expect(CLIENT).toMatch(/\/dsh-skin-market\/compatibility\?/)
    // 缓存命中后不再重复请求
    expect(CLIENT).toMatch(/if \(peerVerdicts\[selected\.id\] !== undefined\) return/)
  })

  it('卡片对判定为 blocked 的皮肤显示「版本不兼容」', () => {
    expect(CLIENT).toMatch(/homeCardPeerBlocked/)
    expect(CLIENT).toMatch(/版本不兼容/)
    expect(CLIENT_CSS).toMatch(/\.homeCardPeerBlocked\s*\{/)
  })
})

describe('fork guards: 自我更新不覆盖本地 fork', () => {
  it('状态里标记 link: 安装', () => {
    expect(SELF_UPDATE).toMatch(/localLink/)
    expect(SELF_UPDATE).toMatch(/isLinkedInstall/)
    expect(SELF_UPDATE).toMatch(/\^\(link\|file\|workspace\):/)
  })

  it('检测到 link: 时拒绝更新且不调用 pnpm', () => {
    expect(SELF_UPDATE).toMatch(/if \(before\.localLink === true\) \{/)
    // 拒绝分支必须先于真正执行 pnpm 的 self-update 调用
    const guardIndex = SELF_UPDATE.indexOf('if (before.localLink === true) {')
    const installIndex = SELF_UPDATE.indexOf("await run(['add'")
    expect(guardIndex).toBeGreaterThan(-1)
    expect(installIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(installIndex)
  })
})
