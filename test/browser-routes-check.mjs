// v0.2.0 新增路由检查（手动跑，不进 npm test 必跑项）：
// 浏览器状态/登录窗接口在 CLI 模式下的诚实降级、上报令牌的查看/轮换/鉴权边界。
// 跑法：bash test/run-browser-routes.sh（起全新临时数据目录的本地服务，文件模式密钥，跑完即杀）。
// 注意：本检查不用环境变量密钥（文件模式），轮换才能写回 secrets.json。

const BASE = process.argv[2] || "http://127.0.0.1:17892";
const FAKE_PASSWORD = "check-only-password-123";
let passed = 0;
let failed = 0;

function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}

async function req(method, path, body = undefined, token = undefined) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  return { status: res.status, data, text };
}

const r = await req("POST", "/api/v1/auth/setup", { password: FAKE_PASSWORD });
check("设置口令成功", r.status === 200 && r.data.ok === true, r.text);
const token = r.data.token;
check("设置后拿到会话令牌", typeof token === "string" && token.length > 10);

// 1. 浏览器状态：CLI 模式 available=false，logged_in=null，port 为实际端口
const st = await req("GET", "/api/v1/browser/status", undefined, token);
check("浏览器状态接口可调", st.status === 200 && st.data.ok === true, st.text);
check("CLI 模式 available=false", st.data.available === false, st.text);
check("CLI 模式 logged_in=null", st.data.logged_in === null, st.text);
check("CLI 模式 platforms=null", st.data.platforms === null, st.text);
check("状态里带实际端口", st.data.port === 17892, st.text);

// 2. 登录窗：CLI 模式报 503
const sl = await req("POST", "/api/v1/browser/show-login", {}, token);
check("CLI 模式弹登录窗报 503", sl.status === 503, sl.text);
const slDy = await req("POST", "/api/v1/browser/show-login", { platform: "douyin" }, token);
check("CLI 模式带 platform 弹登录窗报 503", slDy.status === 503, slDy.text);

// 3. 未登录调新接口一律 401
const stNoAuth = await req("GET", "/api/v1/browser/status");
check("未登录查浏览器状态报 401", stNoAuth.status === 401, stNoAuth.text);
const tkNoAuth = await req("GET", "/api/v1/intake/token");
check("未登录取令牌报 401", tkNoAuth.status === 401, tkNoAuth.text);

// 4. 上报令牌查看与轮换
const tk1 = await req("GET", "/api/v1/intake/token", undefined, token);
check("取上报令牌成功", tk1.status === 200 && typeof tk1.data.token === "string" && tk1.data.token.length >= 16, tk1.text);
const oldToken = tk1.data.token;
const rot = await req("POST", "/api/v1/intake/token/rotate", {}, token);
check("轮换上报令牌成功", rot.status === 200 && typeof rot.data.token === "string", rot.text);
const newToken = rot.data.token;
check("轮换后令牌变了", newToken && newToken !== oldToken);
const tk2 = await req("GET", "/api/v1/intake/token", undefined, token);
check("查看到的令牌是新的", tk2.data.token === newToken, tk2.text);

// 5. 上报令牌鉴权边界：只对 /intake/report 有效
const acc = await req("POST", "/api/v1/accounts", {
  platform: "kuaishou",
  name: "令牌检查账号",
  home_url: "https://www.kuaishou.com/profile/check",
  account_id: "check_acct",
  remark: null,
}, token);
check("新建账号成功", (acc.status === 200 || acc.status === 201) && acc.data.ok === true, acc.text);
const payload = {
  platform: "kuaishou",
  account_id: "check_acct",
  works: [
    { work_id: "tok_w1", title: "令牌上报作品", origin_url: "https://www.kuaishou.com/short-video/tok_w1", published_at: Date.now() - 1000, likes: 5 },
  ],
};
const repNew = await req("POST", "/api/v1/intake/report", payload, newToken);
check("新令牌可上报", repNew.status === 200 && repNew.data.created === 1, repNew.text);
const repOld = await req("POST", "/api/v1/intake/report", payload, oldToken);
check("旧令牌上报被拒 401", repOld.status === 401, repOld.text);
const repBad = await req("POST", "/api/v1/intake/report", payload, "garbage-token-value");
check("假令牌上报被拒 401", repBad.status === 401, repBad.text);
const accWithToken = await req("GET", "/api/v1/accounts", undefined, newToken);
check("上报令牌调其他接口被拒 401", accWithToken.status === 401, accWithToken.text);
const tkWithToken = await req("GET", "/api/v1/intake/token", undefined, newToken);
check("上报令牌不能用来查看令牌", tkWithToken.status === 401, tkWithToken.text);
const repSession = await req("POST", "/api/v1/intake/report", payload, token);
check("会话令牌仍可上报（去重更新）", repSession.status === 200 && repSession.data.updated === 1, repSession.text);

// 6. v0.3.0 账号链接归一：抖音短链拒绝、小红书去 token、三平台白名单
const dyShort = await req("POST", "/api/v1/accounts", {
  platform: "douyin",
  name: "短链账号",
  home_url: "https://v.douyin.com/abc123/",
  account_id: "dy_short",
  remark: null,
}, token);
check("抖音短链建账号报 400", dyShort.status === 400 && String(dyShort.data.error || "").includes("请贴完整主页链接"), dyShort.text);
const xhsTok = await req("POST", "/api/v1/accounts", {
  platform: "xiaohongshu",
  name: "小红书账号",
  home_url: "https://www.xiaohongshu.com/user/profile/24charuserid1234567890?xsec_token=tok123&xsec_source=pc_user",
  account_id: "xhs_tok",
  remark: null,
}, token);
check(
  "小红书链接去 token 后入库",
  (xhsTok.status === 200 || xhsTok.status === 201) && !String(xhsTok.data.account.home_url).includes("xsec_token") && String(xhsTok.data.account.home_url).includes("/user/profile/24charuserid1234567890"),
  xhsTok.text,
);
const dyFull = await req("POST", "/api/v1/accounts", {
  platform: "douyin",
  name: "抖音账号",
  home_url: "https://www.douyin.com/user/MS4wLjABAAAAtest",
  account_id: "dy_full",
  remark: null,
}, token);
check("抖音完整链接建账号成功", (dyFull.status === 200 || dyFull.status === 201) && dyFull.data.ok === true, dyFull.text);
const badPlat = await req("POST", "/api/v1/accounts", {
  platform: "bilibili",
  name: "未知平台",
  home_url: "https://space.bilibili.com/1",
  account_id: "bili1",
  remark: null,
}, token);
check("未知平台建账号报 400", badPlat.status === 400, badPlat.text);

// 7. v0.3.1 批量添加账号：逐行结果、短链拒绝、去重、去 token、鉴权
const batchNoAuth = await req("POST", "/api/v1/accounts/batch", { platform: "kuaishou", lines: ["https://www.kuaishou.com/profile/abc"] });
check("未登录批量添加报 401", batchNoAuth.status === 401, batchNoAuth.text);
const batchBadPlat = await req("POST", "/api/v1/accounts/batch", { platform: "bilibili", lines: ["https://space.bilibili.com/1"] }, token);
check("批量添加未知平台报 400", batchBadPlat.status === 400, batchBadPlat.text);
const batchEmpty = await req("POST", "/api/v1/accounts/batch", { platform: "kuaishou", lines: [] }, token);
check("批量添加空行数组报 400", batchEmpty.status === 400, batchEmpty.text);
const dupPre = await req("POST", "/api/v1/accounts", {
  platform: "kuaishou",
  name: "重复预置",
  home_url: "https://www.kuaishou.com/profile/batch_dup",
  account_id: "batch_dup",
  remark: null,
}, token);
check("批量去重预置账号成功", (dupPre.status === 200 || dupPre.status === 201) && dupPre.data.ok === true, dupPre.text);
const batch = await req("POST", "/api/v1/accounts/batch", {
  platform: "kuaishou",
  lines: [
    "https://www.kuaishou.com/profile/batch_one",
    "https://www.kuaishou.com/profile/batch_two 搞笑达人",
    "",
    "https://www.kuaishou.com/profile/batch_dup",
    "https://www.kuaishou.com/profile/batch_one",
    "not-a-url",
    "https://www.kuaishou.com/profile/",
  ],
}, token);
check(
  "批量添加汇总正确（新增2跳过2失败2，空行不计）",
  batch.status === 200 && batch.data.ok === true && batch.data.summary.added === 2 && batch.data.summary.skipped === 2 &&
    batch.data.summary.failed === 2 && batch.data.summary.total === 6,
  batch.text,
);
const br = batch.data.results || [];
check(
  "批量逐行结果行号对齐原文行",
  br.length === 6 && br[0].line === 1 && br[1].line === 2 && br[2].line === 4 && br[3].line === 5 && br[4].line === 6 && br[5].line === 7,
  batch.text,
);
check("批量第一行已添加且账号 ID 取自链接", br[0].status === "added" && br[0].account_id === "batch_one", batch.text);
check("批量已存在行跳过并给原因", br[2].status === "skipped" && String(br[2].reason || "").includes("已存在"), batch.text);
check("批量坏链接行失败并给原因", br[4].status === "failed" && String(br[4].reason || "").length > 0, batch.text);
const listAfter = await req("GET", "/api/v1/accounts?platform=kuaishou", undefined, token);
const two = (listAfter.data.accounts || []).filter((a) => a.account_id === "batch_two")[0];
check("批量添加的账号进列表且备注与默认名称在", !!two && two.remark === "搞笑达人" && two.name === "batch_two", listAfter.text);
const batchDy = await req("POST", "/api/v1/accounts/batch", {
  platform: "douyin",
  lines: ["https://v.douyin.com/abc123/", "https://www.douyin.com/user/MS4wLjABAAAAbatch"],
}, token);
check(
  "批量里短链行失败、完整链接行成功",
  batchDy.status === 200 && batchDy.data.summary.failed === 1 && batchDy.data.summary.added === 1 &&
    String(batchDy.data.results[0].reason || "").includes("请贴完整主页链接"),
  batchDy.text,
);
const batchXhs = await req("POST", "/api/v1/accounts/batch", {
  platform: "xiaohongshu",
  lines: ["https://www.xiaohongshu.com/user/profile/24charuserid1234567891?xsec_token=tok999&xsec_source=pc_user"],
}, token);
check("批量小红书行成功", batchXhs.status === 200 && batchXhs.data.summary.added === 1, batchXhs.text);
const listXhs = await req("GET", "/api/v1/accounts?platform=xiaohongshu", undefined, token);
const xhsAdded = (listXhs.data.accounts || []).filter((a) => a.account_id === "24charuserid1234567891")[0];
check("批量小红书链接去 token 后入库", !!xhsAdded && !String(xhsAdded.home_url).includes("xsec_token"), listXhs.text);
const logs = await req("GET", "/api/v1/operation-logs?action=account_batch_create", undefined, token);
check("批量添加写操作日志", logs.status === 200 && logs.data.total >= 1 && String(logs.data.logs[0].detail || "").includes("批量添加"), logs.text);

console.log(`\n== 结果：通过 ${passed}，失败 ${failed} ==`);
process.exit(failed === 0 ? 0 : 1);
