// 浏览器采集器：Electron 内嵌浏览器 + debugger 协议截获页面请求正文。
// 主路（P2 首选）：页面自己发请求、自己签名，程序只读返回正文——不借签名器、
// 不直调平台接口、不伪造任何请求。preload 的 fetch/XHR 包装是补充捕获源。
// 登录态：persist:monitor-kuaishou 分区 cookie，用户在登录窗口里登一次，
// 重启程序还在（P1 已证实）；验证码一律用户在登录窗口里手动处理。
// 铁律：
//   - 置顶字段无证据，has_pinned_field 恒为 false，批次走 needs_review 不入库（P5/R4）；
//   - 截获到的原始返回存 <数据目录>/captures/ 供人工取证置顶字段（每账号只留最近 5 份）；
//   - 捕获失败显式抛分类错误，绝不假装成功、绝不编数据；
//   - 媒体下载必须带分区 cookie（R8），不用裸 HTTP 客户端。

import { BrowserWindow, ipcMain, session } from "electron";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  FetcherError,
  type FetchResult,
  type MediaBytes,
  type PlatformFetcher,
} from "../server/src/fetcher";
import type { BrowserControl } from "../server/src/db";
import { collectFieldInventory, parseFeedResponse } from "./feed-map";

export const COLLECT_PARTITION = "persist:monitor-kuaishou";
const KUAISHOU_HOME = "https://www.kuaishou.com";
const KUAISHOU_COOKIE_URL = "https://www.kuaishou.com";
const FEED_PATH = "/rest/v/profile/feed";
const DEFAULT_CAPTURE_TIMEOUT_MS = 90_000;
const PAGE_LOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;
const MAX_CAPTURES_PER_ACCOUNT = 5;
const CAPTURE_TIMEOUT_MESSAGE =
  "打开主页后未捕获到作品列表请求：页面可能没有主动加载作品列表，请在登录窗口里手动打开该账号主页确认后再试";

export interface BrowserCollectorOptions {
  dataDir: string;
  /** 登录窗口打开的地址（默认快手首页；仅验证脚本覆盖为本地测试页）。 */
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
  private readonly loginUrl: string;
  private readonly preloadPath: string;
  private readonly captureTimeoutMs: number;
  private win: BrowserWindow | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCaptureAt: number | null = null;
  private disposed = false;
  private captureSink: ((body: string, source: string) => void) | null = null;
  private readonly ipcHandler: (event: Electron.IpcMainEvent, detail: PreloadEvent) => void;

  constructor(opts: BrowserCollectorOptions) {
    this.dataDir = opts.dataDir;
    this.loginUrl = opts.loginUrl ?? KUAISHOU_HOME;
    this.preloadPath = opts.preloadPath ?? path.join(__dirname, "collect-preload.cjs");
    this.captureTimeoutMs = opts.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    this.ipcHandler = (_event, detail) => {
      if (!detail || detail.type !== "feed-capture" || typeof detail.body !== "string") return;
      if (typeof detail.url === "string" && !detail.url.includes(FEED_PATH)) return;
      this.captureSink?.(detail.body, "preload");
    };
    ipcMain.on("monitor-collect-event", this.ipcHandler);
  }

  /** 分区内是否存在快手 cookie（登录状态启发式判断；无 cookie = 未登录）。 */
  async checkBrowserLogin(): Promise<boolean> {
    try {
      const cookies = await session.fromPartition(COLLECT_PARTITION).cookies.get({ url: KUAISHOU_COOKIE_URL });
      return cookies.length > 0;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<{ loggedIn: boolean; lastCaptureAt: number | null }> {
    return { loggedIn: await this.checkBrowserLogin(), lastCaptureAt: this.lastCaptureAt };
  }

  /** 弹出登录窗口（平时隐藏；用户在里面登录/过验证码，关窗口只是隐藏，登录态保留）。 */
  async showLoginWindow(): Promise<void> {
    if (this.disposed) throw new Error("浏览器采集器已关闭");
    const win = this.ensureWindow();
    const current = win.webContents.getURL();
    if (current !== this.loginUrl) {
      // 加载失败也显示窗口，让用户亲眼看到问题
      await this.loadWithTimeout(win, this.loginUrl, PAGE_LOAD_TIMEOUT_MS).catch(() => undefined);
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

  /** 媒体下载：带分区 cookie 取（R8），不用裸 HTTP 客户端。 */
  async download(url: string): Promise<MediaBytes> {
    const sess = session.fromPartition(COLLECT_PARTITION);
    let cookieHeader = "";
    try {
      const cookies = await sess.cookies.get({ url });
      cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch {
      // 取不到 cookie 也试一次，由服务端返回决定成败
    }
    const headers: Record<string, string> = { "User-Agent": sess.getUserAgent() };
    if (cookieHeader) headers.Cookie = cookieHeader;
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
    if (this.win && !this.win.isDestroyed()) {
      const w = this.win;
      this.win = null;
      w.destroy();
    }
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      title: "快手登录（监控采集用）",
      webPreferences: {
        partition: COLLECT_PARTITION,
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });
    // 点 X 只是隐藏（登录态与窗口都保留）；程序退出时 dispose() 才会真正销毁
    win.on("close", (e) => {
      if (!this.disposed) {
        e.preventDefault();
        win.hide();
      }
    });
    this.win = win;
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
    if (!(await this.checkBrowserLogin())) {
      throw new FetcherError("login_expired", "浏览器里还没登录快手，请在设置页打开快手登录窗口登录");
    }
    const profileUrl = (account.home_url ?? "").trim();
    if (!profileUrl) {
      throw new FetcherError("other", "账号未配置主页链接，浏览器采集无法打开主页");
    }
    const win = this.ensureWindow();
    // 1. 暖机加载：debugger 在首次导航前挂接会挂起约 30 秒（P2 实测坑），须先加载一次
    try {
      await this.loadWithTimeout(win, profileUrl, PAGE_LOAD_TIMEOUT_MS);
    } catch (e) {
      throw new FetcherError("network", `主页加载失败：${e instanceof Error ? e.message : String(e)}`);
    }
    // 2. 布防截获 → 挂 debugger → 再次导航触发请求
    const armed = this.armCapture(win);
    void armed.promise.catch(() => undefined); // 提前认领 rejection，防中途 abort 造成未处理 rejection
    try {
      await this.attachDebugger(win);
      try {
        await this.loadWithTimeout(win, profileUrl, PAGE_LOAD_TIMEOUT_MS);
      } catch {
        // 导航失败不立即报错：已布防的截获可能已拿到数据，交给截获超时兜底
      }
      const { body, source } = await armed.promise;
      await this.persistCapture(account.account_id, profileUrl, body, source);
      const works = parseFeedResponse(body);
      this.lastCaptureAt = Date.now();
      // 置顶字段无证据：has_pinned_field=false，整批走 needs_review 不入库（P5/R4）
      return { works, has_pinned_field: false };
    } catch (e) {
      armed.abort(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  /**
   * 布防截获：监听 debugger 的 Network 事件（主路）+ preload 转发的捕获（补充），
   * 先到先得；超时未捕获则失败。收尾时拆监听、清 sink、detach debugger。
   */
  private armCapture(win: BrowserWindow): {
    promise: Promise<{ body: string; source: string }>;
    abort: (err: Error) => void;
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
            if (response && typeof response.url === "string" && response.url.includes(FEED_PATH) && requestId) {
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
        if (this.captureSink === sink) this.captureSink = null;
        try {
          if (dbg.isAttached()) dbg.detach();
        } catch {
          // 忽略
        }
        if (err) reject(err);
        else if (value) resolve(value);
      };
      const sink = (body: string, source: string) => finish({ body, source });
      this.captureSink = sink;
      dbg.on("message", onMessage);
    });
    return { promise, abort: (err: Error) => finish(null, err) };
  }

  /**
   * 截获存档（取证用）：原始返回 + 字段清单写 <数据目录>/captures/，供人工判定
   * 哪个字段是置顶标记；每账号只留最近 5 份。存档失败只记日志，不影响本次采集。
   */
  private async persistCapture(accountId: string, url: string, body: string, source: string): Promise<void> {
    try {
      const dir = path.join(this.dataDir, "captures");
      await fs.mkdir(dir, { recursive: true });
      const safe = accountId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "account";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `feed-${safe}-${stamp}.json`);
      let inventory: unknown = null;
      try {
        inventory = collectFieldInventory(JSON.parse(body));
      } catch {
        inventory = null;
      }
      const payload = {
        captured_at: Date.now(),
        account_id: accountId,
        url,
        source,
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
