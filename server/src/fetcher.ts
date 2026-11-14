// 采集器接口：平台取数与媒体下载的可替换边界。
// 生产快手采集器尚未实现（待用户经安全通道提供登录态后，另行研究平台接口并实现）；
// 当前默认实现只抛错，绝不访问真实平台接口。MOCK_FETCHER=1 时启用 mock 采集器（假数据，
// 不出本地），供 e2e 验证采集流程。mock 场景由账号的平台账号ID（account_id）选择。

export type ErrorCode = "login_expired" | "captcha" | "rate_limit" | "banned" | "deleted" | "network" | "other";

/** 带分类码的采集错误：分类落库（设计 S6），message 须已脱敏（不含登录态原文）。 */
export class FetcherError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 不可重试的分类：重试无用，等人工处理（设计第六节）。 */
export const NON_RETRYABLE: ReadonlySet<ErrorCode> = new Set(["login_expired", "captcha", "banned"]);

export function classifyError(e: unknown): { code: ErrorCode; message: string } {
  if (e instanceof FetcherError) return { code: e.code, message: e.message };
  if (e instanceof Error) {
    if (e.name === "AbortError" || /timed out|timeout/i.test(e.message)) {
      return { code: "network", message: "请求超时" };
    }
    return { code: "other", message: e.message.slice(0, 300) };
  }
  return { code: "other", message: String(e).slice(0, 300) };
}

export interface FetchedWork {
  work_id: string;
  title: string;
  topics: string[];
  cover_url: string;
  video_url: string;
  origin_url: string;
  published_at: number;
  likes: number;
  /** 置顶标记。字段缺失（undefined）时，采集引擎标记“待人工核对”且不入库（R3）。 */
  is_pinned?: boolean;
}

export interface FetchResult {
  works: FetchedWork[];
  /** 平台返回是否带置顶字段。false 时整批不入库、任务标 needs_review。 */
  has_pinned_field: boolean;
}

export interface MediaBytes {
  bytes: ArrayBuffer;
  contentType: string;
}

export interface PlatformFetcher {
  fetchWorks(
    account: { platform: string; account_id: string; name: string; home_url?: string },
    loginState: string,
  ): Promise<FetchResult>;
  download(url: string): Promise<MediaBytes>;
  /** 浏览器采集器为 true：登录态在浏览器分区 cookie 里，不走 login_state_enc 解密门。 */
  readonly usesBrowserLogin?: boolean;
  /** 浏览器采集器：分区内是否存在平台 cookie（登录状态启发式判断）。 */
  checkBrowserLogin?(): Promise<boolean>;
}

/** 生产占位采集器：未实现，抛错；绝不访问真实平台接口。 */
export const unimplementedFetcher: PlatformFetcher = {
  async fetchWorks(): Promise<FetchResult> {
    throw new FetcherError("other", "快手采集器尚未实现（需平台接口研究与登录态接入，见 README 未决问题）");
  },
  async download(): Promise<MediaBytes> {
    throw new FetcherError("other", "快手采集器尚未实现");
  },
};

// ---- mock 采集器（仅 MOCK_FETCHER=1，假数据，不出本地） ----

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function mockWorks(scenario: string, now: number): FetchResult {
  // 发布时间：每条间隔 1 小时，w1 最新。点赞数与发布时间顺序不同（供排序测试）。
  const mk = (n: number, likes: number, pinned: boolean | undefined, prefix: string): FetchedWork => ({
    work_id: `${prefix}_w${n}`,
    title: `测试作品${n} 标题含中文`,
    topics: [`话题${n}`, "搞笑"],
    cover_url: `mock://media/cover/${prefix}_w${n}.jpg`,
    video_url: `mock://media/video/${prefix}_w${n}.mp4`,
    origin_url: `https://www.kuaishou.com/short-video/${prefix}_w${n}`,
    published_at: now - n * 3600 * 1000,
    likes,
    is_pinned: pinned,
  });
  switch (scenario) {
    case "normal":
      // 7 条：最新 1 条置顶 + 6 条普通 → 应入库 5 条，置顶排除、第 6 新补位
      return {
        has_pinned_field: true,
        works: [
          mk(0, 9999, true, "normal"),
          mk(1, 100, false, "normal"),
          mk(2, 500, false, "normal"),
          mk(3, 200, false, "normal"),
          mk(4, 900, false, "normal"),
          mk(5, 50, false, "normal"),
          mk(6, 300, false, "normal"),
        ],
      };
    case "few":
      return { has_pinned_field: true, works: [mk(1, 10, false, "few"), mk(2, 20, false, "few")] };
    case "empty":
      return { has_pinned_field: true, works: [] };
    case "no_pinned_field": {
      // 置顶字段缺失：is_pinned 一律 undefined，has_pinned_field=false
      const w = [mk(1, 10, undefined, "npf"), mk(2, 20, undefined, "npf"), mk(3, 30, undefined, "npf")];
      for (const x of w) delete x.is_pinned;
      return { has_pinned_field: false, works: w };
    }
    case "download_fail": {
      const w1 = mk(1, 10, false, "df");
      const w2 = mk(2, 20, false, "df");
      const w3 = mk(3, 30, false, "df");
      w2.video_url = "mock://media/deleted/df_w2.mp4"; // 该条视频下载报 deleted
      return { has_pinned_field: true, works: [w1, w2, w3] };
    }
    default: {
      // 通用场景：前缀取场景名（仅字母数字下划线），5 条普通作品；不同场景互不干扰
      const prefix = scenario.replace(/[^a-z0-9_]/gi, "_").slice(0, 20) || "def";
      return {
        has_pinned_field: true,
        works: [mk(1, 10, false, prefix), mk(2, 20, false, prefix), mk(3, 30, false, prefix), mk(4, 40, false, prefix), mk(5, 50, false, prefix)],
      };
    }
  }
}

const ERROR_SCENARIOS: Record<string, { code: ErrorCode; message: string }> = {
  login_expired: { code: "login_expired", message: "登录态已失效（mock）" },
  captcha: { code: "captcha", message: "触发验证码（mock）" },
  banned: { code: "banned", message: "账号受限（mock）" },
  rate_limit: { code: "rate_limit", message: "平台限流（mock）" },
  network: { code: "network", message: "网络失败（mock）" },
};

export const mockFetcher: PlatformFetcher = {
  async fetchWorks(account): Promise<FetchResult> {
    const id = account.account_id;
    const scenario = id.startsWith("mock:") ? id.slice("mock:".length) : "default";
    const errScenario = ERROR_SCENARIOS[scenario];
    if (errScenario) throw new FetcherError(errScenario.code, errScenario.message);
    return mockWorks(scenario, Date.now());
  },
  async download(url: string): Promise<MediaBytes> {
    if (!url.startsWith("mock://media/")) {
      throw new FetcherError("network", "mock 模式不访问真实网络");
    }
    if (url.includes("/deleted/")) {
      throw new FetcherError("deleted", "作品已删除（mock）");
    }
    const size = 1024 + (hashStr(url) % 4096);
    const seed = `FAKE-MEDIA:${url}:`;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = seed.charCodeAt(i % seed.length) & 0xff;
    const contentType = url.includes("/cover/") ? "image/jpeg" : "video/mp4";
    return { bytes: bytes.buffer as ArrayBuffer, contentType };
  },
};

/**
 * 按环境选择采集器：MOCK_FETCHER=1 用 mock；Electron 注入了浏览器采集器则用它；
 * 否则用未实现占位（抛错，不访问真实接口）。CLI/无 Electron 环境永远走不到浏览器分支，
 * 绝不静默降级。
 */
export function selectFetcher(env: { MOCK_FETCHER?: string; BROWSER_FETCHER?: PlatformFetcher }): PlatformFetcher {
  if (env.MOCK_FETCHER === "1") return mockFetcher;
  if (env.BROWSER_FETCHER) return env.BROWSER_FETCHER;
  return unimplementedFetcher;
}
