/**
 * 同步官方皮肤市场更新到本地 fork（并重新构建）。
 *
 * 背景：这个插件是 dsh-skin-market 的本地 fork，以 `link:` 方式装进 DSH profile。
 * 官方仍在持续更新（新增皮肤、修复），所以需要一条**不丢本地改动**的同步路径。
 * 注意：不要用市场界面里的「自我更新」—— 那会执行 `pnpm add dsh-skin-market@<latest>`
 * 把 fork 换成 npm 官方版（本 fork 已加拦截，会直接拒绝）。
 *
 * 用法（在 fork 目录内）：
 *   node scripts/sync-upstream.mjs            # 检查并同步 + 重新构建
 *   node scripts/sync-upstream.mjs --check    # 只看官方有没有新提交，不改动
 *   node scripts/sync-upstream.mjs --no-build # 同步但不构建
 *
 * 设计取舍：
 *   - 只允许在**工作区干净**时同步（避免把本地未提交改动卷进合并冲突）；
 *   - fetch 带超时，网络不可达时如实报错而不是卡住；
 *   - 合并失败时保留现场并给出处理建议，绝不自动丢弃本地改动。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const skipBuild = args.has('--no-build')
const FETCH_TIMEOUT_MS = 120_000

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.inherit === true ? 'inherit' : 'pipe',
    timeout: options.timeoutMs ?? 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, output: String(result.error.message ?? result.error) }
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return { ok: result.status === 0, output, status: result.status ?? -1 }
}

const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

// 1) 基本检查
if (!existsSync(join(root, 'package.json'))) fail(`这里不是仓库根目录：${root}`)
const topLevel = run('git', ['rev-parse', '--show-toplevel'])
if (!topLevel.ok) fail('当前目录不是 git 仓库')
if (topLevel.output.replace(/\\/g, '/').toLowerCase() !== root.replace(/\\/g, '/').toLowerCase()) {
  fail(`脚本应放在 fork 根目录内运行（仓库根：${topLevel.output}）`)
}

const remotes = run('git', ['remote'])
if (!remotes.ok) fail(`读取 remote 失败：${remotes.output}`)
if (!remotes.output.split('\n').includes('upstream')) {
  fail('缺少 upstream remote。先执行：\n  git remote add upstream https://github.com/kingOfSoySauce/dsh-skin-market.git')
}

const dirty = run('git', ['status', '--porcelain'])
if (!dirty.ok) fail(`读取工作区状态失败：${dirty.output}`)
if (dirty.output !== '') {
  fail(`工作区有未提交改动，先处理它们再同步：\n${dirty.output}`)
}

// 2) 拉取
console.log('→ 拉取 upstream（官方）…')
const fetchUpstream = run('git', ['fetch', '--depth=1', 'upstream', 'main'], { timeoutMs: FETCH_TIMEOUT_MS })
if (!fetchUpstream.ok) fail(`拉取 upstream 失败（网络或权限问题）：\n${fetchUpstream.output}`)

const behind = run('git', ['rev-list', '--count', 'HEAD..FETCH_HEAD'])
if (!behind.ok) fail(`比较提交失败：${behind.output}`)
const behindCount = Number(behind.output)
console.log(`  官方领先本地 ${behindCount} 个提交`)

if (behindCount === 0) {
  console.log('✓ 已是最新，无需同步')
  process.exit(0)
}

console.log('\n官方新增提交：')
const incoming = run('git', ['log', '--oneline', '--no-decorate', 'HEAD..FETCH_HEAD'])
if (incoming.ok) {
  for (const line of incoming.output.split('\n').slice(0, 20)) console.log(`  ${line}`)
  const total = incoming.output.split('\n').length
  if (total > 20) console.log(`  …另有 ${total - 20} 条`)
}

if (checkOnly) {
  console.log('\n（--check：未做任何改动）')
  process.exit(0)
}

// 3) 合并
console.log('\n→ 合并官方改动…')
const merge = run('git', ['merge', '--no-edit', 'FETCH_HEAD'], { timeoutMs: 120_000 })
if (!merge.ok) {
  console.error(`✗ 合并未完成：\n${merge.output}`)
  fail(
    '合并遇到冲突。本地改动与官方改动重叠，请手动处理：\n' +
      '  git status            # 查看冲突文件\n' +
      '  git merge --abort     # 放弃本次合并，回到合并前\n' +
      '处理完后重新运行本脚本。',
  )
}
console.log('  合并完成')

// 4) 重新构建（host: tsc；client: tsdown；registry: 生成目录）
if (!skipBuild) {
  const steps = [
    ['目录生成', ['exec', 'node', 'scripts/build-registry.mjs']],
    ['host 构建', ['exec', 'tsc', '-p', 'tsconfig.json']],
    ['client 构建', ['exec', 'tsdown']],
  ]
  for (const [label, commandArgs] of steps) {
    console.log(`\n→ ${label}：pnpm ${commandArgs.join(' ')}`)
    const result = run('pnpm', commandArgs, { inherit: true, timeoutMs: 600_000 })
    if (!result.ok) {
      fail(`${label} 失败。合并已完成但产物可能未更新，请手动执行：pnpm ${commandArgs.join(' ')}`)
    }
  }
  console.log('\n✓ 同步并构建完成')
} else {
  console.log('\n✓ 同步完成（--no-build：未重新构建）')
}

console.log(
  [
    '',
    '下一步：',
    '  1. 重启 DSH（host 半边需要重启才会加载）',
    '  2. 界面里确认皮肤市场正常',
    '  3. 想留档就推送自己的 fork： git push origin main',
  ].join('\n'),
)
