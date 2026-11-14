// 浏览器采集探针式验证 harness（在 Electron 主进程里跑，由 test/browser-collect-verify.mjs 打包拉起）。
// 只连本地测试 HTTP 服务（127.0.0.1），绝不访问快手、不登录快手。
// 环境变量：BC_VERIFY_DIR（数据目录）、BC_VERIFY_PORT（测试服务端口）。

import { app, BrowserWindow, ipcMain, session } from "electron";
import * as http from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { BrowserCollector, COLLECT_PARTITION } from "../electron/browser-collect";
import { collectFieldInventory, parseFeedResponse } from "../electron/feed-map";
import { FetcherError } from "../server/src/fetcher";
import { startLocalServer } from "../server/src/server";

app.commandLine.appendSwitch("no-sandbox");
const DATA_DIR = process.env.BC_VERIFY_DIR || "/tmp/bc-verify-data";
const PORT = Number(process.env.BC_VERIFY_PORT || 17899);
const PRELOAD_PATH = process.env.BC_VERIFY_PRELOAD || "";
app.setPath("userData", path.join(DATA_DIR, "userdata"));

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}

const FEED_BODY = JSON.stringify({
  result: 1,
  feeds: [
    {
      photo: {
        id: "verify_w1",
        caption: "验证作品一",
        likeCount: 123,
        timestamp: 1790000000000,
        coverUrl: "http://127.0.0.1:PORT/cover1.jpg",
        photoUrls: [{ url: "http://127.0.0.1:PORT/low1.mp4" }, { url: "http://127.0.0.1:PORT/high1.mp4" }],
        duration: 30000,
        viewCount: 999,
      },
      tags: [{ name: "话题甲" }, { name: "话题乙" }],
      extra_marker: "FIELD-INVENTORY-CHECK",
    },
    {
      photo: {
        id: "verify_w2",
        caption: "验证作品二",
        likeCount: 45,
        timestamp: 1790000001000,
        coverUrl: "http://127.0.0.1:PORT/cover2.jpg",
        photoUrls: [{ url: "http://127.0.0.1:PORT/only2.mp4" }],
      },
      tags: [{ name: "话题丙" }],
    },
    { photo: { caption: "没有 ID 的条目", likeCount: 1 }, tags: [] },
    {
      photo: {
        id: "verify_w4",
        caption: "空播放地址",
        likeCount: 7,
        timestamp: 1790000002000,
        coverUrl: "http://127.0.0.1:PORT/cover4.jpg",
        photoUrls: [],
      },
      tags: [],
    },
    {
      photo: {
        id: "verify_w5",
        caption: "秒级时间戳",
        likeCount: 8,
        timestamp: 1790000003,
        coverUrl: "http://127.0.0.1:PORT/cover5.jpg",
        photoUrls: [{ url: "http://127.0.0.1:PORT/w5.mp4" }],
      },
    },
    {
      photo: {
        id: "verify_w6",
        likeCount: 9,
        timestamp: 1790000003000,
        coverUrl: "http://127.0.0.1:PORT/cover6.jpg",
        photoUrls: [{ url: "http://127.0.0.1:PORT/w6.mp4" }],
      },
      tags: [{ name: "话题丁" }],
    },
    {
      photo: {
        id: "verify_w7",
        caption: "无话题",
        likeCount: 10,
        timestamp: 1790000004000,
        coverUrl: "http://127.0.0.1:PORT/cover7.jpg",
        photoUrls: [{ url: "http://127.0.0.1:PORT/w7.mp4" }],
      },
    },
  ],
}).replace(/PORT/g, String(PORT));

const PROFILE_HTML = `<html><head><title>verify profile</title></head><body>
<script>
window.__trapCheck = "unset";
try {
  var signer = { $encode: function(){}, $getCatVersion: function(){}, call: function(){} };
  var holder = {};
  holder.encrypter = signer;
  window.__trapCheck = (holder.encrypter === signer) ? "writeback-ok" : "writeback-broken";
} catch (e) { window.__trapCheck = "error:" + e.message; }
var xhr = new XMLHttpRequest();
xhr.open("POST", "/rest/v/profile/feed", true);
xhr.setRequestHeader("Content-Type", "application/json");
xhr.send(JSON.stringify({ page: "profile", pcursor: "", user_id: "3x000000000000001" }));
fetch("/rest/v/profile/feed", { method: "POST", headers: {"Content-Type": "application/json"}, body: "{}" }).catch(function(){});
</script>
</body></html>`;

const LOGIN_HTML = `<html><head><title>verify login</title></head><body>login page</body></html>`;

function startTestServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url === "/profile-page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PROFILE_HTML);
    } else if (url === "/login-page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LOGIN_HTML);
    } else if (url === "/rest/v/profile/feed") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(FEED_BODY);
    } else if (url === "/media/video.mp4") {
      const cookie = req.headers.cookie || "";
      if (!cookie.includes("verify_cookie=media-ok")) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("need cookie");
        return;
      }
      const body = Buffer.from("FAKE-VIDEO-BYTES-0123456789", "utf8");
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(body.length) });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

function expectFetcherError(name: string, fn: () => unknown, code: string): void {
  try {
    fn();
    check(name, false, "未抛错");
  } catch (e) {
    check(name, e instanceof FetcherError && e.code === code, e instanceof Error ? `${e.constructor.name}:${(e as FetcherError).code}:${e.message}` : String(e));
  }
}

async function main(): Promise<void> {
  await app.whenReady();
  const server = await startTestServer();
  const base = `http://127.0.0.1:${PORT}`;

  // ---- U: 纯映射单测 ----
  const works = parseFeedResponse(FEED_BODY);
  check("U1 映射条数（无 ID 条目跳过）", works.length === 6, `got ${works.length}`);
  const w1 = works.find((w) => w.work_id === "verify_w1");
  check(
    "U2 w1 字段映射全对",
    !!w1 &&
      w1.title === "验证作品一" &&
      w1.topics.join(",") === "话题甲,话题乙" &&
      w1.likes === 123 &&
      w1.published_at === 1790000000000 &&
      w1.cover_url === `${base}/cover1.jpg` &&
      w1.video_url === `${base}/high1.mp4` &&
      w1.origin_url === "https://www.kuaishou.com/short-video/verify_w1",
    JSON.stringify(w1),
  );
  const w4 = works.find((w) => w.work_id === "verify_w4");
  check("U3 空播放地址映射为空串", !!w4 && w4.video_url === "", JSON.stringify(w4));
  const w5 = works.find((w) => w.work_id === "verify_w5");
  check("U4 秒级时间戳换算成毫秒", !!w5 && w5.published_at === 1790000003000, JSON.stringify(w5));
  const w6 = works.find((w) => w.work_id === "verify_w6");
  check("U5 缺 caption 映射为空标题", !!w6 && w6.title === "", JSON.stringify(w6));
  const w7 = works.find((w) => w.work_id === "verify_w7");
  check("U6 缺 tags 映射为空数组", !!w7 && Array.isArray(w7.topics) && w7.topics.length === 0, JSON.stringify(w7));
  check("U7 所有作品 is_pinned 均未填", works.every((w) => w.is_pinned === undefined));
  expectFetcherError("U8 result 400002 → captcha", () => parseFeedResponse(JSON.stringify({ result: 400002 })), "captcha");
  expectFetcherError("U9 errors 含 Need captcha → captcha", () => parseFeedResponse(JSON.stringify({ result: 0, errors: ["Need captcha"] })), "captcha");
  expectFetcherError("U10 result 2056 → login_expired", () => parseFeedResponse(JSON.stringify({ result: 2056 })), "login_expired");
  expectFetcherError("U11 带 loginUrl → login_expired", () => parseFeedResponse(JSON.stringify({ result: 0, loginUrl: "https://x/" })), "login_expired");
  expectFetcherError("U12 result 7935 → other", () => parseFeedResponse(JSON.stringify({ result: 7935 })), "other");
  expectFetcherError("U13 非法 JSON → other", () => parseFeedResponse("not json{"), "other");
  expectFetcherError("U14 result 非 1 → other", () => parseFeedResponse(JSON.stringify({ result: 500 })), "other");
  const inv = collectFieldInventory(JSON.parse(FEED_BODY));
  check(
    "U15 字段清单含 photo/tags 键",
    inv.feed_count === 7 && inv.photo_keys.includes("id") && inv.photo_keys.includes("coverUrl") && inv.tag_keys.includes("name") && inv.feed_keys.includes("extra_marker"),
    JSON.stringify(inv),
  );

  // ---- B: 浏览器采集端到端 ----
  const ipcEvents: Array<Record<string, unknown>> = [];
  ipcMain.on("monitor-collect-event", (_e, detail) => {
    ipcEvents.push(detail as Record<string, unknown>);
  });
  const collector = new BrowserCollector({
    dataDir: DATA_DIR,
    loginUrl: `${base}/login-page`,
    preloadPath: PRELOAD_PATH,
    captureTimeoutMs: 30_000,
  });

  check("B1 未放 cookie 前查登录为 false", (await collector.checkBrowserLogin()) === false);
  const ses = session.fromPartition(COLLECT_PARTITION);
  await ses.cookies.set({
    url: "https://www.kuaishou.com",
    name: "verify_login",
    value: "local-only",
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
  });
  check("B2 放 cookie 后查登录为 true", (await collector.checkBrowserLogin()) === true);

  const account = { platform: "kuaishou", account_id: "verify_acct", name: "验证账号", home_url: `${base}/profile-page` };
  let result;
  try {
    result = await collector.fetchWorks(account, "");
  } catch (e) {
    check("B3 fetchWorks 成功", false, e instanceof Error ? e.message : String(e));
    result = null;
  }
  if (result) {
    check("B3 fetchWorks 成功且 6 条", result.works.length === 6, `got ${result.works.length}`);
    check("B4 has_pinned_field=false（置顶无证据）", result.has_pinned_field === false);
    check("B5 作品 is_pinned 均未填", result.works.every((w) => w.is_pinned === undefined));
    const rw1 = result.works.find((w) => w.work_id === "verify_w1");
    check("B6 端到端映射与单测一致", !!rw1 && rw1.video_url === `${base}/high1.mp4` && rw1.topics.join(",") === "话题甲,话题乙", JSON.stringify(rw1));
  }
  const status = await collector.getStatus();
  check("B7 截获后 lastCaptureAt 已记", typeof status.lastCaptureAt === "number" && status.lastCaptureAt > 0, JSON.stringify(status));

  // 截获存档
  const capDir = path.join(DATA_DIR, "captures");
  let capFiles: string[] = [];
  try {
    capFiles = (await fs.readdir(capDir)).filter((n) => n.startsWith("feed-verify_acct-"));
  } catch {
    capFiles = [];
  }
  check("B8 截获存档已写", capFiles.length >= 1, capFiles.join(","));
  if (capFiles.length > 0) {
    const payload = JSON.parse(await fs.readFile(path.join(capDir, capFiles[0]), "utf8")) as Record<string, unknown>;
    const inventory = payload.field_inventory as { photo_keys?: string[] } | null;
    check(
      "B9 存档含字段清单与原始正文",
      !!inventory && Array.isArray(inventory.photo_keys) && inventory.photo_keys.includes("id") && typeof payload.raw === "string" && payload.raw.includes("verify_w1"),
      JSON.stringify(Object.keys(payload)),
    );
  }

  // preload 注入与陷阱：从采集窗口里读状态（harness 只建这一个窗口；页面标题会覆盖窗口标题，不能按标题找）
  const wins = BrowserWindow.getAllWindows();
  const collectWin = wins[0];
  check("B10 采集窗口存在", !!collectWin);
  if (collectWin) {
    const diag = (await collectWin.webContents.executeJavaScript(
      `({ installed: !!window.__monitorCollectInstalled, signer: !!window.__monitorSignerCaptured, trap: window.__trapCheck || null, preloadFlag: document.documentElement.getAttribute("data-monitor-preload-ran") })`,
    )) as Record<string, unknown>;
    check("B11 preload 已注入主世界", diag.installed === true && diag.preloadFlag === "1", JSON.stringify(diag));
    check("B12 签名器陷阱触发且写回不破坏页面", diag.signer === true && diag.trap === "writeback-ok", JSON.stringify(diag));
  }
  check("B13 preload 捕获事件经 IPC 到达主进程", ipcEvents.some((d) => d.type === "feed-capture"), `events: ${ipcEvents.map((d) => String(d.type)).join(",")}`);
  check("B14 签名器捕获事件经 IPC 到达主进程", ipcEvents.some((d) => d.type === "signer-captured"));

  // 第二次采集：debugger 拆挂重挂后仍能工作
  try {
    const result2 = await collector.fetchWorks(account, "");
    check("B15 第二次采集仍成功", result2.works.length === 6 && result2.has_pinned_field === false);
  } catch (e) {
    check("B15 第二次采集仍成功", false, e instanceof Error ? e.message : String(e));
  }

  // 带 cookie 下载
  await ses.cookies.set({ url: `${base}/media/video.mp4`, name: "verify_cookie", value: "media-ok", expirationDate: Math.floor(Date.now() / 1000) + 3600 });
  try {
    const media = await collector.download(`${base}/media/video.mp4`);
    const text = Buffer.from(media.bytes).toString("utf8");
    check("B16 带分区 cookie 下载成功", text === "FAKE-VIDEO-BYTES-0123456789" && media.contentType === "video/mp4", `${text.slice(0, 40)} / ${media.contentType}`);
  } catch (e) {
    check("B16 带分区 cookie 下载成功", false, e instanceof Error ? e.message : String(e));
  }

  // 登录窗口显示/隐藏
  await collector.showLoginWindow();
  const loginWin = BrowserWindow.getAllWindows()[0];
  check("B17 登录窗口已显示", !!loginWin && loginWin.isVisible());
  if (loginWin) {
    loginWin.close();
    await new Promise((r) => setTimeout(r, 500));
    check("B18 点 X 后窗口隐藏而非销毁", !loginWin.isVisible() && !loginWin.isDestroyed());
    await collector.showLoginWindow();
    check("B19 再次打开登录窗口仍显示", loginWin.isVisible());
  }

  // 无主页链接 → 明确报错
  try {
    await collector.fetchWorks({ platform: "kuaishou", account_id: "no_home", name: "无主页" }, "");
    check("B20 无主页链接明确报错", false, "未抛错");
  } catch (e) {
    check("B20 无主页链接明确报错", e instanceof FetcherError && e.code === "other" && /主页链接/.test(e.message), e instanceof Error ? e.message : String(e));
  }

  // ---- E: 采集引擎全链路（HTTP → 任务 → 浏览器采集器 → needs_review 不入库） ----
  process.env.MONITOR_TEST_MODE = "1";
  delete process.env.MONITOR_MOCK_FETCHER;
  if (process.env.BC_VERIFY_MIGRATIONS) process.env.MONITOR_MIGRATIONS_DIR = process.env.BC_VERIFY_MIGRATIONS;
  if (process.env.BC_VERIFY_RENDERER) process.env.MONITOR_RENDERER_DIR = process.env.BC_VERIFY_RENDERER;
  const running = await startLocalServer({ dataDir: path.join(DATA_DIR, "server"), port: 17893, noScheduler: true });
  running.env.BROWSER_FETCHER = collector;
  running.env.BROWSER_CONTROL = collector;
  const API = "http://127.0.0.1:17893/api/v1";
  async function api(method: string, p: string, body?: unknown, token?: string): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await fetch(API + p, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }
  try {
    const setup = await api("POST", "/auth/setup", { password: "e2e-chain-pass-123" });
    const e2eToken = setup.data.token as string;
    check("E1 服务内 setup 成功", setup.status === 200 && typeof e2eToken === "string");
    const created = await api("POST", "/accounts", { platform: "kuaishou", name: "链路账号", home_url: `${base}/profile-page`, account_id: "e2e_chain", remark: null }, e2eToken);
    const accId = (created.data.account as Record<string, unknown> | undefined)?.id as number;
    check("E2 服务内建账号成功", (created.status === 200 || created.status === 201) && typeof accId === "number");
    // 注意：故意不配置 login_state_enc，验证浏览器模式跳过解密门
    const trig = await api("POST", "/tasks/trigger", { account_id: accId }, e2eToken);
    check("E3 触发采集建任务", trig.status === 200, JSON.stringify(trig.data));
    const cron = await api("POST", "/_test/run-cron", { cron: "* * * * *" }, e2eToken);
    check("E4 驱动 cron 处理任务", cron.status === 200 && cron.data.claimed === 1, JSON.stringify(cron.data));
    const tasks = await api("GET", "/tasks?page=1&page_size=5", undefined, e2eToken);
    const list = tasks.data.tasks as Array<Record<string, unknown>>;
    const task = list[0];
    check("E5 任务因无置顶字段标 needs_review", !!task && task.status === "failed" && task.needs_review === true, JSON.stringify(task));
    check("E6 失败原因说清置顶字段", !!task && typeof task.error_message === "string" && task.error_message.includes("置顶字段"), JSON.stringify(task?.error_message));
    const worksList = await api("GET", "/works?page=1&page_size=5", undefined, e2eToken);
    check("E7 整批未入库（作品库为空）", worksList.data.total === 0, JSON.stringify(worksList.data));
    const chainCaps = (await fs.readdir(capDir)).filter((n) => n.startsWith("feed-e2e_chain-"));
    check("E8 链路截获已存档", chainCaps.length >= 1, chainCaps.join(","));
  } finally {
    await running.close();
  }

  collector.dispose();
  server.close();
  console.log(`\n== 结果：通过 ${passed}，失败 ${failed} ==`);
  app.exit(failed === 0 ? 0 : 1);
}

setTimeout(() => {
  console.log("HARNESS TIMEOUT");
  app.exit(2);
}, 120_000);

main().catch((e: unknown) => {
  console.error("HARNESS ERROR", e);
  app.exit(2);
});
