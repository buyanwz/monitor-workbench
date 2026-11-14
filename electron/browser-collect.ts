// 浏览器采集器：Electron 内嵌浏览器 + debugger 协议截获页面请求正文。
// 主路（P2 首选）：页面自己发请求、自己签名，程序只读返回正文——不借签名器、
// 不直调平台接口、不伪造任何请求。preload 的 fetch/XHR 包装是补充捕获源；
// 小红书另有 __INITIAL_STATE__ 补充捕获（形状校验、失败静默降级）。
// 三平台各用独立持久分区存登录态（P1 已证实重启保留）；验证码一律用户在
// 对应平台的登录窗口里手动处理。平台差异收敛在 PLATFORM_CONFIGS 配置表里，
// 采集流程（暖机→挂接→导航→截获→映射→存档）三平台同一套。
// 铁律：
//   - 置顶字段：快手/抖音无证据，has_pinned_field=false，批次走 needs_review 不入库；
//     小红书 interact_info.sticky 已证实，has_pinned_field=true，直接排除置顶；
//   - 截获到的原始返回存 <数据目录>/captures/ 供人工取证（每账号只留最近 5 份）；
//   - 捕获失败显式抛分类错误，绝不假装成功、绝不编数据；
//   - 媒体下载必须带分区 cookie（R8），不用裸 HTTP 客户端；
//   - 未知平台绝不静默降级，直接报“尚未接入”。

import { BrowserWindow, ipcMain, session } from "electron";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  FetcherError,
  type FetchResult,
  type MediaBytes,
  type PlatformFetcher,
} from "../server/src/fetcher";
import type { BrowserControl, BrowserPlatformStatus } from "../server/src/db";
import { asRecord, type FeedParser } from "./feed-map-common";
import { collectFieldInventory, parseFeedResponse } from "./feed-map-kuaishou";
import { collectDouyinFieldInventory, parseDouyinResponse } from "./feed-map-douyin";
import { collectXiaohongshuFieldInventory, parseXiaohongshuResponse } from "./feed-map-xiaohongshu";

export const COLLECT_PARTITION = "persist:monitor-kuaishou";
export const DOUYIN_PARTITION = "persist:monitor-douyin";
export const XIAOHONGSHU_PARTITION = "persist:monitor-xiaohongshu";

export interface PlatformCollectConfig {
  platform: string;
  label: string;
  partition: string;
  loginUrl: string;
  cookieUrl: string;
  /** 作品列表响应的 URL 特征（子串匹配，debugger 与 preload 共用）。 */
  feedMarks: string[];
  parse: FeedParser;
  inventory: (data: unknown) => Record<string, unknown>;
  /** 平台返回是否带置顶字段（有证据才为 true）。 */
  hasPinnedField: boolean;
  /** 是否启用 __INITIAL_STATE__ 补充捕获（仅小红书有证据）。 */
  ssrCapture?: boolean;
}

export const PLATFORM_CONFIGS: PlatformCollectConfig[] = [
  {
    platform: "kuaishou",
    label: "快手",
    partition: COLLECT_PARTITION,
    loginUrl: "https://www.kuaishou.com",
    cookieUrl: "https://www.kuaishou.com",
    feedMarks: ["/rest/v/profile/feed"],
    parse: (body) => ({ works: parseFeedResponse(body), skippedCount: 0 }),
    inventory: (data) => collectFieldInventory(data) as unknown as Record<string, unknown>,
    hasPinnedField: false,
  },
  {
    platform: "douyin",
    label: "抖音",
    partition: DOUYIN_PARTITION,
    loginUrl: "https://www.douyin.com",
    cookieUrl: "https://www.douyin.com",
    feedMarks: ["/aweme/v1/web/aweme/post"],
    parse: parseDouyinResponse,
    inventory: (data) => collectDouyinFieldInventory(data) as unknown as Record<string, unknown>,
    hasPinnedField: false,
  },
  {
    platform: "xiaohongshu",
    label: "小红书",
    partition: XIAOHONGSHU_PARTITION,
    loginUrl: "https://www.xiaohongshu.com",
    cookieUrl: "https://www.xiaohongshu.com",
    feedMarks: ["/api/sns/web/v1/user_posted"],
    parse: parseXiaohongshuResponse,
    inventory: (data) => collectXiaohongshuFieldInventory(data) as unknown as Record<string, unknown>,
    hasPinnedField: true,
    ssrCapture: true,
  },
];

export function configForPlatform(platform: string): PlatformCollectConfig | null {
  return PLATFORM_CONFIGS.find((c) => c.platform === platform) ?? null;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 90_000;
const PAGE_LOAD_TIMEOUT_MS = 60_000;
const SSR_CAPTURE_DELAY_MS = 2000;
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;
const MAX_CAPTURES_PER_ACCOUNT = 5;
const CAPTURE_TIMEOUT_MESSAGE =
  "打开主页后未捕获到作品列表请求：页面可能没有主动加载作品列表，请在登录窗口里手动打开该账号主页确认后再试";

export interface BrowserCollectorOptions {
  dataDir: string;
  /** 登录窗口打开的地址（默认各平台首页；仅验证脚本覆盖为本地测试页）。 */
  loginUrl?: string;
  /** preload 文件路径（默认与主进程包同目录的 collect-preload.cjs；仅验证脚本覆盖）。 */
  preloadPath?: string;
  captureTimeoutMs?: number;
}

interface PreloadEvent {
  type?: unknown;
  url?: unknown;
  body?: unknown;
  at?: unknown;
}

export class BrowserCollector implements PlatformFetcher, BrowserControl {
  readonly usesBrowserLogin = true;
  private readonly dataDir: string;
  private readonly loginUrlOverride: string | undefined;
  private readonly preloadPath: string;
  private readonly captureTimeoutMs: number;
  private wins = new Map<string, BrowserWindow>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastCaptureAtByPlatform = new Map<string, number>();
  private disposed = false;
  private captureFeed: ((body: string, source: string, url?: string) => void) | null = null;
  private readonly ipcHandler: (event: Electron.IpcMainEvent, detail: PreloadEvent) => void;

  constructor(opts: BrowserCollectorOptions) {
    this.dataDir = opts.dataDir;
    this.loginUrlOverride = opts.loginUrl;
    this.preloadPath = opts.preloadPath ?? path.join(__dirname, "collect-preload.cjs");
    this.captureTimeoutMs = opts.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    this.ipcHandler = (_event, detail) => {
      if (!detail || detail.type !== "feed-capture" || typeof detail.body !== "string") return;
      if (typeof detail.url !== "string" || !detail.url) return; // 无 URL 的捕获事件丢弃，不猜平台
      this.captureFeed?.(detail.body, "preload", detail.url);
    };
    ipcMain.on("monitor-collect-event", this.ipcHandler);
  }

  /** 指定平台分区内是否存在平台 cookie（登录状态启发式判断；无 cookie = 未登录）。 */
  async checkBrowserLogin(platform: string = "kuaishou"): Promise<boolean> {
    const config = configForPlatform(platform);
    if (!config) return false;
    try {
      const cookies = await session.fromPartition(config.partition).cookies.get({ url: config.cookieUrl });
      return cookies.length > 0;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<{
    loggedIn: boolean;
    lastCaptureAt: number | null;
    platforms: Record<string, BrowserPlatformStatus>;
  }> {
    const platforms: Record<string, BrowserPlatformStatus> = {};
    let latest: number | null = null;
    for (const config of PLATFORM_CONFIGS) {
      const st: BrowserPlatformStatus = {
        loggedIn: await this.checkBrowserLogin(config.platform),
        lastCaptureAt: this.lastCaptureAtByPlatform.get(config.platform) ?? null,
      };
      platforms[config.platform] = st;
      if (st.lastCaptureAt !== null && (latest === null || st.lastCaptureAt > latest)) latest = st.lastCaptureAt;
    }
    // 旧字段语义不变：loggedIn = 快手登录状态；lastCaptureAt = 最近一次截获（任一平台）
    return { loggedIn: platforms.kuaishou.loggedIn, lastCaptureAt: latest, platforms };
  }

  /** 弹出指定平台的登录窗口（平时隐藏；用户在里面登录/过验证码，关窗口只是隐藏，登录态保留）。 */
  async showLoginWindow(platform: string = "kuaishou"): Promise<void> {
    if (this.disposed) throw new Error("浏览器采集器已关闭");
    const config = configForPlatform(platform);
    if (!config) throw new Error(`平台 ${platform} 尚未接入浏览器采集`);
    const win = this.ensureWindow(config);
    const target = this.loginUrlOverride ?? config.loginUrl;
    const current = win.webContents.getURL();
    if (current !== target) {
      // 加载失败也显示窗口，让用户亲眼看到问题
      await this.loadWithTimeout(win, target, PAGE_LOAD_TIMEOUT_MS).catch(() => undefined);
    }
    win.show();
    win.focus();
  }

  async fetchWorks(
    account: { platform: string; account_id: string; name: string; home_url?: string },
    _loginState: string,
  ): Promise<FetchResult> {
    // 串行化：同一时刻只采一个账号（R7 逐账号顺序采集），防 debugger 抢占
    const run = this.queue.then(() => this.fetchWorksInner(account));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 媒体下载：合并三个平台分区的 cookie 取（R8），不用裸 HTTP 客户端。
   * cookies.get 按 URL 域名过滤，只有归属分区会返回该媒体地址的 cookie，
   * 因此合并是安全的，不需要按 URL 猜平台。
   */
  async download(url: string): Promise<MediaBytes> {
    const cookieParts: string[] = [];
    let userAgent = "";
    for (const config of PLATFORM_CONFIGS) {
      try {
        const sess = session.fromPartition(config.partition);
        if (!userAgent) userAgent = sess.getUserAgent();
        const cookies = await sess.cookies.get({ url });
        for (const c of cookies) cookieParts.push(`${c.name}=${c.value}`);
      } catch {
        // 取不到 cookie 也试一次，由服务端返回决定成败
      }
    }
    const headers: Record<string, string> = {};
    if (userAgent) headers["User-Agent"] = userAgent;
    const merged = [...new Set(cookieParts)].join("; ");
    if (merged) headers.Cookie = merged;
    let res: Response;
    try {
      res = await fetch(url, { headers, redirect: "follow" });
    } catch (e) {
      throw new FetcherError("network", `媒体下载失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404 || res.status === 410) throw new FetcherError("deleted", "媒体文件不存在（可能已删除）");
    if (!res.ok) throw new FetcherError("network", `媒体下载失败：HTTP ${res.status}`);
    const len = res.headers.get("content-length");
    if (len && Number(len) > MAX_DOWNLOAD_BYTES) throw new FetcherError("other", "媒体文件超过下载上限");
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new FetcherError("other", "媒体文件超过下载上限");
    return { bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  dispose(): void {
    this.disposed = true;
    ipcMain.removeListener("monitor-collect-event", this.ipcHandler);
    for (const win of this.wins.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.wins.clear();
  }

  private ensureWindow(config: PlatformCollectConfig): BrowserWindow {
    const existing = this.wins.get(config.platform);
    if (existing && !existing.isDestroyed()) return existing;
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      title: `${config.label}登录（监控采集用）`,
      webPreferences: {
        partition: config.partition,
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.on("closed", () => {
      if (this.wins.get(config.platform) === win) this.wins.delete(config.platform);
    });
    // 点 X 只是隐藏（登录态与窗口都保留）；程序退出时 dispose() 才会真正销毁
    win.on("close", (e) => {
      if (!this.disposed) {
        e.preventDefault();
        win.hide();
      }
    });
    this.wins.set(config.platform, win);
    return win;
  }

  /**
   * 挂接 debugger：暖机加载刚完成时立即挂接偶发 "target closed"（渲染器尚不稳定，
   * 探针验证实测），须先等页面停稳再挂；失败则等 1 秒重试一次，仍失败才报错。
   */
  private async attachDebugger(win: BrowserWindow): Promise<void> {
    const start = Date.now();
    while (win.webContents.isLoading() && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500));
    const dbg = win.webContents.debugger;
    try {
      dbg.attach("1.3");
      await dbg.sendCommand("Network.enable");
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        if (!dbg.isAttached()) dbg.attach("1.3");
        await dbg.sendCommand("Network.enable");
      } catch (e) {
        throw new FetcherError("other", `调试协议挂接失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async loadWithTimeout(win: BrowserWindow, url: string, timeoutMs: number): Promise<void> {
    await Promise.race([
      win.loadURL(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("页面加载超时")), timeoutMs)),
    ]);
  }

  private async fetchWorksInner(account: {
    platform: string;
    account_id: string;
    name: string;
    home_url?: string;
  }): Promise<FetchResult> {
    if (this.disposed) throw new FetcherError("other", "浏览器采集器已关闭");
    const config = configForPlatform(account.platform);
    if (!config) throw new FetcherError("other", `平台 ${account.platform} 尚未接入浏览器采集`);
    if (!(await this.checkBrowserLogin(config.platform))) {
      throw new FetcherError("login_expired", `浏览器里还没登录${config.label}，请在设置页打开${config.label}登录窗口登录`);
    }
    let profileUrl = (account.home_url ?? "").trim();
    if (!profileUrl) {
      throw new FetcherError("other", "账号未配置主页链接，浏览器采集无法打开主页");
    }
    if (config.platform === "douyin" && isDouyinShortLink(profileUrl)) {
      throw new FetcherError("other", "请贴完整主页链接（短链暂不支持）");
    }
    if (config.platform === "xiaohongshu") {
      profileUrl = stripXsecParams(profileUrl); // 干净 URL，由页面自行补 token（R-X2）
    }
    const win = this.ensureWindow(config);
    // 1. 暖机加载：debugger 在首次导航前挂接会挂起约 30 秒（P2 实测坑），须先加载一次
    try {
      await this.loadWithTimeout(win, profileUrl, PAGE_LOAD_TIMEOUT_MS);
    } catch (e) {
      throw new FetcherError("network", `主页加载失败：${e instanceof Error ? e.message : String(e)}`);
    }
    // 2. 布防截获 → 挂 debugger → 再次导航触发请求
    const armed = this.armCapture(win, config);
    void armed.promise.catch(() => undefined); // 提前认领 rejection，防中途 abort 造成未处理 rejection
    try {
      await this.attachDebugger(win);
      const nav = this.loadWithTimeout(win, profileUrl, PAGE_LOAD_TIMEOUT_MS).catch(() => {
        // 导航失败不立即报错：已布防的截获可能已拿到数据，交给截获超时兜底
      });
      if (config.ssrCapture) {
        // 补充捕获源：与导航并行读页面 SSR 状态，失败静默降级，不影响主路
        void this.trySsrCapture(win, armed.feed);
      }
      await nav;
      const { body, source } = await armed.promise;
      let parsed;
      try {
        parsed = config.parse(body);
      } catch (e) {
        // 映射失败也存档（写明解析错误），供人工看原始返回到底是什么
        await this.persistCapture(account.account_id, config, profileUrl, body, source, null, e instanceof Error ? e.message : String(e));
        throw e;
      }
      await this.persistCapture(account.account_id, config, profileUrl, body, source, parsed.skippedCount, null);
      this.lastCaptureAtByPlatform.set(config.platform, Date.now());
      return {
        works: parsed.works,
        has_pinned_field: config.hasPinnedField,
        skippedCount: parsed.skippedCount,
        skippedNote: parsed.skippedCount > 0 ? "图文作品" : undefined,
      };
    } catch (e) {
      armed.abort(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  /**
   * __INITIAL_STATE__ 补充捕获（仅小红书）：首屏笔记嵌在页面初始状态里，
   * 不依赖网络截获。只作成功源、永不作失败源：形状不对、缺 note_id、
   * 读不到时一律静默放弃，网络截获继续跑。
   */
  private async trySsrCapture(
    win: BrowserWindow,
    feed: (body: string, source: string) => void,
  ): Promise<void> {
    try {
      await new Promise((r) => setTimeout(r, SSR_CAPTURE_DELAY_MS));
      if (this.disposed || win.isDestroyed()) return;
      const raw = (await win.webContents.executeJavaScript(
        `(function () {
          try {
            var s = window.__INITIAL_STATE__;
            if (!s || !s.user || !s.user.notes) return null;
            var raw = s.user.notes._rawValue;
            var cands = [];
            if (Array.isArray(raw)) { cands.push(raw[0]); cands.push(raw); }
            if (raw) cands.push(raw);
            cands.push(s.user.notes);
            for (var i = 0; i < cands.length; i++) {
              var c = cands[i];
              if (Array.isArray(c) && c.length > 0) return JSON.stringify(c);
              if (c && Array.isArray(c.notes) && c.notes.length > 0) return JSON.stringify(c.notes);
            }
            return null;
          } catch (e) { return null; }
        })()`,
      )) as unknown;
      if (typeof raw !== "string" || !raw) return;
      let notes: unknown;
      try {
        notes = JSON.parse(raw);
      } catch {
        return;
      }
      if (!Array.isArray(notes) || notes.length === 0) return;
      // 严格校验：每条都须带 note_id，否则放弃（避免补充源造成误报登录失效）
      const allValid = notes.every((n) => {
        const rec = asRecord(n);
        return !!rec && !!rec.note_id;
      });
      if (!allValid) return;
      feed(raw, "ssr-state");
    } catch {
      // 静默降级：补充源任何异常都不影响主路
    }
  }

  /**
   * 布防截获：监听 debugger 的 Network 事件（主路）+ preload 转发的捕获（补充），
   * 先到先得；超时未捕获则失败。收尾时拆监听、清 sink、detach debugger。
   * feed(body, source, url?)：url 省略表示已预过滤（debugger 内部）；带 url 时须命中
   * 本平台的 feedMarks（preload 事件），否则丢弃——多窗口并存时不串平台。
   */
  private armCapture(
    win: BrowserWindow,
    config: PlatformCollectConfig,
  ): {
    promise: Promise<{ body: string; source: string }>;
    abort: (err: Error) => void;
    feed: (body: string, source: string, url?: string) => void;
  } {
    const dbg = win.webContents.debugger;
    const requestIds = new Set<string>();
    let finish!: (value: { body: string; source: string } | null, err?: Error) => void;
    const promise = new Promise<{ body: string; source: string }>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(null, new FetcherError("other", CAPTURE_TIMEOUT_MESSAGE)), this.captureTimeoutMs);
      const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
        try {
          if (method === "Network.responseReceived") {
            const response = params.response as { url?: string } | undefined;
            const requestId = params.requestId as string | undefined;
            const url = response?.url;
            if (typeof url === "string" && config.feedMarks.some((m) => url.includes(m)) && requestId) {
              requestIds.add(requestId);
            }
          } else if (method === "Network.loadingFinished") {
            const requestId = params.requestId as string | undefined;
            if (!requestId || !requestIds.has(requestId)) return;
            requestIds.delete(requestId);
            void dbg
              .sendCommand("Network.getResponseBody", { requestId })
              .then((b) => {
                const raw = b as unknown as { body?: string; base64Encoded?: boolean };
                if (typeof raw.body !== "string") return;
                const body = raw.base64Encoded ? Buffer.from(raw.body, "base64").toString("utf8") : raw.body;
                finish({ body, source: "debugger" });
              })
              .catch(() => {
                // 正文拿不到时等其他捕获源，不判失败
              });
          }
        } catch {
          // 忽略单条事件异常
        }
      };
      finish = (value, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        dbg.removeListener("message", onMessage);
        if (this.captureFeed === feed) this.captureFeed = null;
        try {
          if (dbg.isAttached()) dbg.detach();
        } catch {
          // 忽略
        }
        if (err) reject(err);
        else if (value) resolve(value);
      };
      const feed = (body: string, source: string, url?: string) => {
        if (url !== undefined && !config.feedMarks.some((m) => url.includes(m))) return;
        finish({ body, source });
      };
      this.captureFeed = feed;
      dbg.on("message", onMessage);
    });
    return {
      promise,
      abort: (err: Error) => finish(null, err),
      feed: (body: string, source: string) => {
        // SSR 补充源：无 URL，调用方已做形状校验，直接送入
        if (this.captureFeed) this.captureFeed(body, source);
      },
    };
  }

  /**
   * 截获存档（取证用）：原始返回 + 字段清单写 <数据目录>/captures/，供人工判定
   * 置顶字段与核对字段形状；每账号只留最近 5 份。存档失败只记日志，不影响本次采集。
   */
  private async persistCapture(
    accountId: string,
    config: PlatformCollectConfig,
    url: string,
    body: string,
    source: string,
    skippedCount: number | null,
    parseError: string | null,
  ): Promise<void> {
    try {
      const dir = path.join(this.dataDir, "captures");
      await fs.mkdir(dir, { recursive: true });
      const safe = accountId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "account";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `feed-${safe}-${stamp}.json`);
      let inventory: unknown = null;
      try {
        inventory = config.inventory(JSON.parse(body));
      } catch {
        inventory = null;
      }
      const payload = {
        captured_at: Date.now(),
        account_id: accountId,
        platform: config.platform,
        url,
        source,
        skipped_count: skippedCount,
        parse_error: parseError,
        field_inventory: inventory,
        raw: body.slice(0, 10 * 1024 * 1024),
      };
      await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
      const entries = (await fs.readdir(dir)).filter((n) => n.startsWith(`feed-${safe}-`)).sort();
      for (const old of entries.slice(0, Math.max(0, entries.length - MAX_CAPTURES_PER_ACCOUNT))) {
        await fs.unlink(path.join(dir, old)).catch(() => undefined);
      }
    } catch (e) {
      console.warn("[browser-collect] 截获存档失败（不影响本次采集）", e);
    }
  }
}

/** 抖音短链判定：v.douyin.com 主机（或裸串里的短链）一律拒绝，由用户贴完整链接。 */
export function isDouyinShortLink(profileUrl: string): boolean {
  try {
    const host = new URL(profileUrl).hostname.toLowerCase();
    if (host === "v.douyin.com" || host.endsWith(".v.douyin.com")) return true;
  } catch {
    // 解析失败时退回子串判定
  }
  return /(^|[/?#])v\.douyin\.com\//i.test(profileUrl);
}

/** 小红书主页链接去 token：去掉 xsec_token/xsec_source 查询参数，解析失败原样返回。 */
export function stripXsecParams(profileUrl: string): string {
  try {
    const u = new URL(profileUrl);
    u.searchParams.delete("xsec_token");
    u.searchParams.delete("xsec_source");
    return u.toString();
  } catch {
    return profileUrl;
  }
}
