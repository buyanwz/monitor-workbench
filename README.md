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
2. **浏览器采集已接进 v0.2.0，但置顶排除尚未取证，采回来的批次目前不入库。**
   内嵌浏览器（持久分区存登录态）打开账号主页，debugger 协议截获页面自己发出的
   `/rest/v/profile/feed` 返回正文，映射后走同一采集引擎；登录窗口在设置页打开，
   验证码用户手动处理。快手接口有页面签名墙，服务端直调已证实调不通（见扩展拆解结论），
   所以主路是截获、不是直调，签名器借用只作后备探测、不用它发请求。
   置顶字段至今无证据（扩展代码里 0 命中），按规格一律 `has_pinned_field=false`，
   批次标 `needs_review`、整批不入库——这是正确的保护行为，不是 bug。
   取证办法：截获的原始返回存 `<数据目录>/captures/`（每账号最近 5 份，含字段清单），
   在真机上抓一条真实返回、人工判定哪个字段是置顶标记后，才能把排除逻辑接上。
   另有 3 项只能真机验证：打开主页是否触发 feed 请求（R3）、真实登录态寿命（R5）、
   Windows 下分区/debugger/端口行为（R9）。扩展上报与手动上报仍可用（上报令牌见设置页）。
3. **界面是重写的。** 新台（Muse artifact，slug `jian-kong-zhang-hao`）的源码无法通过
   artifact 工具取出（fullstack artifact 没有源码导出接口，export 只支持 web_static，
   且该 artifact 在构建目录里不可见），因此界面按设计文档第五节＋方案 A 选配重写，
   未冒充「已取到源码」。方案 A 数值：侧栏 260px（可收 72px）、顶栏 64px、主色 #3366FF、
   浅色、内容区 24px 内边距、卡片小圆角＋边框＋轻阴影、线性图标、手机抽屉。
4. **无程序图标。** 打包暂用 Electron 默认图标，发版前补 `build/icon.ico` 并在
   electron-builder.yml 里配上（见「发版前待办」）。
5. **更新仓库已确认。** electron-builder.yml 里 `owner: buyanwz / repo: monitor-workbench`
   已真实存在，v0.1.0 已发布，自动更新查得到；发两个版本实测更新链仍是真机待办。

## 架构

```
Electron 主进程（Node 24，无子进程）
  ├─ 本地 HTTP 服务（127.0.0.1，固定端口 17881，冲突顺延最多 10 个；MONITOR_PORT 可覆盖，0=随机）
  │    ├─ D1 兼容层 → node:sqlite（零原生依赖）→ <数据目录>/monitor.db
  │    ├─ R2 兼容层 → 本地文件 → <数据目录>/files/（key 即相对路径）
  │    └─ /ui/ 同源托管前端静态文件（无跨域问题）
  ├─ 程序内调度器（30 秒 tick，北京时间）：8:00 建任务、8:30 补采、3:00 清理＋快照、每分钟处理任务
  ├─ 浏览器采集器（隐藏窗口，persist:monitor-kuaishou 分区）：debugger 截获 feed 返回正文，
  │   媒体下载带分区 cookie；登录窗口平时隐藏，设置页/菜单可弹出
  └─ 窗口（sandbox + contextIsolation，无 IPC、无 Node 集成）＋ electron-updater 自动更新
```

数据目录：Electron `userData`（Windows 上为 `%APPDATA%\监控账号工作台`），
环境变量 `MONITOR_DATA_DIR` 可覆盖（开发与测试用）。卸载不删数据。

```
<数据目录>/
  monitor.db      本地库（与 Cloudflare 版同一 schema，migrations/0001_init.sql）
  files/          视频/封面/ZIP/备份（key 即相对路径，如 works/kuaishou/<id>/video.mp4）
  captures/       截获的 feed 原始返回 + 字段清单（取证置顶字段用，每账号最近 5 份）
  secrets.json    本机密钥（首次启动自动生成，POSIX 0600；永不打印、永不进日志）
  Partitions/     内嵌浏览器分区（含快手登录 cookie，重启保留）
```

## 复用与改动清单

**原样复用（Cloudflare 版 `src/`，一字未动）：**
accounts、auth、cleanup、crypto、dashboard、notify、
settings、tasks、util、works 共 10 个模块；`migrations/0001_init.sql`；
e2e 测试断言（152 条）与上限专项断言（11 条）。
（collect、fetcher、intake、db、index 在 v0.2.0 接浏览器采集时改过，见下。）

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

**v0.2.0 改动（浏览器采集）：**
- `electron/collect-preload.ts`（新）：MAIN world 注入——签名器陷阱（只作后备探测）＋
  fetch/XHR 包装（补充截获），经 IPC 上报主进程。
- `electron/feed-map.ts`（新）：feed 返回正文映射（已知字段）＋结果码分类＋字段清单
  （取证用），纯函数，不依赖 Electron。
- `electron/browser-collect.ts`（新）：浏览器采集器——隐藏窗口（`persist:monitor-kuaishou`
  分区）、debugger 截获（暖机加载→挂接→再导航）、带分区 cookie 的媒体下载、登录窗
  控制、截获存档（每账号最近 5 份）。
- `electron/main.ts`：固定端口 17881（`MONITOR_PORT` 覆盖，0=随机）、启动注册采集器、
  登录窗口菜单、冒烟扩展（设置页浏览器采集区）。
- `server/src/fetcher.ts`：`selectFetcher` 增浏览器分支（由 Electron 注册；CLI/无 Electron
  环境保持未实现报错，绝不静默降级）。
- `server/src/collect.ts`：浏览器模式跳过登录态解密门、改查浏览器登录；单账号 120 秒
  超时与失败分类不变。
- `server/src/browser.ts`（新）：浏览器状态/登录窗接口。
- `server/src/secrets.ts`：`LocalSecrets` 加 `intakeToken`（首次生成、0600 落盘、可轮换）。
- `server/src/intake.ts`/`db.ts`：`/intake/report` 加上报令牌鉴权（只对上报端点有效）。
- `server/src/server.ts`/`cli.ts`：端口冲突兜底（顺延最多 10 个）、实际端口落库。
- `server/src/index.ts`：4 个新接口（`browser/status`、`browser/show-login`、
  `intake/token` 查看与轮换），走现有 60 次/分钟限流。
- `renderer/`：设置页「浏览器采集」区（登录状态/打开登录窗/上报地址与令牌/当前端口）、
  账号页采集登录标注、任务中心 needs_review 文案。

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
`MONITOR_SMOKE=1` 冒烟：Electron 无头跑完整首用流程（设口令 → 进应用 → 看板渲染 →
设置页浏览器采集区核对）。
手动跑的脚本（不进 `npm test`）：`test/port-fallback.sh`（端口冲突兜底 2 条）、
`test/run-browser-routes.sh`（浏览器/上报令牌接口 20 条）、
`test/browser-collect-verify.mjs`（探针式验证 43 条：映射单测＋本地页截获端到端＋
采集引擎全链路；只连 127.0.0.1，绝不访问快手）。

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

自动更新：electron-updater，更新源 GitHub Releases（仓库已确认）；启动 10 秒后静默查一次，
菜单可手动查；下载完弹窗问是否重启安装。`latest.yml` 由 electron-builder 在打包时生成，
随安装包一起传到 Releases 才能生效。

## 发版前待办

1. ~~确认 GitHub 仓库真实存在~~（已确认：buyanwz/monitor-workbench，v0.1.0 已发布）。
2. 补程序图标 `build/icon.ico`，并在 electron-builder.yml 的 `win.icon` 与 `nsis.*Icon` 配上。
3. 真机（Windows）验证：安装、首次打开设口令、导入/上报一条作品、预览播放、下载 ZIP、
   8:00 定时任务（或手动触发）、重启后数据与登录态、自动更新（发两个版本实测）。
4. 浏览器采集真机验证（4 项，沙箱无法验证）：快手真实登录后打开账号主页是否触发
   feed 请求；真实登录态能维持多久；从 `captures/` 存档的真实返回里判定置顶字段名、
   接上置顶排除；Windows 下分区/debugger/端口兜底行为与 Linux 一致。
5. 未来新增迁移文件时放 `server/migrations/`，按文件名顺序执行（`_migrations` 记账）。

## 安全口径

- 访问口令只存 PBKDF2 哈希（60 万次迭代）；会话 token 服务端只存 SHA-256；输错 5 次锁 15 分钟。
- 登录态 AES-GCM 加密存储，密钥只存本机 `secrets.json`；响应与日志永不含登录态原文与密文。
- 下载链接 HMAC 签名＋过期（默认 30 分钟，可配 5～120 分钟），无公开直链；文件删后链接即失效。
- 上报令牌只对 `/intake/report` 一个端点有效，不等于会话登录；服务端只比 SHA-256 哈希，
  令牌值只存 `secrets.json`，永不打印、永不进日志；轮换后旧令牌立即失效。
- 服务只绑 127.0.0.1，不对外监听；窗口 sandbox，不开 Node 集成。
