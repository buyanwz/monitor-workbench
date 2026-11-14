# 监控账号工作台（本地 exe 版）

本地 Windows 程序：视频与文件全部存在用户自己电脑上，一分钱不花、不用任何要绑卡的服务。
每天北京时间 8:00 自动采集、每账号最新 5 条（排除置顶）、保留 1～30 天（默认 3 天）、
平台分组＋组内排序、单作品预览与 ZIP 下载、任务中心、告警看板、操作日志。

权威需求见设计文档（`~/workspace/goals/kuaishou-benchmark-account-monitoring/files/监控账号Web工作台-设计文档.md`，
含用户定的 11 项硬条件）。本工程是该设计的本地落地：Cloudflare 路线因 R2 开通须绑卡而停，
改走本机 exe；业务逻辑与 Cloudflare 后端同一套，已验证的测试同样全过（见下）。

## 诚实限制（先说清楚）

1. **电脑关机或程序没开时，8:00 定时任务跑不了。** 程序内调度器只在程序运行时工作；
   下次打开程序时会补建当天的采集任务，过去日子的漏跑用界面「漏跑补采」手动补指定日期。
2. **自动直采尚未实现。** 快手接口有页面签名墙，服务端直调已证实调不通（见扩展拆解结论）；
   v1 采集只走扩展上报（`POST /api/v1/intake/report`，令牌鉴权＋去重＋置顶排除），
   以及界面上的手动上报。定时建出的任务在采集器落地前会失败并如实告警。
   嵌入式浏览器采集是后续待办，不在 v1 范围。
3. **界面是重写的。** 新台（Muse artifact，slug `jian-kong-zhang-hao`）的源码无法通过
   artifact 工具取出（fullstack artifact 没有源码导出接口，export 只支持 web_static，
   且该 artifact 在构建目录里不可见），因此界面按设计文档第五节＋方案 A 选配重写，
   未冒充「已取到源码」。方案 A 数值：侧栏 260px（可收 72px）、顶栏 64px、主色 #3366FF、
   浅色、内容区 24px 内边距、卡片小圆角＋边框＋轻阴影、线性图标、手机抽屉。
4. **无程序图标。** 打包暂用 Electron 默认图标，发版前补 `build/icon.ico` 并在
   electron-builder.yml 里配上（见「发版前待办」）。
5. **更新仓库是占位。** electron-builder.yml 里 `owner: buyanwz / repo: monitor-workbench`
   是占位，正式发版前须确认仓库真实存在，否则自动更新查不到更新。

## 架构

```
Electron 主进程（Node 24，无子进程）
  ├─ 本地 HTTP 服务（127.0.0.1，随机端口）：业务 handler（与 Cloudflare 版同一套）
  │    ├─ D1 兼容层 → node:sqlite（零原生依赖）→ <数据目录>/monitor.db
  │    ├─ R2 兼容层 → 本地文件 → <数据目录>/files/（key 即相对路径）
  │    └─ /ui/ 同源托管前端静态文件（无跨域问题）
  ├─ 程序内调度器（30 秒 tick，北京时间）：8:00 建任务、8:30 补采、3:00 清理＋快照、每分钟处理任务
  └─ 窗口（sandbox + contextIsolation，无 IPC、无 Node 集成）＋ electron-updater 自动更新
```

数据目录：Electron `userData`（Windows 上为 `%APPDATA%\监控账号工作台`），
环境变量 `MONITOR_DATA_DIR` 可覆盖（开发与测试用）。卸载不删数据。

```
<数据目录>/
  monitor.db      本地库（与 Cloudflare 版同一 schema，migrations/0001_init.sql）
  files/          视频/封面/ZIP/备份（key 即相对路径，如 works/kuaishou/<id>/video.mp4）
  secrets.json    本机密钥（首次启动自动生成，POSIX 0600；永不打印、永不进日志）
```

## 复用与改动清单

**原样复用（Cloudflare 版 `src/`，一字未动）：**
accounts、auth、cleanup、collect、crypto、dashboard、fetcher、intake、notify、
settings、tasks、util、works 共 13 个模块；`migrations/0001_init.sql`；
e2e 测试断言（152 条）与上限专项断言（11 条）。

**最小改动（3 处）：**
- `db.ts`：Env 的 `DB`/`BUCKET` 类型改成本地适配层，其余逻辑未动。
- `index.ts`：去掉 Worker 的 `scheduled` 钩子（定时改由程序内调度器驱动），路由与
  `runScheduled` 未动；`_test/*` 端点保留（仅 `MONITOR_TEST_MODE=1` 时启用）。
- `zip.ts`：`R2ObjectBody` 类型改成本地 `BucketObjectBody`；`backup.ts`/`collect.ts`/
  `cleanup.ts` 中 3 处提到 R2/D1 的注释与日志文案改成本地说法。

**新增（本地层）：**
- `server/src/localdb.ts`：D1 兼容层（prepare/bind/first/all/run，`meta.changes` 与
  `meta.last_row_id` 语义与 D1 一致，UNIQUE 报错含 `UNIQUE` 供上层识别）。
- `server/src/localbucket.ts`：R2 子集（put/get/delete/list，含 Range 流式；key 按段清洗防穿越；
  原子写；list 用文件 mtime 作 `uploaded`）。
- `server/src/nodehttp.ts`：Node http ↔ Fetch 适配（Host 头拼 URL，签名链接带真实端口；
  请求体 32MB 上限；`/ui/` 静态托管）。
- `server/src/secrets.ts`：本机密钥生成与读取（环境变量覆盖仅供测试）。
- `server/src/migrate.ts`：启动跑迁移（`_migrations` 表记账，幂等）。
- `server/src/scheduler.ts`：程序内调度器（见「诚实限制」第 1 条）。
- `server/src/server.ts` / `cli.ts`：服务组装与独立 CLI 入口。
- `electron/main.ts`：窗口＋服务生命周期＋菜单＋自动更新＋无头冒烟模式。
- `renderer/`：重写的前端（index.html / styles.css / app.js，零外部引用，全离线）。

**未复用（Cloudflare 专属，已废弃）：** wrangler.toml、Worker 绑定、D1/R2 远端资源。
D1 库已建但本方案不用云端，留着不花钱。

## 开发与测试

```bash
npm install
npm run typecheck        # tsc --noEmit
npm run test             # 类型检查 + e2e(152) + 上限专项(11)
npm run electron         # 构建后打开 Electron（开发运行）
npm run start            # 只起本地服务（CLI，端口 MONITOR_PORT，默认 17881）
```

测试说明：`test/run-e2e.sh` 与 `test/run-limits.sh` 起全新临时数据目录的本地服务
（`MONITOR_MOCK_FETCHER=1 MONITOR_TEST_MODE=1`，假密钥，调度器关闭，手动驱动 cron），
跑完即杀；直连库的 helper 由 `test/dbsql.mjs`（node:sqlite 直连）实现。
`MONITOR_SMOKE=1` 冒烟：Electron 无头跑完整首用流程（设口令 → 进应用 → 看板渲染）。

## 打包与发版

```bash
npm run pack:linux       # Linux dir 包（本机验证用，已验证：打包＋冒烟通过）
npm run dist:win         # Windows NSIS 安装包 → release/MonitorWorkbench-Setup-<version>.exe
```

实测结论（2026-11-14）：Linux 沙箱里 `dist:win` 跑到最后一步失败——electron-builder
组装 NSIS 安装包时要调 wine 改 exe 元数据，而沙箱没有 wine（`spawn wine ENOENT`）。
Windows 应用本体打包是通的（win-unpacked 与 121MB 的 nsis.7z 都生成出来了），
只差最后组装安装包这一步。与剧本工作台移植工程的既定结论一致：
**Windows 安装包须在 Windows 机器（或装 wine 的 Linux）上打**，发版走 GitHub Actions
Windows runner（与 script-workbench 同款工作流）。沙箱里的半成品已删，不留误导文件。

自动更新：electron-updater，更新源 GitHub Releases（见占位提醒）；启动 10 秒后静默查一次，
菜单可手动查；下载完弹窗问是否重启安装。`latest.yml` 由 electron-builder 在打包时生成，
随安装包一起传到 Releases 才能生效。

## 发版前待办

1. 确认 GitHub 仓库真实存在（owner/repo），与 electron-builder.yml 一致；否则自动更新查不到。
2. 补程序图标 `build/icon.ico`，并在 electron-builder.yml 的 `win.icon` 与 `nsis.*Icon` 配上。
3. 真机（Windows）验证：安装、首次打开设口令、导入/上报一条作品、预览播放、下载 ZIP、
   8:00 定时任务（或手动触发）、重启后数据与登录态、自动更新（发两个版本实测）。
4. 嵌入式浏览器采集（8:00 全自动直采）另行立项，探通再接；置顶排除须在真实响应里取证置顶字段。
5. 未来新增迁移文件时放 `server/migrations/`，按文件名顺序执行（`_migrations` 记账）。

## 安全口径

- 访问口令只存 PBKDF2 哈希（60 万次迭代）；会话 token 服务端只存 SHA-256；输错 5 次锁 15 分钟。
- 登录态 AES-GCM 加密存储，密钥只存本机 `secrets.json`；响应与日志永不含登录态原文与密文。
- 下载链接 HMAC 签名＋过期（默认 30 分钟，可配 5～120 分钟），无公开直链；文件删后链接即失效。
- 服务只绑 127.0.0.1，不对外监听；窗口 sandbox，不开 Node 集成。
