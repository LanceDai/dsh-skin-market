# dsh-skin-market（本地 fork）

这是 [kingOfSoySauce/dsh-skin-market](https://github.com/kingOfSoySauce/dsh-skin-market) 的本地 fork，
以 `link:` 方式装进 DSH profile，用来在**官方升级不覆盖**的前提下自定义皮肤市场的行为。

- **本仓库（fork）**：https://github.com/LanceDai/dsh-skin-market
- **上游（官方）**：https://github.com/kingOfSoySauce/dsh-skin-market
- 安装位置：`D:\soft\deepseek-harness\plugins\dsh-skin-market`
- profile 声明：`"dsh-skin-market": "link:D:/soft/deepseek-harness/plugins/dsh-skin-market"`

## 相对官方版增加的功能

| 功能 | 说明 |
|---|---|
| **「可一键安装」筛选** | 首页「发现更多」与左侧目录各有入口；判定复用市场自己的 `isManualOnly`，与卡片「需手动安装」口径一致 |
| **缩略图状态徽标** | 已安装 / 使用中 / 待重启 直接浮在卡片预览图右上角（原先只在卡片底部小字） |
| **peer 依赖预检** | 读取 npm 包的 `peerDependencies` 与本机 DSH 版本比对：详情页给出「安装会被版本闸门拒绝」的提示，卡片显示「版本不兼容」标签。带 10 分钟缓存、失败降级、只检查用户查看过的皮肤 |
| **自我更新保护** | 检测到 `link:` 安装时**拒绝**市场界面里的「自我更新」——那一步会执行 `pnpm add dsh-skin-market@<latest>`，把 fork 换成 npm 官方版 |

## 构建

```powershell
# 依赖（首次）
pnpm install

# 完整构建：目录生成 → host(tsc) → client(tsdown)
pnpm run registry
pnpm exec tsc -p tsconfig.json
pnpm exec tsdown
```

产物：`lib/`（host）、`client/client.js`（浏览器半边）、`data/catalog.json`（目录）。
注意：`lib/`、`client/`、`data/` 在仓库中是被跟踪的（官方发布产物由 CI 构建），
本地重建后需要一并提交，否则工作区会一直是脏的。

## 同步官方更新

```powershell
node scripts/sync-upstream.mjs --check   # 只看官方有没有新提交
node scripts/sync-upstream.mjs           # 合并官方改动并重新构建
node scripts/sync-upstream.mjs --no-build
```

脚本行为：工作区不干净时**拒绝执行**（避免把未提交改动卷进合并）；`fetch` 带超时；
合并冲突时保留现场并打印处理步骤。

**不要**用市场界面里的「自我更新」（会被本 fork 拦截并提示）。

## 生效范围

| 改动位置 | 生效方式 |
|---|---|
| `client/client.js` | **刷新页面**即可（宿主每次重载都重新拉取） |
| `lib/*`（host 半边） | **重启 DSH** 才会加载 |

> 注意：宿主按 `client.js` 的 `mtime + ctime + size` 计算资源版本号（artifactRevision）。
> 在页面已打开的情况下重建产物，会让该页面请求到旧版本号 → 404。
> 因此**重建后请让页面完整重载一次（或重启 DSH）**，不要边重建边点刷新。

## 测试

```powershell
pnpm exec vitest run
```

已知与本 fork 无关的失败：3 个测试套件依赖同级的站点仓库（`../site/*`，不在本仓库内），
另有若干 Windows 平台断言用例在非 CI 环境下不通过。
