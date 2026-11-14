// 监控账号工作台本地 exe 版端到端测试：全部假数据、假账号、假登录态，不连远端。
// 由 Cloudflare 版 e2e 移植：断言一字未动，仅直连库的 helper 由 wrangler d1 execute
// 改为本地 test/dbsql.mjs（node:sqlite 直连测试库）。
// 跑法：bash test/run-e2e.sh（脚本会起一个全新临时数据目录的本地服务，跑完即杀）
// 或先起本地服务（MONITOR_MOCK_FETCHER=1 MONITOR_TEST_MODE=1 假密钥），再 node test/e2e.mjs http://127.0.0.1:17888
// 覆盖：鉴权、账号、配置、任务幂等、去重、置顶排除、排序、保留天数、配额、
//       异常分类与隔离、重试、ZIP 内容、txt 内容、签名过期、Range 流式、清理、
//       通知、操作日志、上报、看板、备份。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] || "http://127.0.0.1:8788";
const DAY_MS = 24 * 3600 * 1000;
const FAKE_PASSWORD = "test-access-pass-123";
const NEW_PASSWORD = "test-access-pass-456";
const FAKE_LOGIN_STATE = "FAKE-LOGIN-STATE-SECRET-12345";
let passed = 0;
let failed = 0;
const failures = [];
const allResponseText = [];

function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`);
  }
}

async function req(method, path, body = undefined, token = undefined, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  allResponseText.push(text);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  return { status: res.status, data, text, headers: res.headers };
}

async function reqBytes(method, path, headers = {}) {
  const url = path.startsWith("http://") || path.startsWith("https://") ? path : `${BASE}${path}`;
  const res = await fetch(url, { method, headers });
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, buf, headers: res.headers };
}

// 经 test/dbsql.mjs 直接读写本地测试库（node:sqlite 直连，与被测服务共用同一份 monitor.db）。
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
function d1(sql) {
  execFileSync("node", [path.join(TEST_DIR, "dbsql.mjs"), sql], {
    stdio: "pipe",
    timeout: 60000,
    env: process.env,
  });
}
function d1query(sql) {
  const out = execFileSync("node", [path.join(TEST_DIR, "dbsql.mjs"), "--json", sql], {
    stdio: "pipe",
    timeout: 60000,
    encoding: "utf8",
    env: process.env,
  });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

// ---- ZIP 解析（测试用最小实现：STORE 条目 + CRC32 校验） ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function parseZip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries = [];
  let off = 0;
  while (off + 30 <= buf.length) {
    const sig = view.getUint32(off, true);
    if (sig !== 0x04034b50) break;
    const flags = view.getUint16(off + 6, true);
    const method = view.getUint16(off + 8, true);
    const crc = view.getUint32(off + 14, true);
    const csize = view.getUint32(off + 18, true);
    const usize = view.getUint32(off + 22, true);
    const nlen = view.getUint16(off + 26, true);
    const elen = view.getUint16(off + 28, true);
    const name = new TextDecoder().decode(buf.subarray(off + 30, off + 30 + nlen));
    const start = off + 30 + nlen + elen;
    entries.push({ name, flags, method, crc, csize, usize, data: buf.subarray(start, start + csize) });
    off = start + csize;
  }
  return entries;
}

function shanghaiDate(ms, addDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms + addDays * DAY_MS),
  );
}

async function main() {
  let token = "";

  console.log("== 健康检查与 CORS ==");
  {
    const r = await req("GET", "/api/v1/health");
    check("health 200 + ok", r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
    const opt = await fetch(`${BASE}/api/v1/works`, { method: "OPTIONS", headers: { Origin: "https://example.test" } });
    check("OPTIONS 预检 204 且带 CORS 头", opt.status === 204 && !!opt.headers.get("Access-Control-Allow-Origin"), String(opt.status));
  }

  console.log("== 鉴权 ==");
  {
    const st0 = await req("GET", "/api/v1/auth/setup-status");
    check("未设置口令时 setup-status 为 false", st0.status === 200 && st0.data.setup_done === false, JSON.stringify(st0.data));
    const noAuth = await req("GET", "/api/v1/accounts");
    check("无令牌访问受保护接口 401", noAuth.status === 401, JSON.stringify(noAuth.data));
    const short = await req("POST", "/api/v1/auth/setup", { password: "short" });
    check("口令不足 8 位被拒", short.status === 400, JSON.stringify(short.data));
    const setup = await req("POST", "/api/v1/auth/setup", { password: FAKE_PASSWORD });
    check("首次设置口令成功并返回令牌", setup.status === 200 && !!setup.data.token, JSON.stringify(setup.data));
    token = setup.data.token;
    const setup2 = await req("POST", "/api/v1/auth/setup", { password: FAKE_PASSWORD });
    check("重复设置口令 409", setup2.status === 409, JSON.stringify(setup2.data));
    const bad = await req("POST", "/api/v1/auth/login", { password: "wrong-password" });
    check("错误口令登录 401", bad.status === 401, JSON.stringify(bad.data));
    const login = await req("POST", "/api/v1/auth/login", { password: FAKE_PASSWORD });
    check("正确口令登录成功", login.status === 200 && !!login.data.token, JSON.stringify(login.data));
    const me = await req("GET", "/api/v1/auth/me", undefined, token);
    check("me 返回本人身份", me.status === 200 && me.data.actor === "本人", JSON.stringify(me.data));
    const badToken = await req("GET", "/api/v1/accounts", undefined, "invalid-token-value");
    check("伪造令牌 401", badToken.status === 401, JSON.stringify(badToken.data));
  }

  console.log("== 配置 ==");
  {
    const s = await req("GET", "/api/v1/settings", undefined, token);
    check(
      "默认配置：保留 3 天 / 链接 30 分钟 / 8 点",
      s.status === 200 && s.data.settings.retention_days === "3" && s.data.settings.download_link_ttl_minutes === "30" && s.data.settings.collect_hour === "8",
      JSON.stringify(s.data),
    );
    check("配置不含内部键", !JSON.stringify(s.data).includes("_access_password_hash"), JSON.stringify(s.data));
    const bad0 = await req("PATCH", "/api/v1/settings", { retention_days: 0 }, token);
    check("保留天数 0 被拒", bad0.status === 400, JSON.stringify(bad0.data));
    const bad31 = await req("PATCH", "/api/v1/settings", { retention_days: 31 }, token);
    check("保留天数 31 被拒", bad31.status === 400, JSON.stringify(bad31.data));
    const badHour = await req("PATCH", "/api/v1/settings", { collect_hour: 9 }, token);
    check("采集时间不可改", badHour.status === 400, JSON.stringify(badHour.data));
    const badTtl = await req("PATCH", "/api/v1/settings", { download_link_ttl_minutes: 3 }, token);
    check("链接有效期小于 5 分钟被拒", badTtl.status === 400, JSON.stringify(badTtl.data));
    const ok30 = await req("PATCH", "/api/v1/settings", { retention_days: 30 }, token);
    check("保留天数改为 30 成功", ok30.status === 200 && ok30.data.settings.retention_days === "30", JSON.stringify(ok30.data));
    const back = await req("PATCH", "/api/v1/settings", { retention_days: 3 }, token);
    check("保留天数改回 3", back.status === 200 && back.data.settings.retention_days === "3", JSON.stringify(back.data));
  }

  console.log("== 账号管理 ==");
  let normalAccountId = 0;
  {
    const badPlatform = await req("POST", "/api/v1/accounts", { platform: "douyin", name: "x", home_url: "https://x", account_id: "a1" }, token);
    check("不支持的平台被拒", badPlatform.status === 400, JSON.stringify(badPlatform.data));
    const missing = await req("POST", "/api/v1/accounts", { platform: "kuaishou", home_url: "https://x", account_id: "a1" }, token);
    check("缺名称被拒", missing.status === 400, JSON.stringify(missing.data));
    const created = await req(
      "POST",
      "/api/v1/accounts",
      { platform: "kuaishou", name: "测试达人甲", home_url: "https://www.kuaishou.com/profile/mock-normal", account_id: "mock:normal", remark: "e2e" },
      token,
    );
    check("新增账号成功", created.status === 201 && created.data.account?.account_id === "mock:normal", JSON.stringify(created.data));
    normalAccountId = created.data.account.id;
    check("新建账号默认健康正常、登录态未配置", created.data.account.health === "normal" && created.data.account.login_state_status === "missing", JSON.stringify(created.data));
    const dup = await req(
      "POST",
      "/api/v1/accounts",
      { platform: "kuaishou", name: "重复", home_url: "https://x", account_id: "mock:normal" },
      token,
    );
    check("重复（平台+账号ID）409", dup.status === 409, JSON.stringify(dup.data));
    const list = await req("GET", "/api/v1/accounts", undefined, token);
    check("账号列表含新建账号", list.status === 200 && list.data.accounts.some((a) => a.id === normalAccountId), JSON.stringify(list.data));
    const upd = await req("PATCH", `/api/v1/accounts/${normalAccountId}`, { remark: "改过备注" }, token);
    check("更新备注成功", upd.status === 200 && upd.data.account.remark === "改过备注", JSON.stringify(upd.data));
    const setLs = await req("POST", `/api/v1/accounts/${normalAccountId}/login-state`, { login_state: FAKE_LOGIN_STATE }, token);
    check("配置登录态成功", setLs.status === 200 && setLs.data.login_state_status === "ok", JSON.stringify(setLs.data));
    const rows = d1query(`SELECT login_state_enc, login_state_status FROM monitor_account WHERE id = ${normalAccountId}`);
    check(
      "登录态存密文（非原文、非空）",
      rows.length === 1 && rows[0].login_state_enc && rows[0].login_state_enc !== FAKE_LOGIN_STATE && rows[0].login_state_status === "ok",
      JSON.stringify(rows),
    );
    const get = await req("GET", `/api/v1/accounts/${normalAccountId}`, undefined, token);
    check("账号详情不含登录态原文与密文", get.status === 200 && !JSON.stringify(get.data).includes(FAKE_LOGIN_STATE) && !("login_state_enc" in get.data.account), JSON.stringify(get.data));
    // 停用/启用 + 删除守卫
    const tmp = await req("POST", "/api/v1/accounts", { platform: "kuaishou", name: "临时账号", home_url: "https://x", account_id: "mock:tmp" }, token);
    const tmpId = tmp.data.account.id;
    const dis = await req("POST", `/api/v1/accounts/${tmpId}/status`, { status: "disabled" }, token);
    check("停用成功", dis.status === 200, JSON.stringify(dis.data));
    const ena = await req("POST", `/api/v1/accounts/${tmpId}/status`, { status: "active" }, token);
    check("重新启用成功", ena.status === 200, JSON.stringify(ena.data));
    const del = await req("DELETE", `/api/v1/accounts/${tmpId}`, undefined, token);
    check("无数据的账号可删除", del.status === 200, JSON.stringify(del.data));
  }

  // 小帮手：建账号 + 配登录态
  async function makeAccount(name, mockId) {
    const c = await req("POST", "/api/v1/accounts", { platform: "kuaishou", name, home_url: `https://www.kuaishou.com/profile/${mockId}`, account_id: mockId }, token);
    if (c.status !== 201) throw new Error(`建账号失败 ${mockId}: ${JSON.stringify(c.data)}`);
    const id = c.data.account.id;
    const s = await req("POST", `/api/v1/accounts/${id}/login-state`, { login_state: FAKE_LOGIN_STATE }, token);
    if (s.status !== 200) throw new Error(`配登录态失败 ${mockId}: ${JSON.stringify(s.data)}`);
    return id;
  }
  async function runTick() {
    const r = await req("POST", "/api/v1/_test/run-cron", { cron: "* * * * *" }, token);
    if (r.status !== 200) throw new Error(`run-cron 失败: ${JSON.stringify(r.data)}`);
    return r.data;
  }
  // 批量建当日任务走 00:00 cron 端点（幂等；手动触发接口有每分钟 5 次限流，不适合批量用）
  async function ensureTask() {
    const r = await req("POST", "/api/v1/_test/run-cron", { cron: "0 0 * * *" }, token);
    if (r.status !== 200) throw new Error(`建任务失败: ${JSON.stringify(r.data)}`);
    return r.data;
  }
  async function taskOf(accountId, date) {
    const r = await req("GET", `/api/v1/tasks?account_id=${accountId}&collect_date=${date}&page_size=5`, undefined, token);
    return r.data.tasks?.[0];
  }
  async function worksOf(accountId) {
    const r = await req("GET", `/api/v1/works?account_id=${accountId}&page_size=50`, undefined, token);
    return r.data.groups?.flatMap((g) => g.works) ?? [];
  }
  const today = shanghaiDate(Date.now());
  const tomorrow = shanghaiDate(Date.now(), 1);

  console.log("== 采集：定时建任务 + 置顶排除 + 去重 ==");
  {
    const cron1 = await req("POST", "/api/v1/_test/run-cron", { cron: "0 0 * * *" }, token);
    check("00:00 cron 建当日任务", cron1.status === 200 && cron1.data.created === 1 && cron1.data.collect_date === today, JSON.stringify(cron1.data));
    const cron2 = await req("POST", "/api/v1/_test/run-cron", { cron: "0 0 * * *" }, token);
    check("重复触发不重复建任务（幂等）", cron2.status === 200 && cron2.data.created === 0, JSON.stringify(cron2.data));
    const tick = await runTick();
    check("每分钟触发认领 1 个任务", tick.claimed === 1, JSON.stringify(tick));
    const task = await taskOf(normalAccountId, today);
    check("任务成功", task?.status === "success" && task?.collected_count === 5, JSON.stringify(task));
    const works = await worksOf(normalAccountId);
    check("入库 5 条作品", works.length === 5, JSON.stringify(works.map((w) => w.work_id)));
    const ids = works.map((w) => w.work_id);
    check("置顶作品未入库", !ids.includes("normal_w0"), ids.join(","));
    check("第 6 新的非置顶作品补位入库（normal_w5 在）", ids.includes("normal_w5"), ids.join(","));
    check("只取前 5 条（normal_w6 不在）", !ids.includes("normal_w6"), ids.join(","));
    check("作品带视频与封面资产", works.every((w) => w.has_video && w.has_cover && w.file_status === "ok"), JSON.stringify(works.map((w) => [w.work_id, w.has_video, w.has_cover, w.file_status])));
    const snaps = d1query("SELECT COUNT(*) AS c FROM work_snapshot");
    check("快照 5 条", snaps[0]?.c === 5, JSON.stringify(snaps));
    const assets = d1query("SELECT COUNT(*) AS c FROM file_asset");
    check("文件资产 10 条（5 视频 + 5 封面）", assets[0]?.c === 10, JSON.stringify(assets));
    // 手动触发同一天：返回已有任务，不新建
    const trig = await req("POST", "/api/v1/tasks/trigger", { account_id: normalAccountId }, token);
    check("手动触发同一天返回已有任务", trig.status === 200 && trig.data.task?.id === task.id, JSON.stringify(trig.data));
    // T4：次日补采再跑一次，去重生效
    const bf = await req("POST", "/api/v1/tasks/backfill", { collect_date: tomorrow }, token);
    check("补采次日建任务", bf.status === 200 && bf.data.created === 1, JSON.stringify(bf.data));
    await runTick();
    const task2 = await taskOf(normalAccountId, tomorrow);
    check("次日任务成功", task2?.status === "success", JSON.stringify(task2));
    const works2 = await worksOf(normalAccountId);
    check("重复采集不产生重复作品（仍 5 条）", works2.length === 5, String(works2.length));
    const snaps2 = d1query("SELECT work_id, COUNT(*) AS c FROM work_snapshot GROUP BY work_id");
    check("每作品快照各新增一条（各 2 条）", snaps2.length === 5 && snaps2.every((r) => r.c === 2), JSON.stringify(snaps2));
  }

  console.log("== 排序与分页 ==");
  {
    const likes = await req("GET", `/api/v1/works?account_id=${normalAccountId}&sort=likes_desc&page_size=50`, undefined, token);
    const likesOrder = likes.data.groups[0].works.map((w) => w.work_id);
    check("点赞降序正确", likesOrder.join(",") === "normal_w4,normal_w2,normal_w3,normal_w1,normal_w5", likesOrder.join(","));
    check("响应带当前排序规则", likes.data.sort === "likes_desc", JSON.stringify(likes.data.sort));
    const pub = await req("GET", `/api/v1/works?account_id=${normalAccountId}&sort=published_desc&page_size=50`, undefined, token);
    const pubOrder = pub.data.groups[0].works.map((w) => w.work_id);
    check("发布时间降序正确", pubOrder.join(",") === "normal_w1,normal_w2,normal_w3,normal_w4,normal_w5", pubOrder.join(","));
    const p1 = await req("GET", `/api/v1/works?account_id=${normalAccountId}&sort=likes_desc&page=1&page_size=2`, undefined, token);
    const p2 = await req("GET", `/api/v1/works?account_id=${normalAccountId}&sort=likes_desc&page=2&page_size=2`, undefined, token);
    const p3 = await req("GET", `/api/v1/works?account_id=${normalAccountId}&sort=likes_desc&page=3&page_size=2`, undefined, token);
    const all = [...p1.data.groups[0].works, ...p2.data.groups[0].works, ...p3.data.groups[0].works].map((w) => w.work_id);
    check("翻页无重复无遗漏", all.length === 5 && new Set(all).size === 5, all.join(","));
    check("分组第一层按平台", likes.data.groups.length === 1 && likes.data.groups[0].platform === "kuaishou", JSON.stringify(likes.data.groups?.map((g) => g.platform)));
    const filtered = await req("GET", `/api/v1/works?account_id=${normalAccountId}&downloaded=0&page_size=50`, undefined, token);
    check("按是否下载筛选", filtered.data.total === 5, JSON.stringify(filtered.data.total));
  }

  console.log("== 预览与 Range 流式 ==");
  let normalW1Id = 0;
  let previewVideoUrl = "";
  {
    const works = await worksOf(normalAccountId);
    normalW1Id = works.find((w) => w.work_id === "normal_w1").id;
    const pv = await req("POST", `/api/v1/works/${normalW1Id}/preview`, {}, token);
    check("预览返回视频与封面签名链接", pv.status === 200 && !!pv.data.video_url && !!pv.data.cover_url, JSON.stringify(pv.data));
    previewVideoUrl = pv.data.video_url;
    const full = await reqBytes("GET", previewVideoUrl);
    check("签名链接可完整下载视频", full.status === 200 && full.buf.length > 1000, `status=${full.status} len=${full.buf.length}`);
    check("视频内容为 mock 假数据", new TextDecoder().decode(full.buf.subarray(0, 20)).startsWith("FAKE-MEDIA:"), new TextDecoder().decode(full.buf.subarray(0, 20)));
    const range = await reqBytes("GET", previewVideoUrl, { Range: "bytes=0-99" });
    check("Range 请求 206", range.status === 206, `status=${range.status}`);
    check("Range 返回 100 字节且 Content-Range 正确", range.buf.length === 100 && (range.headers.get("Content-Range") || "").startsWith("bytes 0-99/"), `${range.buf.length} ${range.headers.get("Content-Range")}`);
    const suffix = await reqBytes("GET", previewVideoUrl, { Range: "bytes=-10" });
    check("尾部 Range 206 且 10 字节", suffix.status === 206 && suffix.buf.length === 10, `status=${suffix.status} len=${suffix.buf.length}`);
    const head = await reqBytes("HEAD", previewVideoUrl);
    check("HEAD 返回 200 且有长度头", head.status === 200 && !!head.headers.get("Content-Length"), `status=${head.status}`);
  }

  console.log("== 异常场景：置顶字段缺失 / 下载失败 / 少量 / 空列表 ==");
  {
    const npfId = await makeAccount("缺置顶字段", "mock:no_pinned_field");
    await ensureTask();
    await runTick();
    const t = await taskOf(npfId, today);
    check("无置顶字段任务失败且标待人工核对", t?.status === "failed" && t?.needs_review === true, JSON.stringify(t));
    const works = await worksOf(npfId);
    check("无置顶字段不入库", works.length === 0, String(works.length));

    const dfId = await makeAccount("下载失败", "mock:download_fail");
    await ensureTask();
    await runTick();
    const t2 = await taskOf(dfId, today);
    check("单条下载失败任务标部分失败", t2?.status === "partial" && t2?.collected_count === 3, JSON.stringify(t2));
    const dfWorks = await worksOf(dfId);
    const bad = dfWorks.find((w) => w.work_id === "df_w2");
    const good = dfWorks.find((w) => w.work_id === "df_w1");
    check("下载失败的作品标文件缺失", bad?.file_status === "missing" && bad?.has_video === false, JSON.stringify(bad));
    check("其他作品文件正常", good?.file_status === "ok" && good?.has_video === true, JSON.stringify(good));

    const fewId = await makeAccount("少量作品", "mock:few");
    await ensureTask();
    await runTick();
    const t3 = await taskOf(fewId, today);
    check("不足 5 条如实入库 2 条", t3?.status === "success" && t3?.collected_count === 2, JSON.stringify(t3));

    const emptyId = await makeAccount("空列表", "mock:empty");
    await ensureTask();
    await runTick();
    const t4 = await taskOf(emptyId, today);
    check("空列表任务成功 0 条", t4?.status === "success" && t4?.collected_count === 0, JSON.stringify(t4));
  }

  console.log("== 保留天数 ==");
  {
    await req("PATCH", "/api/v1/settings", { retention_days: 1 }, token);
    const r1Id = await makeAccount("保留1天", "mock:retain1");
    await ensureTask();
    await runTick();
    const r1Works = await worksOf(r1Id);
    check(
      "保留 1 天：expires = 采集完成 + 1 天",
      r1Works.length > 0 && r1Works.every((w) => w.expires_at - w.collected_finished_at === DAY_MS && w.retention_days === 1),
      JSON.stringify(r1Works.map((w) => [w.expires_at - w.collected_finished_at, w.retention_days])),
    );
    await req("PATCH", "/api/v1/settings", { retention_days: 30 }, token);
    const r30Id = await makeAccount("保留30天", "mock:retain30");
    await ensureTask();
    await runTick();
    const r30Works = await worksOf(r30Id);
    check(
      "保留 30 天：expires = 采集完成 + 30 天",
      r30Works.length > 0 && r30Works.every((w) => w.expires_at - w.collected_finished_at === 30 * DAY_MS && w.retention_days === 30),
      JSON.stringify(r30Works.map((w) => [w.expires_at - w.collected_finished_at, w.retention_days])),
    );
    const r1Again = await worksOf(r1Id);
    check("改配置不影响已入库作品的保留期", r1Again.every((w) => w.retention_days === 1), JSON.stringify(r1Again.map((w) => w.retention_days)));
    await req("PATCH", "/api/v1/settings", { retention_days: 3 }, token);
  }

  console.log("== 存储配额 ==");
  {
    await req("PATCH", "/api/v1/settings", { storage_quota_bytes: 100 }, token);
    const qId = await makeAccount("配额测试", "mock:quota");
    await ensureTask();
    await runTick();
    const qWorks = await worksOf(qId);
    check("超配额仍保留元数据", qWorks.length === 5, String(qWorks.length));
    check("超配额文件标缺失", qWorks.every((w) => w.file_status === "missing" && !w.has_video), JSON.stringify(qWorks.map((w) => w.file_status)));
    const notifs = await req("GET", "/api/v1/notifications?type=storage_critical&page_size=5", undefined, token);
    check("超配额产生存储告警", notifs.data.total >= 1, JSON.stringify(notifs.data.total));
    await req("PATCH", "/api/v1/settings", { storage_quota_bytes: 8589934592 }, token);
  }

  console.log("== 异常分类与单账号隔离 ==");
  {
    const goodId = await makeAccount("好账号", "mock:good");
    const badId = await makeAccount("登录失效", "mock:login_expired");
    await ensureTask();
    await ensureTask();
    await runTick();
    const gt = await taskOf(goodId, today);
    const bt = await taskOf(badId, today);
    check("好账号成功", gt?.status === "success", JSON.stringify(gt));
    check("登录失效账号失败且分类正确", bt?.status === "failed" && bt?.error_code === "login_expired", JSON.stringify(bt));
    const badAcc = await req("GET", `/api/v1/accounts/${badId}`, undefined, token);
    check("登录失效账号健康变失效、登录态标过期", badAcc.data.account.health === "invalid" && badAcc.data.account.login_state_status === "expired", JSON.stringify(badAcc.data.account));
    const invNotifs = await req("GET", "/api/v1/notifications?type=account_invalid&page_size=5", undefined, token);
    check("账号失效告警已发", invNotifs.data.total >= 1, JSON.stringify(invNotifs.data.total));

    const rlId = await makeAccount("限流", "mock:rate_limit");
    await ensureTask();
    await runTick();
    const rt = await taskOf(rlId, today);
    check("限流失败回 waiting 等重试", rt?.status === "waiting" && rt?.retry_count === 1 && rt?.next_retry_at > 0, JSON.stringify(rt));
    // 造连续失败 3 次：fail_streak=2 + 重试次数耗尽 → 下一次失败即 failing
    d1(`UPDATE collect_task SET retry_count = 3, next_retry_at = 0 WHERE account_id = ${rlId} AND status = 'waiting'`);
    d1(`UPDATE monitor_account SET fail_streak = 2 WHERE id = ${rlId}`);
    await runTick();
    const rt2 = await taskOf(rlId, today);
    check("重试耗尽后任务失败", rt2?.status === "failed" && rt2?.error_code === "rate_limit", JSON.stringify(rt2));
    const rlAcc = await req("GET", `/api/v1/accounts/${rlId}`, undefined, token);
    check("连续失败 3 次健康变连续失败", rlAcc.data.account.health === "failing" && rlAcc.data.account.fail_streak === 3, JSON.stringify(rlAcc.data.account));
    const streakNotifs = await req("GET", "/api/v1/notifications?type=failing_streak&page_size=5", undefined, token);
    check("连续失败告警已发", streakNotifs.data.total >= 1, JSON.stringify(streakNotifs.data.total));

    const capId = await makeAccount("验证码", "mock:captcha");
    await ensureTask();
    await runTick();
    const ct = await taskOf(capId, today);
    check("验证码失败不重试且健康变风控", ct?.status === "failed" && ct?.error_code === "captcha", JSON.stringify(ct));
    const capAcc = await req("GET", `/api/v1/accounts/${capId}`, undefined, token);
    check("验证码账号健康为风控", capAcc.data.account.health === "risk", JSON.stringify(capAcc.data.account));

    const banId = await makeAccount("封禁", "mock:banned");
    await ensureTask();
    await runTick();
    const bant = await taskOf(banId, today);
    check("封禁失败分类正确", bant?.status === "failed" && bant?.error_code === "banned", JSON.stringify(bant));

    const netId = await makeAccount("网络失败", "mock:network");
    await ensureTask();
    await runTick();
    const nt = await taskOf(netId, today);
    check("网络失败回 waiting 等重试", nt?.status === "waiting" && nt?.error_code === "network", JSON.stringify(nt));
  }

  console.log("== 失败重试端点 ==");
  {
    const badTasks = await req("GET", "/api/v1/tasks?status=failed&page_size=50", undefined, token);
    const loginTask = badTasks.data.tasks.find((t) => t.error_code === "login_expired");
    const retry = await req("POST", `/api/v1/tasks/${loginTask.id}/retry`, {}, token);
    check("失败任务可手动重试", retry.status === 200, JSON.stringify(retry.data));
    const after = await req("GET", `/api/v1/tasks/${loginTask.id}`, undefined, token);
    check("重试后回 waiting 且计数清零", after.data.task.status === "waiting" && after.data.task.retry_count === 0, JSON.stringify(after.data.task));
    const okTask = await taskOf(normalAccountId, today);
    const retryOk = await req("POST", `/api/v1/tasks/${okTask.id}/retry`, {}, token);
    check("成功任务不可重试", retryOk.status === 409, JSON.stringify(retryOk.data));
  }

  console.log("== ZIP 下载 ==");
  let zipDownloadUrl = "";
  {
    const noConfirm = await req("POST", `/api/v1/works/${normalW1Id}/download`, { confirm_internal_use: false }, token);
    check("未确认仅限内部使用无法下载", noConfirm.status === 400, JSON.stringify(noConfirm.data));
    const dl = await req("POST", `/api/v1/works/${normalW1Id}/download`, { confirm_internal_use: true }, token);
    check("申请下载返回签名链接", dl.status === 200 && !!dl.data.download_url && !!dl.data.filename, JSON.stringify(dl.data));
    check("ZIP 文件名含平台_账号_作品ID", dl.data.filename.startsWith("kuaishou_") && dl.data.filename.includes("normal_w1") && dl.data.filename.endsWith(".zip"), dl.data.filename);
    zipDownloadUrl = dl.data.download_url;
    const zipRes = await reqBytes("GET", zipDownloadUrl);
    check("ZIP 可下载", zipRes.status === 200 && zipRes.buf.length > 100, `status=${zipRes.status} len=${zipRes.buf.length}`);
    const entries = parseZip(zipRes.buf);
    check("ZIP 内 3 个条目（目录+视频+文案）", entries.length === 3, entries.map((e) => e.name).join(" | "));
    const folder = entries[0]?.name ?? "";
    check("首条目为目录", folder.endsWith("/") && !folder.slice(0, -1).includes("/"), folder);
    const videoEntry = entries.find((e) => e.name.endsWith("视频.mp4"));
    const txtEntry = entries.find((e) => e.name.endsWith("文案.txt"));
    check("视频与文案在同一目录下", !!videoEntry && !!txtEntry && videoEntry.name.startsWith(folder) && txtEntry.name.startsWith(folder), entries.map((e) => e.name).join(" | "));
    check("条目均为 STORE 且 UTF-8 标记", entries.every((e) => e.method === 0 && (e.flags & 0x0800) !== 0), JSON.stringify(entries.map((e) => [e.method, e.flags])));
    check("CRC32 全部正确", entries.every((e) => crc32(e.data) === e.crc), JSON.stringify(entries.map((e) => [e.name, e.crc, crc32(e.data)])));
    check("视频内容与源文件一致", new TextDecoder().decode(videoEntry.data.subarray(0, 20)).startsWith("FAKE-MEDIA:"), new TextDecoder().decode(videoEntry.data.subarray(0, 20)));
    const txt = new TextDecoder().decode(txtEntry.data);
    const lines = txt.trim().split("\n");
    check("文案 5 行", lines.length === 5, JSON.stringify(lines));
    check("文案含标题/话题/链接/发布时间/采集时间", lines[0].startsWith("标题：") && lines[1].startsWith("话题：") && lines[2].startsWith("作品链接：") && lines[3].startsWith("发布时间：") && lines[4].startsWith("采集时间："), txt);
    check("文案中文无乱码且话题带 #", txt.includes("测试作品1") && lines[1].includes("#"), txt);
    const dl2 = await req("POST", `/api/v1/works/${normalW1Id}/download`, { confirm_internal_use: true }, token);
    const zip2 = await reqBytes("GET", dl2.data.download_url);
    check("二次下载复用缓存 ZIP（字节一致）", zip2.buf.length === zipRes.buf.length && crc32(zip2.buf) === crc32(zipRes.buf), `${zip2.buf.length} vs ${zipRes.buf.length}`);
    const recs = await req("GET", `/api/v1/downloads?work_id=${normalW1Id}`, undefined, token);
    check("下载记录 2 条成功", recs.data.total === 2 && recs.data.records.every((r) => r.status === "success"), JSON.stringify(recs.data.total));
    const workAfter = await req("GET", `/api/v1/works/${normalW1Id}`, undefined, token);
    check("下载后作品标已下载", workAfter.data.work.downloaded === true, JSON.stringify(workAfter.data.work.downloaded));

    // 文件名安全处理：账号名含 / 与 ..
    const weirdId = await makeAccount("a/b..c  ", "mock:sanitize");
    await ensureTask();
    await runTick();
    const weirdWorks = await worksOf(weirdId);
    const weirdDl = await req("POST", `/api/v1/works/${weirdWorks[0].id}/download`, { confirm_internal_use: true }, token);
    const weirdZip = await reqBytes("GET", weirdDl.data.download_url);
    const weirdEntries = parseZip(weirdZip.buf);
    const weirdFolder = weirdEntries[0]?.name ?? "";
    check("危险账号名已清洗（目录名单段无 /）", weirdFolder.endsWith("/") && !weirdFolder.slice(0, -1).includes("/") && !weirdFolder.includes(".."), weirdFolder);
  }

  console.log("== 签名过期与伪造 ==");
  {
    const assetRow = d1query(`SELECT id FROM file_asset WHERE work_id = ${normalW1Id} AND kind = 'zip'`);
    const zipAssetId = assetRow[0].id;
    const expired = await req("POST", "/api/v1/_test/issue-token", { asset_id: zipAssetId, expires_in_seconds: -10 }, token);
    const expiredGet = await reqBytes("GET", expired.data.download_url);
    check("过期签名被拒 403", expiredGet.status === 403, `status=${expiredGet.status}`);
    const forgedUrl = zipDownloadUrl.slice(0, -4) + "AAAA";
    const forged = await reqBytes("GET", forgedUrl);
    check("伪造签名被拒 403", forged.status === 403, `status=${forged.status}`);
    const noToken = await reqBytes("GET", `${BASE}/api/v1/files/download`);
    check("无签名被拒 403", noToken.status === 403, `status=${noToken.status}`);
    const fresh = await req("POST", "/api/v1/_test/issue-token", { asset_id: zipAssetId, expires_in_seconds: 60 }, token);
    const freshGet = await reqBytes("GET", fresh.data.download_url);
    check("有效签名可下载", freshGet.status === 200, `status=${freshGet.status}`);
  }

  console.log("== 到期清理 ==");
  {
    const target = d1query("SELECT id FROM work WHERE work_id = 'sanitize_w5'")[0];
    d1(`UPDATE file_asset SET expires_at = 1 WHERE work_id = ${target.id}`);
    const before = d1query(`SELECT COUNT(*) AS c FROM file_asset WHERE work_id = ${target.id}`);
    check("清理前该作品有资产", before[0]?.c === 2, JSON.stringify(before));
    const run = await req("POST", "/api/v1/cleanup/run", {}, token);
    check("手动清理成功", run.status === 200 && run.data.deleted_assets >= 2, JSON.stringify(run.data));
    const after = d1query(`SELECT COUNT(*) AS c FROM file_asset WHERE work_id = ${target.id}`);
    check("过期资产已删", after[0]?.c === 0, JSON.stringify(after));
    const logs = await req("GET", "/api/v1/cleanup/records?page_size=5", undefined, token);
    check("清理记录有该条", logs.data.total >= 2, JSON.stringify(logs.data.total));
    const workStill = await req("GET", `/api/v1/works/${target.id}`, undefined, token);
    check("元数据仍在（只删文件）", workStill.status === 200 && workStill.data.work.has_video === false, JSON.stringify(workStill.status));
    const oldLink = await reqBytes("GET", previewVideoUrl);
    check("未过期作品的链接不受清理影响", oldLink.status === 200, `status=${oldLink.status}`);
  }

  console.log("== 漏跑补采幂等 ==");
  {
    const bf1 = await req("POST", "/api/v1/tasks/backfill", { collect_date: "2030-01-01" }, token);
    check("补采建任务", bf1.status === 200 && bf1.data.created > 0, JSON.stringify(bf1.data));
    const bf2 = await req("POST", "/api/v1/tasks/backfill", { collect_date: "2030-01-01" }, token);
    check("重复补采不重复建", bf2.status === 200 && bf2.data.created === 0, JSON.stringify(bf2.data));
    const tasks = await req("GET", "/api/v1/tasks?collect_date=2030-01-01&page_size=3", undefined, token);
    check("补采任务标记 backfill", tasks.data.tasks.every((t) => t.trigger === "backfill"), JSON.stringify(tasks.data.tasks?.map((t) => t.trigger)));
  }

  console.log("== 通知中心 ==");
  {
    const list = await req("GET", "/api/v1/notifications?page_size=50", undefined, token);
    check("通知列表非空", list.data.total > 0 && list.data.unread_count > 0, JSON.stringify([list.data.total, list.data.unread_count]));
    const firstId = list.data.notifications[0].id;
    const mark = await req("POST", "/api/v1/notifications/mark-read", { ids: [firstId] }, token);
    check("标已读成功", mark.status === 200, JSON.stringify(mark.data));
    const after = await req("GET", "/api/v1/notifications?unread_only=1&page_size=50", undefined, token);
    check("已读通知不再出现在未读列表", !after.data.notifications.some((n) => n.id === firstId), JSON.stringify(after.data.notifications?.map((n) => n.id)));
    const all = await req("POST", "/api/v1/notifications/mark-all-read", {}, token);
    check("全部已读成功", all.status === 200, JSON.stringify(all.data));
    const afterAll = await req("GET", "/api/v1/notifications", undefined, token);
    check("未读计数清零", afterAll.data.unread_count === 0, JSON.stringify(afterAll.data.unread_count));
  }

  console.log("== 操作日志与敏感信息 ==");
  {
    const logs = await req("GET", "/api/v1/operation-logs?page_size=100", undefined, token);
    const actions = logs.data.logs.map((l) => l.action);
    check("日志含新增账号", actions.includes("account_create"), actions.join(","));
    check("日志含下载", actions.includes("download"), actions.join(","));
    check("日志含配置变更", actions.includes("config_change"), actions.join(","));
    check("日志含登录态配置", actions.includes("login_state_update"), actions.join(","));
    const filtered = await req("GET", "/api/v1/operation-logs?action=download&page_size=5", undefined, token);
    check("日志按动作筛选", filtered.data.logs.every((l) => l.action === "download"), JSON.stringify(filtered.data.logs?.map((l) => l.action)));
    const leaked = allResponseText.some((t) => t.includes(FAKE_LOGIN_STATE));
    check("全部接口响应均不含登录态原文", !leaked, "");
    const logRows = d1query("SELECT detail FROM operation_log WHERE action = 'login_state_update'");
    check("日志详情不含登录态原文", logRows.length > 0 && logRows.every((r) => !r.detail.includes(FAKE_LOGIN_STATE)), JSON.stringify(logRows));
  }

  console.log("== 扩展/手动上报 ==");
  {
    const now = Date.now();
    const payload = {
      platform: "kuaishou",
      account_id: "mock:normal",
      works: [
        { work_id: "intake_w1", title: "上报作品1", topics: ["上报"], origin_url: "https://www.kuaishou.com/short-video/intake_w1", published_at: now - 1000, likes: 11 },
        { work_id: "intake_w2", title: "上报作品2", topics: [], origin_url: "https://www.kuaishou.com/short-video/intake_w2", published_at: now - 2000, likes: 22 },
        { work_id: "intake_pinned", title: "置顶上报", topics: [], origin_url: "https://www.kuaishou.com/short-video/intake_pinned", published_at: now - 500, likes: 99, is_pinned: true },
      ],
    };
    const r1 = await req("POST", "/api/v1/intake/report", payload, token);
    check("上报新增 2 条、跳过置顶 1 条", r1.status === 200 && r1.data.created === 2 && r1.data.skipped_pinned === 1, JSON.stringify(r1.data));
    const r2 = await req("POST", "/api/v1/intake/report", payload, token);
    check("重复上报去重（0 新增 2 更新）", r2.status === 200 && r2.data.created === 0 && r2.data.updated === 2, JSON.stringify(r2.data));
    const works = await worksOf(normalAccountId);
    const iw = works.find((w) => w.work_id === "intake_w1");
    check("上报作品入库且文件标缺失", !!iw && iw.file_status === "missing", JSON.stringify(iw));
    check("上报置顶未入库", !works.some((w) => w.work_id === "intake_pinned"), works.map((w) => w.work_id).join(","));
    const bad = await req("POST", "/api/v1/intake/report", { platform: "kuaishou", account_id: "mock:nope", works: [payload.works[0]] }, token);
    check("上报不存在的账号 404", bad.status === 404, JSON.stringify(bad.data));
  }

  console.log("== 看板与存储 ==");
  {
    const dash = await req("GET", "/api/v1/dashboard", undefined, token);
    check("看板今日任务计数", dash.status === 200 && dash.data.tasks.success >= 1 && dash.data.tasks.failed >= 1, JSON.stringify(dash.data.tasks));
    check("看板今日作品数大于 0", dash.data.works_today > 0, JSON.stringify(dash.data.works_today));
    check("看板存储占用大于 0", dash.data.storage.used_bytes > 0 && dash.data.storage.quota_bytes === 8589934592, JSON.stringify(dash.data.storage));
    const usage = await req("GET", "/api/v1/storage/usage", undefined, token);
    check("存储用量含分 kind 明细", usage.status === 200 && usage.data.by_kind.some((k) => k.kind === "video"), JSON.stringify(usage.data.by_kind));
  }

  console.log("== 备份导出 ==");
  {
    const bk = await req("GET", "/api/v1/backup/export", undefined, token);
    check("备份导出成功", bk.status === 200 && bk.data.version === 1, JSON.stringify(Object.keys(bk.data)));
    check("备份含 7 张业务表", ["monitor_account", "work", "work_snapshot", "collect_task", "file_asset", "download_record", "operation_log"].every((t) => t in bk.data.tables), Object.keys(bk.data.tables ?? {}).join(","));
    check("备份不含会话表", !("sessions" in bk.data.tables), Object.keys(bk.data.tables ?? {}).join(","));
    const bkText = JSON.stringify(bk.data);
    check("备份不含口令哈希内部键", !bkText.includes("_access_password_hash"), "");
    check("备份不含登录态原文", !bkText.includes(FAKE_LOGIN_STATE), "");
    check("备份含登录态密文（随库走）", bk.data.tables.monitor_account.some((a) => a.login_state_enc && a.login_state_enc !== FAKE_LOGIN_STATE), "");
  }

  console.log("== 改口令 ==");
  {
    const wrong = await req("POST", "/api/v1/auth/change-password", { old_password: "wrong", new_password: NEW_PASSWORD }, token);
    check("旧口令错拒绝改口令", wrong.status === 401, JSON.stringify(wrong.data));
    const ch = await req("POST", "/api/v1/auth/change-password", { old_password: FAKE_PASSWORD, new_password: NEW_PASSWORD }, token);
    check("改口令成功并要求重新登录", ch.status === 200 && ch.data.relogin === true, JSON.stringify(ch.data));
    const oldToken = await req("GET", "/api/v1/auth/me", undefined, token);
    check("改口令后旧令牌失效", oldToken.status === 401, JSON.stringify(oldToken.data));
    const login2 = await req("POST", "/api/v1/auth/login", { password: NEW_PASSWORD });
    check("新口令可登录", login2.status === 200 && !!login2.data.token, JSON.stringify(login2.data));
    const logout = await req("POST", "/api/v1/auth/logout", {}, login2.data.token);
    check("退出登录成功", logout.status === 200, JSON.stringify(logout.data));
    const afterLogout = await req("GET", "/api/v1/auth/me", undefined, login2.data.token);
    check("退出后令牌失效", afterLogout.status === 401, JSON.stringify(afterLogout.data));
  }

  console.log(`\n== 结果：通过 ${passed}，失败 ${failed} ==`);
  if (failed > 0) {
    console.log("失败用例：");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("E2E 异常退出：", e);
  process.exit(1);
});
