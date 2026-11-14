// 浏览器采集探针式验证 harness（在 Electron 主进程里跑，由 test/browser-collect-verify.mjs 打包拉起）。
// 只连本地测试 HTTP 服务（127.0.0.1），绝不访问快手、不登录快手。
// 环境变量：BC_VERIFY_DIR（数据目录）、BC_VERIFY_PORT（测试服务端口）。

import { app, BrowserWindow, ipcMain, session } from "electron";
import * as http from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { BrowserCollector, COLLECT_PARTITION, DOUYIN_PARTITION, XIAOHONGSHU_PARTITION, browserUserAgent, configForPlatform } from "../electron/browser-collect";
import { collectFieldInventory, parseFeedResponse } from "../electron/feed-map";
import { collectDouyinFieldInventory, parseDouyinResponse } from "../electron/feed-map-douyin";
import { collectXiaohongshuFieldInventory, parseXiaohongshuResponse } from "../electron/feed-map-xiaohongshu";
import { FetcherError } from "../server/src/fetcher";
import { startLocalServer } from "../server/src/server";

app.commandLine.appendSwitch("no-sandbox");
const DATA_DIR = process.env.BC_VERIFY_DIR || "/tmp/bc-verify-data";
const PORT = Number(process.env.BC_VERIFY_PORT || 17899);
const PRELOAD_PATH = process.env.BC_VERIFY_PRELOAD || "";
app.setPath("userData", path.join(DATA_DIR, "userdata"));

let passed = 0;
let failed = 0;
/** 媒体下载请求实际带上的 UA（测试服务在 /media/video.mp4 分支记录，供 A6 断言）。 */
let lastMediaUa = "";
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

// ---- 两平台 mapper 夹具（形状只用探针报告里有扩展代码证据的字段；夹具源自扩展代码分析，非真实截获） ----
const DOUYIN_BODY = JSON.stringify({
  aweme_list: [
    {
      aweme_id: "dy_w1",
      desc: "抖音作品一",
      media_type: 0,
      create_time: 1790000003,
      text_extra: [
        { hashtag_name: "话题甲", type: 1 },
        { hashtag_name: "不是话题", type: 0 },
        { hashtag_name: "", type: 1 },
      ],
      statistics: { digg_count: 321, play_count: 1000, comment_count: 5 },
      video: {
        duration: 15000,
        raw_cover: { url_list: [] },
        cover: { url_list: ["http://127.0.0.1:PORT/dy_cover1.jpg"] },
        origin_cover: { url_list: ["http://127.0.0.1:PORT/dy_origin.jpg"] },
        play_addr: {
          url_list: [
            "https://v26-web.douyinvod.com/skip1.mp4",
            "https://x-webf.douyinvod.com/skip2.mp4",
            "http://127.0.0.1:PORT/dy_high1.mp4",
          ],
          uri: "v123",
          data_size: 1234,
        },
      },
    },
    {
      aweme_id: "dy_w2",
      desc: "只有 uri 回退",
      create_time: 1790000004,
      statistics: { digg_count: 10 },
      video: {
        cover: { url_list: ["http://127.0.0.1:PORT/dy_cover2.jpg"] },
        play_addr: { url_list: ["https://v26-web.douyinvod.com/only.mp4"], uri: "v999" },
      },
    },
    {
      aweme_id: "dy_g1",
      desc: "图文作品",
      media_type: 2,
      create_time: 1790000005,
      statistics: { digg_count: 1 },
      images: [{ url_list: ["http://127.0.0.1:PORT/img1.jpeg"] }],
    },
    { aweme_id: "dy_g2", desc: "图文作品42", media_type: 42, create_time: 1790000006, statistics: { digg_count: 2 } },
    { desc: "没有 ID 的条目", statistics: { digg_count: 1 } },
    { aweme_id: "dy_w3", create_time: 1790000007, statistics: {}, video: {} },
  ],
  max_cursor: 12345,
  has_more: true,
}).replace(/PORT/g, String(PORT));

const XHS_BODY = JSON.stringify({
  success: true,
  code: 1000,
  msg: "ok",
  data: {
    notes: [
      {
        note_id: "xhs_n1",
        display_title: "小红书笔记一",
        type: "video",
        time: 1790000000000,
        interact_info: { liked_count: 55, collected_count: 3, comment_count: 2, share_count: 1, sticky: true },
        image_list: [{ url: "http://127.0.0.1:PORT/xhs_cover1.jpg", url_default: "http://127.0.0.1:PORT/xhs_cover1d.jpg" }],
        video: { consumer: { origin_video_key: "key-abc-123" } },
        user: { user_id: "24charuserid1234567890", nickname: "博主", xsec_token: "tok123", xsec_source: "pc_user" },
      },
      {
        note_id: "xhs_n2",
        display_title: "清晰度表笔记",
        type: "video",
        time: 1790000001000,
        interact_info: { liked_count: 10, sticky: false },
        image_list: [{ url_default: "http://127.0.0.1:PORT/xhs_cover2.jpg" }],
        video: {
          media: {
            stream: {
              h264: [
                { master_url: "http://127.0.0.1:PORT/xhs_720.mp4", width: 720, height: 1280, format: "mp4", size: 100, audio_bitrate: 128 },
                { master_url: "http://127.0.0.1:PORT/xhs_1080.mp4", width: 1080, height: 1920, format: "mp4", size: 200, audio_bitrate: 128 },
                { master_url: "http://127.0.0.1:PORT/xhs_wm.mp4", width: 1080, height: 1920, format: "mp4", size: 300, stream_desc: "WM_test", audio_bitrate: 128 },
              ],
            },
          },
        },
      },
      {
        note_id: "xhs_g1",
        display_title: "图文笔记",
        type: "image",
        time: 1790000002000,
        interact_info: { liked_count: 1 },
        image_list: [{ url: "http://127.0.0.1:PORT/xhs_img.jpg" }],
      },
      {
        note_id: "xhs_n3",
        title: "只有 title 字段",
        time: 1790000003000,
        interact_info: { liked_count: 7 },
        image_list: [],
        video: {},
      },
    ],
  },
}).replace(/PORT/g, String(PORT));

// SSR 补充捕获夹具：单条有效笔记（形状同 user_posted 的 note 对象）
const XHS_SSR_NOTE = {
  note_id: "xhs_ssr1",
  display_title: "SSR 笔记",
  type: "video",
  time: 1790000005000,
  interact_info: { liked_count: 42, sticky: false },
  image_list: [{ url: "http://127.0.0.1:PORT/xhs_ssr_cover.jpg" }],
  video: { consumer: { origin_video_key: "ssr-key-1" } },
};

const DOUYIN_PROFILE_HTML = `<html><head><title>douyin profile</title></head><body>
<script>
fetch("/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAAtest").catch(function(){});
var xhr = new XMLHttpRequest();
xhr.open("GET", "/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAAtest", true);
xhr.send();
</script>
</body></html>`;

const XHS_PROFILE_HTML = `<html><head><title>xhs profile</title></head><body>
<script>
fetch("/api/sns/web/v1/user_posted?user_id=24charuserid1234567890").catch(function(){});
</script>
</body></html>`;

const XHS_SSR_HTML = `<html><head><title>xhs ssr profile</title></head><body>
<script>
window.__INITIAL_STATE__ = { user: { notes: { _rawValue: [[${JSON.stringify(XHS_SSR_NOTE).replace(/PORT/g, String(PORT))}]] } } };
</script>
</body></html>`;

function startTestServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url === "/media/video.mp4") lastMediaUa = req.headers["user-agent"] || "";
    if (url === "/profile-page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PROFILE_HTML);
    } else if (url === "/login-page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LOGIN_HTML);
    } else if (url === "/douyin-profile") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DOUYIN_PROFILE_HTML);
    } else if (url === "/xhs-profile") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(XHS_PROFILE_HTML);
    } else if (url.startsWith("/xhs-ssr-profile")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(XHS_SSR_HTML);
    } else if (url === "/rest/v/profile/feed") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(FEED_BODY);
    } else if (url.startsWith("/aweme/v1/web/aweme/post")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(DOUYIN_BODY);
    } else if (url.startsWith("/api/sns/web/v1/user_posted")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(XHS_BODY);
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

  // ---- D: 抖音映射单测（夹具源自扩展代码，非真实截获） ----
  const dyParsed = parseDouyinResponse(DOUYIN_BODY);
  check("D1 抖音映射条数（图文跳过、无 ID 跳过）", dyParsed.works.length === 3, `got ${dyParsed.works.length}`);
  check("D2 抖音图文跳过 2 条", dyParsed.skippedCount === 2, `got ${dyParsed.skippedCount}`);
  const dy1 = dyParsed.works.find((w) => w.work_id === "dy_w1");
  check(
    "D3 dy_w1 字段映射全对",
    !!dy1 &&
      dy1.title === "抖音作品一" &&
      dy1.topics.join(",") === "话题甲" &&
      dy1.likes === 321 &&
      dy1.published_at === 1790000003000 &&
      dy1.cover_url === `${base}/dy_cover1.jpg` &&
      dy1.video_url === `${base}/dy_high1.mp4` &&
      dy1.origin_url === "https://www.douyin.com/video/dy_w1",
    JSON.stringify(dy1),
  );
  const dy2 = dyParsed.works.find((w) => w.work_id === "dy_w2");
  check("D4 uri 回退拼播放链接", !!dy2 && dy2.video_url === "https://aweme.snssdk.com/aweme/v1/play/?video_id=v999", JSON.stringify(dy2));
  const dy3 = dyParsed.works.find((w) => w.work_id === "dy_w3");
  check("D5 缺字段映射为空/0", !!dy3 && dy3.title === "" && dy3.likes === 0 && dy3.cover_url === "" && dy3.video_url === "", JSON.stringify(dy3));
  check("D6 抖音作品 is_pinned 均未填", dyParsed.works.every((w) => w.is_pinned === undefined));
  expectFetcherError("D7 whale black_no_login → login_expired", () => parseDouyinResponse(JSON.stringify({ whaleDecisionCustom: "black_no_login", aweme_list: [] })), "login_expired");
  try {
    parseDouyinResponse(JSON.stringify({ whaleDecisionCustom: "mystery_value", aweme_list: [] }));
    check("D8 其他风控决策 → other 且记录决策值", false, "未抛错");
  } catch (e) {
    check("D8 其他风控决策 → other 且记录决策值", e instanceof FetcherError && e.code === "other" && e.message.includes("mystery_value"), e instanceof Error ? e.message : String(e));
  }
  expectFetcherError("D9 缺 aweme_list → other", () => parseDouyinResponse(JSON.stringify({ has_more: false })), "other");
  expectFetcherError("D10 非法 JSON → other", () => parseDouyinResponse("not json{"), "other");
  const dyInv = collectDouyinFieldInventory(JSON.parse(DOUYIN_BODY));
  check(
    "D11 抖音字段清单含 aweme/statistics/video 键",
    dyInv.aweme_count === 6 && dyInv.aweme_keys.includes("aweme_id") && dyInv.statistics_keys.includes("digg_count") && dyInv.video_keys.includes("play_addr"),
    JSON.stringify(dyInv),
  );
  check("D12 抖音配置 hasPinnedField=false", configForPlatform("douyin")?.hasPinnedField === false);

  // ---- X: 小红书映射单测（夹具源自扩展代码，非真实截获） ----
  const xhsParsed = parseXiaohongshuResponse(XHS_BODY);
  check("X1 小红书映射条数（图文跳过）", xhsParsed.works.length === 3, `got ${xhsParsed.works.length}`);
  check("X2 小红书图文跳过 1 条", xhsParsed.skippedCount === 1, `got ${xhsParsed.skippedCount}`);
  const xhs1 = xhsParsed.works.find((w) => w.work_id === "xhs_n1");
  check(
    "X3 xhs_n1 字段映射全对",
    !!xhs1 &&
      xhs1.title === "小红书笔记一" &&
      xhs1.topics.length === 0 &&
      xhs1.likes === 55 &&
      xhs1.published_at === 1790000000000 &&
      xhs1.cover_url === `${base}/xhs_cover1.jpg` &&
      xhs1.video_url === "https://sns-video-bd.xhscdn.com/key-abc-123" &&
      xhs1.origin_url === "https://www.xiaohongshu.com/explore/xhs_n1?xsec_token=tok123&xsec_source=pc_user" &&
      xhs1.is_pinned === true,
    JSON.stringify(xhs1),
  );
  const xhs2 = xhsParsed.works.find((w) => w.work_id === "xhs_n2");
  check(
    "X4 清晰度表取 1080P（WM 条目已排除）",
    !!xhs2 && xhs2.video_url === `${base}/xhs_1080.mp4` && xhs2.cover_url === `${base}/xhs_cover2.jpg` && xhs2.is_pinned === false,
    JSON.stringify(xhs2),
  );
  const xhs3 = xhsParsed.works.find((w) => w.work_id === "xhs_n3");
  check("X5 title 回退与缺字段", !!xhs3 && xhs3.title === "只有 title 字段" && xhs3.is_pinned === false && xhs3.video_url === "", JSON.stringify(xhs3));
  expectFetcherError(
    "X6 笔记缺 note_id → login_expired",
    () => parseXiaohongshuResponse(JSON.stringify({ success: true, code: 1000, data: { notes: [{ display_title: "无 id" }] } })),
    "login_expired",
  );
  expectFetcherError("X7 code 非 1000 → other", () => parseXiaohongshuResponse(JSON.stringify({ success: true, code: 1001, msg: "bad", data: { notes: [] } })), "other");
  expectFetcherError("X8 success false → other", () => parseXiaohongshuResponse(JSON.stringify({ success: false, msg: "fail", data: { notes: [] } })), "other");
  expectFetcherError("X9 缺 notes → other", () => parseXiaohongshuResponse(JSON.stringify({ success: true, code: 1000, data: {} })), "other");
  const xhsBare = parseXiaohongshuResponse(JSON.stringify([{ note_id: "bare1", display_title: "裸数组", type: "video", time: 1790000000000, interact_info: { liked_count: 1 } }]));
  check("X10 裸笔记数组可解析（SSR 形态）", xhsBare.works.length === 1 && xhsBare.works[0].work_id === "bare1", JSON.stringify(xhsBare));
  const xhsInv = collectXiaohongshuFieldInventory(JSON.parse(XHS_BODY));
  check(
    "X11 小红书字段清单含 sticky 与各层键",
    xhsInv.note_count === 4 && xhsInv.note_keys.includes("note_id") && xhsInv.interact_info_keys.includes("sticky") && xhsInv.video_keys.includes("consumer") && xhsInv.image_keys.includes("url"),
    JSON.stringify(xhsInv),
  );
  check("X12 小红书配置 hasPinnedField=true", configForPlatform("xiaohongshu")?.hasPinnedField === true);
  check("X13 快手配置 hasPinnedField=false", configForPlatform("kuaishou")?.hasPinnedField === false);
  check("X14 未知平台配置为空", configForPlatform("bilibili") === null);

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

  // ---- M: 多平台端到端（抖音/小红书本地页截获 + SSR 补充捕获 + 按平台状态） ----
  const dySes = session.fromPartition(DOUYIN_PARTITION);
  const xhsSes = session.fromPartition(XIAOHONGSHU_PARTITION);
  check("M1 未放 cookie 前抖音登录为 false", (await collector.checkBrowserLogin("douyin")) === false);
  check("M2 未放 cookie 前小红书登录为 false", (await collector.checkBrowserLogin("xiaohongshu")) === false);
  await dySes.cookies.set({ url: "https://www.douyin.com", name: "verify_login", value: "local-only", expirationDate: Math.floor(Date.now() / 1000) + 3600 });
  await xhsSes.cookies.set({ url: "https://www.xiaohongshu.com", name: "verify_login", value: "local-only", expirationDate: Math.floor(Date.now() / 1000) + 3600 });
  check("M3 放 cookie 后抖音登录为 true", (await collector.checkBrowserLogin("douyin")) === true);
  check("M4 放 cookie 后小红书登录为 true", (await collector.checkBrowserLogin("xiaohongshu")) === true);
  check("M5 未知平台登录恒为 false", (await collector.checkBrowserLogin("bilibili")) === false);
  const multiStatus = await collector.getStatus();
  check(
    "M6 getStatus 按平台返回三平台状态",
    multiStatus.platforms.kuaishou.loggedIn === true &&
      multiStatus.platforms.douyin.loggedIn === true &&
      multiStatus.platforms.xiaohongshu.loggedIn === true &&
      multiStatus.loggedIn === true,
    JSON.stringify(multiStatus),
  );

  const dyAccount = { platform: "douyin", account_id: "verify_dy", name: "抖音验证账号", home_url: `${base}/douyin-profile` };
  let dyResult = null as Awaited<ReturnType<typeof collector.fetchWorks>> | null;
  try {
    dyResult = await collector.fetchWorks(dyAccount, "");
  } catch (e) {
    check("M7 抖音端到端采集成功", false, e instanceof Error ? e.message : String(e));
  }
  if (dyResult) {
    check("M7 抖音端到端采集成功且 3 条", dyResult.works.length === 3, `got ${dyResult.works.length}`);
    check("M8 抖音 has_pinned_field=false", dyResult.has_pinned_field === false);
    check("M9 抖音跳过 2 条图文", dyResult.skippedCount === 2, `got ${dyResult.skippedCount}`);
    const mdy1 = dyResult.works.find((w) => w.work_id === "dy_w1");
    check("M10 抖音端到端映射与单测一致", !!mdy1 && mdy1.video_url === `${base}/dy_high1.mp4` && mdy1.topics.join(",") === "话题甲", JSON.stringify(mdy1));
  }

  const xhsAccount = { platform: "xiaohongshu", account_id: "verify_xhs", name: "小红书验证账号", home_url: `${base}/xhs-profile` };
  let xhsResult = null as Awaited<ReturnType<typeof collector.fetchWorks>> | null;
  try {
    xhsResult = await collector.fetchWorks(xhsAccount, "");
  } catch (e) {
    check("M11 小红书端到端采集成功", false, e instanceof Error ? e.message : String(e));
  }
  if (xhsResult) {
    check("M11 小红书端到端采集成功且 3 条", xhsResult.works.length === 3, `got ${xhsResult.works.length}`);
    check("M12 小红书 has_pinned_field=true", xhsResult.has_pinned_field === true);
    check("M13 小红书跳过 1 条图文", xhsResult.skippedCount === 1, `got ${xhsResult.skippedCount}`);
    const mxhs1 = xhsResult.works.find((w) => w.work_id === "xhs_n1");
    check("M14 小红书置顶笔记 is_pinned=true", !!mxhs1 && mxhs1.is_pinned === true, JSON.stringify(mxhs1));
  }
  let xhsCaps: string[] = [];
  try {
    xhsCaps = (await fs.readdir(capDir)).filter((n) => n.startsWith("feed-verify_xhs-"));
  } catch {
    xhsCaps = [];
  }
  check("M15 小红书截获存档已写", xhsCaps.length >= 1, xhsCaps.join(","));
  if (xhsCaps.length > 0) {
    const payload = JSON.parse(await fs.readFile(path.join(capDir, xhsCaps[0]), "utf8")) as Record<string, unknown>;
    const inventory = payload.field_inventory as { note_keys?: string[]; interact_info_keys?: string[] } | null;
    check(
      "M16 存档含平台与字段清单",
      payload.platform === "xiaohongshu" && !!inventory && Array.isArray(inventory.note_keys) && inventory.note_keys.includes("note_id") && Array.isArray(inventory.interact_info_keys) && inventory.interact_info_keys.includes("sticky"),
      JSON.stringify(Object.keys(payload)),
    );
  }

  // SSR 补充捕获：页面不发任何请求，只嵌 __INITIAL_STATE__；主页链接故意带 xsec 参数，验证采集时去掉
  const ssrAccount = {
    platform: "xiaohongshu",
    account_id: "verify_ssr",
    name: "SSR 验证账号",
    home_url: `${base}/xhs-ssr-profile?xsec_token=shouldbestripped&xsec_source=pc_user`,
  };
  let ssrResult = null as Awaited<ReturnType<typeof collector.fetchWorks>> | null;
  try {
    ssrResult = await collector.fetchWorks(ssrAccount, "");
  } catch (e) {
    check("M17 SSR 补充捕获成功", false, e instanceof Error ? e.message : String(e));
  }
  if (ssrResult) {
    check("M17 SSR 补充捕获成功且 1 条", ssrResult.works.length === 1 && ssrResult.works[0].work_id === "xhs_ssr1", JSON.stringify(ssrResult.works));
  }
  let ssrCaps: string[] = [];
  try {
    ssrCaps = (await fs.readdir(capDir)).filter((n) => n.startsWith("feed-verify_ssr-"));
  } catch {
    ssrCaps = [];
  }
  if (ssrCaps.length > 0) {
    const payload = JSON.parse(await fs.readFile(path.join(capDir, ssrCaps[0]), "utf8")) as Record<string, unknown>;
    check("M18 SSR 存档来源为 ssr-state", payload.source === "ssr-state", JSON.stringify(payload.source));
  } else {
    check("M18 SSR 存档来源为 ssr-state", false, "无存档");
  }
  const ssrWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(`${base}/xhs-ssr-profile`));
  check("M19 小红书导航 URL 已去掉 xsec 参数", !!ssrWin && !ssrWin.webContents.getURL().includes("xsec_token"), ssrWin?.webContents.getURL() ?? "no window");

  // 抖音登录窗口显示/隐藏（独立窗口，不影响快手窗口）
  await collector.showLoginWindow("douyin");
  const dyWins = BrowserWindow.getAllWindows().filter((w) => w.isVisible());
  check("M20 抖音登录窗口已显示", dyWins.length >= 1, `visible: ${dyWins.length}`);
  if (dyWins.length > 0) {
    dyWins[0].close();
    await new Promise((r) => setTimeout(r, 500));
    check("M21 抖音窗口点 X 后隐藏而非销毁", !dyWins[0].isVisible() && !dyWins[0].isDestroyed());
  }

  // 抖音短链拒绝
  try {
    await collector.fetchWorks({ platform: "douyin", account_id: "short", name: "短链", home_url: "https://v.douyin.com/abc123/" }, "");
    check("M22 抖音短链明确报错", false, "未抛错");
  } catch (e) {
    check("M22 抖音短链明确报错", e instanceof FetcherError && e.code === "other" && /请贴完整主页链接/.test(e.message), e instanceof Error ? e.message : String(e));
  }

  // 未知平台不静默降级
  try {
    await collector.fetchWorks({ platform: "bilibili", account_id: "unknown", name: "未知平台", home_url: `${base}/profile-page` }, "");
    check("M23 未知平台明确报错", false, "未抛错");
  } catch (e) {
    check("M23 未知平台明确报错", e instanceof FetcherError && e.code === "other" && /尚未接入/.test(e.message), e instanceof Error ? e.message : String(e));
  }

  // ---- A: 真实 UA 回归（R7）：三平台分区会话 UA 须像 Chrome、不能含 Electron ----
  // 根因：Electron 默认 UA 含 "Electron" 字样，真机上快手直接回一页 JSON，登录页打不开。
  // 三个平台的窗口到这里都已建过（B3/M7/M11），会话 UA 应已全部设置好。
  const expectedUa = browserUserAgent();
  const uaOf = (partition: string): string => session.fromPartition(partition).getUserAgent();
  const kuaishouUa = uaOf(COLLECT_PARTITION);
  const douyinUa = uaOf(DOUYIN_PARTITION);
  const xhsUa = uaOf(XIAOHONGSHU_PARTITION);
  console.log(`  UA（快手分区）: ${kuaishouUa}`);
  check("A1 快手分区 UA 含 Chrome/ 且不含 Electron", !!expectedUa && kuaishouUa.includes("Chrome/") && !kuaishouUa.includes("Electron"), kuaishouUa);
  check("A2 抖音分区 UA 含 Chrome/ 且不含 Electron", !!expectedUa && douyinUa.includes("Chrome/") && !douyinUa.includes("Electron"), douyinUa);
  check("A3 小红书分区 UA 含 Chrome/ 且不含 Electron", !!expectedUa && xhsUa.includes("Chrome/") && !xhsUa.includes("Electron"), xhsUa);
  check(
    "A4 三分区 UA 与运行时 Chrome 版本拼出的真实 UA 一致",
    !!expectedUa &&
      kuaishouUa === expectedUa &&
      douyinUa === expectedUa &&
      xhsUa === expectedUa &&
      expectedUa.includes(`Chrome/${process.versions.chrome}`) &&
      expectedUa.includes("Windows NT 10.0"),
    expectedUa ?? "(none)",
  );
  const anyWin = BrowserWindow.getAllWindows()[0];
  const wcUa = anyWin ? anyWin.webContents.getUserAgent() : "";
  check("A5 采集窗口 webContents UA 同样不含 Electron", !!expectedUa && !!anyWin && wcUa === expectedUa && !wcUa.includes("Electron"), wcUa);
  check("A6 媒体下载请求带的 UA 同样是新 UA（R8）", !!expectedUa && lastMediaUa === expectedUa, lastMediaUa);

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
