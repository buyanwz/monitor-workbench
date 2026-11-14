"use strict";
/* 监控账号工作台前端：纯 HTML/CSS/JS，无构建步骤，全离线。
   只调后端 /api/v1/* 真实接口，字段以 cloudflare/src 各 handler 为准，不编造字段、不写假数据。 */

var API_BASE = "/api/v1";
var TOKEN_KEY = "monitor_workbench_token";
var SIDEBAR_KEY = "monitor_workbench_sidebar_collapsed";
var PAGE_SIZE = 20;

var state = {
  token: null,
  page: "dashboard",
  me: null,
  accounts: null, // 账号列表缓存（GET /accounts 的 account 数组）
  worksById: {}, // 当前作品列表的 id -> work，供下载确认框用
  lastPreviewUrls: null,
};

var ui = {
  works: { platform: "", account_id: "", date: "", downloaded: "", sort: "published_desc", page: 1 },
  tasks: { collect_date: "", status: "", account_id: "", page: 1 },
  notifications: { type: "", unread_only: false, page: 1 },
  logs: { action: "", page: 1 },
  cleanup: { page: 1 },
};

/* ---------------- 枚举文案（取值以后端代码为准，未知值原样显示） ---------------- */
function labelOf(map, value, fallback) {
  if (value === null || value === undefined || value === "") return fallback || "—";
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : String(value);
}
var PLATFORM_LABEL = { kuaishou: "快手", douyin: "抖音", xiaohongshu: "小红书" };
var ACCOUNT_STATUS_LABEL = { active: "启用", disabled: "停用" };
var LOGIN_STATE_LABEL = { ok: "已配置", missing: "未配置", expired: "已失效" };
var HEALTH_LABEL = { normal: "正常", invalid: "失效", risk: "风控", failing: "连续失败" };
var TASK_STATUS_LABEL = { waiting: "等待", running: "运行中", success: "成功", partial: "部分失败", failed: "失败" };
var TRIGGER_LABEL = { scheduled: "定时", manual: "手动", backfill: "补采", retry: "重试" };
var ERROR_CODE_LABEL = {
  login_expired: "登录失效", captcha: "验证码", rate_limit: "限流",
  banned: "封禁", deleted: "作品已删除", network: "网络失败", other: "其他",
};
var NOTIFY_TYPE_LABEL = {
  collect_failed: "采集失败", account_invalid: "账号失效", risk_control: "风控",
  failing_streak: "连续失败", storage_warning: "存储不足警告", storage_critical: "存储严重不足",
  file_too_large: "文件过大", task_timeout: "任务超时",
  login_expiry_warning: "登录态过期提醒", cleanup_done: "清理完成",
  collect_skipped: "跳过图文作品",
};
var FILE_STATUS_LABEL = { ok: "文件齐全", missing: "文件缺失" };
var KIND_LABEL = { video: "视频", cover: "封面", txt: "文案", zip: "压缩包" };
var SORT_LABEL = { likes_desc: "点赞从高到低", published_desc: "发布时间从新到旧" };
var REASON_LABEL = { expired: "已过期" };
var ACTION_LABEL = {
  auth_setup: "设置口令", auth_login: "登录", auth_change_password: "修改口令",
  account_create: "新增账号", account_update: "更新账号", account_disable: "停用账号",
  account_enable: "启用账号", account_delete: "删除账号", account_health_reset: "重置健康状态",
  login_state_update: "配置登录态", collect_trigger: "触发采集", collect_retry: "重试任务",
  backfill: "漏跑补采", intake: "手动上报", download: "下载", cleanup: "清理",
  backup: "备份导出", config_change: "修改配置",
  browser_login_open: "打开浏览器登录窗口", intake_token_rotate: "轮换上报令牌",
};
var KNOWN_ACTIONS = Object.keys(ACTION_LABEL);

/* ---------------- 通用小件 ---------------- */
function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function fmtParts(ms) {
  var parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  var get = function (t) { var p = parts.filter(function (x) { return x.type === t; })[0]; return p ? p.value : ""; };
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}
/* 毫秒时间戳 -> 北京时间 YYYY-MM-DD HH:mm:ss（与后端 shanghaiDateTime 同口径） */
function fmtDateTime(ms) {
  if (ms === null || ms === undefined || ms === "" || isNaN(Number(ms))) return "—";
  var p = fmtParts(Number(ms));
  return p.y + "-" + p.mo + "-" + p.d + " " + p.h + ":" + p.mi + ":" + p.s;
}
function fmtDate(ms) {
  if (ms === null || ms === undefined || ms === "" || isNaN(Number(ms))) return "—";
  var p = fmtParts(Number(ms));
  return p.y + "-" + p.mo + "-" + p.d;
}
function beijingToday() { return fmtDate(Date.now()); }
function beijingFileStamp(ms) {
  var p = fmtParts(ms);
  return p.y + p.mo + p.d + "_" + p.h + p.mi + p.s;
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " 字节";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
function fmtCount(n) { return String(Number(n) || 0); }

function toast(msg, kind) {
  var root = $("#toast-root");
  var el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " toast-error" : kind === "success" ? " toast-success" : "");
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(function () { el.remove(); }, 5000);
}

/* 按钮防重复点：执行期间禁用并显示“处理中…” */
async function withBusy(btn, fn) {
  if (!btn || btn.disabled) return;
  var old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "处理中…";
  try { await fn(); }
  finally { btn.disabled = false; btn.textContent = old; }
}

function badgeClassForTaskStatus(s) {
  return s === "success" ? "badge-green" : s === "failed" ? "badge-red" : s === "partial" ? "badge-amber" : s === "running" ? "badge-blue" : "badge-gray";
}
function badgeClassForHealth(h) {
  return h === "normal" ? "badge-green" : h === "invalid" || h === "failing" ? "badge-red" : h === "risk" ? "badge-amber" : "badge-gray";
}
function badgeClassForLoginState(s) {
  return s === "ok" ? "badge-green" : s === "expired" ? "badge-red" : "badge-gray";
}

/* ---------------- 请求层 ---------------- */
function ApiError(status, message) {
  this.status = status;
  this.message = message;
}

/* 所有接口返回 {ok:false, error:"大白话"} 时，直接用后端的 error 文案展示。 */
async function api(method, path, body, opts) {
  opts = opts || {};
  var headers = { "Content-Type": "application/json" };
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  var res;
  try {
    res = await fetch(API_BASE + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, "连不上本机服务，请确认服务已启动后再试");
  }
  var text = await res.text();
  var data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  if (res.status === 401 && !opts.skipAuthRedirect) {
    var msg = (data && data.error) || "未登录或会话已过期，请重新登录";
    state.token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    showAuth("login", msg);
    throw new ApiError(401, msg);
  }
  if (!res.ok || (data && data.ok === false)) {
    throw new ApiError(res.status, (data && data.error) || ("请求失败（" + res.status + "），请稍后再试"));
  }
  return data || {};
}

async function loadAccounts(force) {
  if (state.accounts && !force) return state.accounts;
  var data = await api("GET", "/accounts");
  state.accounts = data.accounts || [];
  return state.accounts;
}
function accountOptions(selectedId, includeAll) {
  var html = includeAll ? '<option value="">全部账号</option>' : '<option value="">请选择账号</option>';
  (state.accounts || []).forEach(function (a) {
    html += '<option value="' + a.id + '"' + (String(a.id) === String(selectedId) ? " selected" : "") + ">" +
      esc(a.name) + "（" + esc(labelOf(PLATFORM_LABEL, a.platform)) + "）</option>";
  });
  return html;
}
function platformOptions(selected) {
  var seen = {};
  var html = '<option value="">全部平台</option>';
  (state.accounts || []).forEach(function (a) {
    if (seen[a.platform]) return;
    seen[a.platform] = true;
    html += '<option value="' + esc(a.platform) + '"' + (a.platform === selected ? " selected" : "") + ">" +
      esc(labelOf(PLATFORM_LABEL, a.platform)) + "</option>";
  });
  return html;
}

/* ---------------- 弹窗 / 抽屉 ---------------- */
function closeModal() { $("#modal-root").innerHTML = ""; }
function openModal(html) {
  var root = $("#modal-root");
  root.innerHTML = '<div class="modal-overlay"><div class="modal" role="dialog" aria-modal="true">' + html + "</div></div>";
  var overlay = root.firstChild;
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });
  return overlay;
}
function confirmDialog(opts) {
  return new Promise(function (resolve) {
    var overlay = openModal(
      '<div class="modal-head"><h2>' + esc(opts.title) + "</h2>" +
      '<button type="button" class="icon-btn" data-close aria-label="关闭">✕</button></div>' +
      '<div>' + opts.bodyHtml + "</div>" +
      '<div class="modal-foot"><button type="button" class="btn" data-close>取消</button>' +
      '<button type="button" class="btn ' + (opts.danger ? "btn-danger" : "btn-primary") + '" data-ok>' + esc(opts.confirmText || "确定") + "</button></div>"
    );
    function done(v) { closeModal(); resolve(v); }
    overlay.querySelector("[data-ok]").addEventListener("click", function () { done(true); });
    $all("[data-close]", overlay).forEach(function (b) { b.addEventListener("click", function () { done(false); }); });
  });
}
function closeDrawer() {
  var root = $("#drawer-root");
  $all("video", root).forEach(function (v) { try { v.pause(); } catch (e) {} });
  root.innerHTML = "";
}
function openDrawer(html) {
  var root = $("#drawer-root");
  root.innerHTML = '<div class="drawer-overlay"><div class="drawer" role="dialog" aria-modal="true">' + html + "</div></div>";
  var overlay = root.firstChild;
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closeDrawer(); });
  return overlay;
}
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") { closeDrawer(); closeModal(); }
});

/* 分页条：page/total/page_size 均取后端返回 */
function pagerHtml(page, total, pageSize) {
  var totalPages = Math.max(1, Math.ceil(total / pageSize));
  return '<div class="pager"><button type="button" class="btn btn-sm" data-goto="' + (page - 1) + '"' + (page <= 1 ? " disabled" : "") + ">上一页</button>" +
    '<button type="button" class="btn btn-sm" data-goto="' + (page + 1) + '"' + (page >= totalPages ? " disabled" : "") + ">下一页</button>" +
    '<span class="pager-info">第 ' + page + " 页 / 共 " + totalPages + " 页，共 " + total + " 条</span></div>";
}
function errorBoxHtml(msg) {
  return '<div class="alert alert-error">' + esc(msg) + '</div><div class="btn-row"><button type="button" class="btn" data-action="reload-page">重新加载</button></div>';
}

/* ---------------- 鉴权视图 ---------------- */
function showAuth(mode, notice) {
  $("#app-view").hidden = true;
  $("#auth-view").hidden = false;
  document.title = "监控账号工作台";
  var setupForm = $("#setup-form");
  var loginForm = $("#login-form");
  var errBox = $("#auth-error");
  setupForm.hidden = mode !== "setup";
  loginForm.hidden = mode !== "login";
  $("#auth-sub").textContent = mode === "setup" ? "第一次打开，先设置访问口令" : "请输入访问口令";
  if (notice) { errBox.textContent = notice; errBox.hidden = false; }
  else { errBox.hidden = true; errBox.textContent = ""; }
}
function enterApp(me) {
  state.me = me || null;
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
  $("#me-label").textContent = me && me.actor ? "操作人：" + me.actor : "";
  refreshUnread();
  navigate(state.page || "dashboard", true);
}

async function refreshUnread() {
  try {
    var data = await api("GET", "/notifications?page=1&page_size=1");
    var n = Number(data.unread_count) || 0;
    var badge = $("#nav-unread-badge");
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = n <= 0;
  } catch (e) { /* 未读数拿不到不挡主流程 */ }
}

function bindAuthForms() {
  $("#setup-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var errBox = $("#auth-error");
    errBox.hidden = true;
    var fd = new FormData(e.target);
    var p1 = String(fd.get("password") || "");
    var p2 = String(fd.get("password2") || "");
    if (p1.length < 8) { errBox.textContent = "口令至少 8 位"; errBox.hidden = false; return; }
    if (p1 !== p2) { errBox.textContent = "两次输入的口令不一致"; errBox.hidden = false; return; }
    var btn = e.target.querySelector('button[type="submit"]');
    await withBusy(btn, async function () {
      try {
        var data = await api("POST", "/auth/setup", { password: p1 }, { skipAuthRedirect: true });
        state.token = data.token;
        try { localStorage.setItem(TOKEN_KEY, data.token); } catch (err) {}
        enterApp({ actor: "本人", setup_done: true });
        toast("口令已设置", "success");
      } catch (err) {
        errBox.textContent = err.message; errBox.hidden = false;
      }
    });
  });
  $("#login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var errBox = $("#auth-error");
    errBox.hidden = true;
    var fd = new FormData(e.target);
    var btn = e.target.querySelector('button[type="submit"]');
    await withBusy(btn, async function () {
      try {
        var data = await api("POST", "/auth/login", { password: String(fd.get("password") || "") }, { skipAuthRedirect: true });
        state.token = data.token;
        try { localStorage.setItem(TOKEN_KEY, data.token); } catch (err) {}
        enterApp({ actor: "本人", setup_done: true });
        e.target.reset();
      } catch (err) {
        errBox.textContent = err.message; errBox.hidden = false;
      }
    });
  });
  $("#logout-btn").addEventListener("click", async function () {
    try { await api("POST", "/auth/logout", {}, { skipAuthRedirect: true }); } catch (e) {}
    state.token = null;
    state.accounts = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    closeDrawer(); closeModal();
    showAuth("login");
  });
}

/* ---------------- 导航与壳 ---------------- */
var PAGE_TITLES = {
  dashboard: "看板", accounts: "账号管理", tasks: "采集任务",
  works: "作品库", notifications: "通知中心", settings: "设置",
};
var PAGE_LOADERS = {};
function navigate(page, force) {
  if (!PAGE_LOADERS[page]) page = "dashboard";
  state.page = page;
  $all(".nav-item", $("#sidebar-nav")).forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-page") === page);
  });
  $("#page-title").textContent = PAGE_TITLES[page];
  $("#breadcrumb").textContent = "首页 / " + PAGE_TITLES[page];
  document.title = PAGE_TITLES[page] + " - 监控账号工作台";
  $("#app-view").classList.remove("drawer-open");
  $("#sidebar-overlay").hidden = true;
  closeDrawer();
  PAGE_LOADERS[page]();
}
function bindShell() {
  $all(".nav-item", $("#sidebar-nav")).forEach(function (b) {
    b.addEventListener("click", function () { navigate(b.getAttribute("data-page")); });
  });
  var shell = $("#app-view");
  try {
    if (localStorage.getItem(SIDEBAR_KEY) === "1") shell.classList.add("collapsed");
  } catch (e) {}
  $("#collapse-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    shell.classList.toggle("collapsed");
    try { localStorage.setItem(SIDEBAR_KEY, shell.classList.contains("collapsed") ? "1" : "0"); } catch (err) {}
  });
  $(".sidebar-head").addEventListener("click", function () {
    if (shell.classList.contains("collapsed") && window.innerWidth > 720) {
      shell.classList.remove("collapsed");
      try { localStorage.setItem(SIDEBAR_KEY, "0"); } catch (e) {}
    }
  });
  $("#menu-btn").addEventListener("click", function () {
    shell.classList.add("drawer-open");
    $("#sidebar-overlay").hidden = false;
  });
  $("#sidebar-overlay").addEventListener("click", function () {
    shell.classList.remove("drawer-open");
    $("#sidebar-overlay").hidden = true;
  });
  /* 页面内通用动作：集中委托，避免每次渲染重复绑定 */
  $("#page").addEventListener("click", function (e) {
    var t = e.target.closest('[data-action="reload-page"]');
    if (t) { PAGE_LOADERS[state.page](); return; }
    if (e.target.closest("[data-acc]")) { onAccountsClick(e); return; }
    if (e.target.closest("[data-task]")) { onTasksClick(e); return; }
    if (e.target.closest("[data-work]")) { onWorksClick(e); return; }
    if (e.target.closest("[data-notify]")) { onNotifyClick(e); return; }
    if (e.target.closest("[data-setting]")) { onSettingsClick(e); return; }
  });
}

/* ================= 看板：GET /dashboard ================= */
PAGE_LOADERS.dashboard = async function () {
  var page = $("#page");
  page.innerHTML = '<div class="loading">正在加载看板…</div>';
  try {
    var d = await api("GET", "/dashboard");
    var t = d.tasks || {};
    var st = d.storage || {};
    var ratio = Number(st.usage_ratio) || 0;
    var pct = Math.round(ratio * 100);
    var barClass = ratio >= 0.95 ? "bar-fill danger" : ratio >= 0.8 ? "bar-fill warn" : "bar-fill";
    var health = d.health || {};
    var healthHtml = Object.keys(health).length === 0
      ? '<span class="muted">暂无启用账号</span>'
      : Object.keys(health).map(function (k) {
          return '<span class="badge ' + badgeClassForHealth(k) + '">' + esc(labelOf(HEALTH_LABEL, k)) + "：" + fmtCount(health[k]) + "</span>";
        }).join(" ");
    var notes = d.recent_notifications || [];
    var notesHtml = notes.length === 0
      ? '<div class="empty">暂无通知</div>'
      : notes.map(function (n) {
          var unread = n.is_read === 0 || n.is_read === false;
          return '<div class="notify-item"><span class="notify-dot' + (unread ? "" : " read") + '"></span><div class="notify-body">' +
            '<div class="notify-title">' + esc(n.title || "") + "</div>" +
            (n.detail ? '<div class="notify-detail">' + esc(n.detail) + "</div>" : "") +
            '<div class="notify-meta">' + esc(labelOf(NOTIFY_TYPE_LABEL, n.type)) + " · " + fmtDateTime(n.created_at) + "</div>" +
            "</div></div>";
        }).join("");
    page.innerHTML =
      '<div class="grid grid-stats">' +
        '<div class="card"><div class="stat-label">今日任务 · 成功</div><div class="stat-num">' + fmtCount(t.success) + '</div><div class="stat-sub">失败 ' + fmtCount(t.failed) + " · 等待 " + fmtCount(t.waiting) + "</div></div>" +
        '<div class="card"><div class="stat-label">今日任务 · 失败</div><div class="stat-num">' + fmtCount(t.failed) + '</div><div class="stat-sub">部分失败 ' + fmtCount(t.partial) + " · 运行中 " + fmtCount(t.running) + "</div></div>" +
        '<div class="card"><div class="stat-label">今日作品数</div><div class="stat-num">' + fmtCount(d.works_today) + '</div><div class="stat-sub">日期（北京时间）：' + esc(d.date || "") + "</div></div>" +
        '<div class="card"><div class="stat-label">24 小时内过期作品</div><div class="stat-num">' + fmtCount(d.expiring_soon_24h) + "</div><div class=\"stat-sub\">过期后文件会被清理</div></div>" +
      "</div>" +
      '<div class="card"><h2>存储占用</h2>' +
        '<div class="bar"><div class="' + barClass + '" style="width:' + Math.min(100, pct) + '%"></div></div>' +
        '<p class="muted" style="margin:10px 0 0">已用 ' + fmtBytes(st.used_bytes) + " / 配额 " + fmtBytes(st.quota_bytes) + "（" + pct + "%）</p></div>" +
      '<div class="card"><h2>账号健康分布（仅启用账号）</h2><div class="btn-row">' + healthHtml + "</div></div>" +
      '<div class="card"><div class="card-head"><h2>近期通知</h2><span class="muted small">未读 ' + fmtCount(d.unread_count) + ' 条</span></div>' + notesHtml +
        '<div class="btn-row" style="margin-top:12px"><button type="button" class="btn btn-sm" data-goto-page="notifications">去通知中心</button></div></div>' +
      '<p class="notice-text">合规提示：仅采集已授权账号；下载内容仅限内部使用，注意平台条款与版权。</p>';
    $all("[data-goto-page]", page).forEach(function (b) {
      b.addEventListener("click", function () { navigate(b.getAttribute("data-goto-page")); });
    });
  } catch (err) {
    page.innerHTML = errorBoxHtml(err.message);
  }
};

/* ================= 账号管理 =================
   GET /accounts · POST /accounts · GET /accounts/:id（编辑时取最新）
   PATCH /accounts/:id（只可改 name/home_url/remark）· DELETE /accounts/:id
   POST /accounts/:id/status · POST /accounts/:id/login-state · POST /accounts/:id/reset-health */
PAGE_LOADERS.accounts = async function () {
  var page = $("#page");
  page.innerHTML = '<div class="loading">正在加载账号…</div>';
  try {
    var accounts = await loadAccounts(true);
    /* 浏览器登录状态（按平台）：只作“采集登录来源”标注，与每账号的登录态徽标不混用；取不到就不标注 */
    var browser = null;
    try { browser = await api("GET", "/browser/status"); } catch (e) { browser = null; }
    function browserLoginText(platform) {
      if (!browser || !browser.available) return "";
      var st = (browser.platforms && browser.platforms[platform]) || null;
      var logged = st ? st.logged_in : (platform === "kuaishou" ? browser.logged_in : null);
      return '<div class="cell-sub">采集登录：' + (logged === true ? "浏览器已登录" : logged === false ? "浏览器未登录" : "未知") + "</div>";
    }
    var rows = accounts.map(function (a) {
      return "<tr>" +
        '<td><div class="cell-main">' + esc(a.name) + '</div><div class="cell-sub">' + esc(labelOf(PLATFORM_LABEL, a.platform)) + " · 账号 ID：" + esc(a.account_id) + "</div></td>" +
        '<td><a href="' + esc(a.home_url) + '" target="_blank" rel="noopener noreferrer">打开主页</a></td>' +
        "<td>" + esc(a.remark || "—") + "</td>" +
        '<td><span class="badge ' + (a.status === "active" ? "badge-green" : "badge-gray") + '">' + esc(labelOf(ACCOUNT_STATUS_LABEL, a.status)) + "</span></td>" +
        '<td><span class="badge ' + badgeClassForHealth(a.health) + '">' + esc(labelOf(HEALTH_LABEL, a.health)) + "</span>" +
          (Number(a.fail_streak) > 0 ? '<div class="cell-sub">连续失败 ' + fmtCount(a.fail_streak) + " 次</div>" : "") + "</td>" +
        '<td><span class="badge ' + badgeClassForLoginState(a.login_state_status) + '">' + esc(labelOf(LOGIN_STATE_LABEL, a.login_state_status)) + "</span>" +
          (a.login_state_updated_at ? '<div class="cell-sub">配置于 ' + fmtDateTime(a.login_state_updated_at) + "</div>" : "") +
          browserLoginText(a.platform) + "</td>" +
        '<td><div class="btn-row">' +
          '<button type="button" class="btn btn-sm" data-acc="edit" data-id="' + a.id + '">编辑</button>' +
          '<button type="button" class="btn btn-sm" data-acc="login-state" data-id="' + a.id + '">配置登录态</button>' +
          '<button type="button" class="btn btn-sm" data-acc="toggle" data-id="' + a.id + '" data-status="' + esc(a.status) + '">' + (a.status === "active" ? "停用" : "启用") + "</button>" +
          (a.health !== "normal" ? '<button type="button" class="btn btn-sm" data-acc="reset-health" data-id="' + a.id + '">恢复正常</button>' : "") +
          '<button type="button" class="btn btn-sm btn-danger" data-acc="delete" data-id="' + a.id + '">删除</button>' +
        "</div></td></tr>";
    }).join("");
    page.innerHTML =
      '<div class="card"><div class="card-head"><h2>账号列表（共 ' + accounts.length + ' 个）</h2>' +
      '<button type="button" class="btn btn-primary" data-acc="new">新增账号</button></div>' +
      (accounts.length === 0
        ? '<div class="empty">还没有账号，点右上角“新增账号”添加一个吧。</div>'
        : '<div class="table-wrap"><table><thead><tr><th>账号</th><th>主页</th><th>备注</th><th>状态</th><th>健康</th><th>登录态</th><th>操作</th></tr></thead><tbody>' + rows + "</tbody></table></div>") +
      "</div>" +
      '<p class="notice-text">合规提示：仅采集已授权账号。登录态只显示“已配置 / 未配置 / 已失效”，原文永不回显；重新配置会覆盖旧的登录态。' +
      (browser && browser.available ? "浏览器采集模式下，采集用浏览器里对应平台的登录，见设置页「浏览器采集」。" : "") + "</p>";
  } catch (err) {
    page.innerHTML = errorBoxHtml(err.message);
  }
};
async function onAccountsClick(e) {
  var btn = e.target.closest("[data-acc]");
  if (!btn) return;
  var action = btn.getAttribute("data-acc");
  var id = Number(btn.getAttribute("data-id"));
  if (action === "new") { openAccountForm(null); return; }
  var acc = (state.accounts || []).filter(function (a) { return a.id === id; })[0];
  if (!acc && action !== "new") { toast("账号不存在，请刷新后再试", "error"); return; }
  if (action === "edit") {
    try {
      var data = await api("GET", "/accounts/" + id);
      openAccountForm(data.account);
    } catch (err) { toast(err.message, "error"); }
  } else if (action === "login-state") {
    openLoginStateForm(acc);
  } else if (action === "toggle") {
    var next = btn.getAttribute("data-status") === "active" ? "disabled" : "active";
    var ok = await confirmDialog({
      title: next === "disabled" ? "停用账号" : "启用账号",
      bodyHtml: "<p>确定要" + (next === "disabled" ? "停用" : "启用") + "账号“" + esc(acc.name) + "”吗？" +
        (next === "disabled" ? "停用后不再为它建新的采集任务。</p>" : "</p>"),
      confirmText: next === "disabled" ? "停用" : "启用",
    });
    if (!ok) return;
    await withBusy(btn, async function () {
      try {
        await api("POST", "/accounts/" + id + "/status", { status: next });
        toast("已" + (next === "disabled" ? "停用" : "启用"), "success");
        PAGE_LOADERS.accounts();
      } catch (err) { toast(err.message, "error"); }
    });
  } else if (action === "reset-health") {
    await withBusy(btn, async function () {
      try {
        await api("POST", "/accounts/" + id + "/reset-health");
        toast("健康状态已恢复正常", "success");
        PAGE_LOADERS.accounts();
      } catch (err) { toast(err.message, "error"); }
    });
  } else if (action === "delete") {
    var okDel = await confirmDialog({
      title: "删除账号",
      bodyHtml: "<p>确定要删除账号“" + esc(acc.name) + "”吗？已有作品或任务记录的账号无法删除，请改用停用。</p>",
      confirmText: "删除", danger: true,
    });
    if (!okDel) return;
    await withBusy(btn, async function () {
      try {
        await api("DELETE", "/accounts/" + id);
        toast("已删除", "success");
        PAGE_LOADERS.accounts();
      } catch (err) { toast(err.message, "error"); }
    });
  }
}
function openAccountForm(acc) {
  var isNew = !acc;
  var overlay = openModal(
    '<div class="modal-head"><h2>' + (isNew ? "新增账号" : "编辑账号") + "</h2>" +
    '<button type="button" class="icon-btn" data-close aria-label="关闭">✕</button></div>' +
    '<form id="account-form">' +
    '<div class="alert alert-error" id="account-form-error" hidden></div>' +
    '<label class="field"><span>平台</span>' +
      (isNew
        ? '<select name="platform"><option value="kuaishou">快手</option><option value="douyin">抖音</option><option value="xiaohongshu">小红书</option></select>'
        : '<input value="' + esc(labelOf(PLATFORM_LABEL, acc.platform)) + '" disabled>') +
    "</label>" +
    '<label class="field"><span>账号名称</span><input name="name" maxlength="100" required value="' + esc(isNew ? "" : acc.name) + '" placeholder="例如：某某账号"></label>' +
    '<label class="field"><span>主页链接</span><input name="home_url" maxlength="500" required value="' + esc(isNew ? "" : acc.home_url) + '" placeholder="粘贴账号主页链接"></label>' +
    (isNew
      ? '<label class="field"><span>平台账号 ID</span><input name="account_id" maxlength="200" required placeholder="平台上的账号 ID，同一平台下不能重复"></label>'
      : '<label class="field"><span>平台账号 ID（不可改）</span><input value="' + esc(acc.account_id) + '" disabled></label>') +
    '<label class="field"><span>备注（可空）</span><input name="remark" maxlength="500" value="' + esc(isNew ? "" : (acc.remark || "")) + '"></label>' +
    '<div class="modal-foot"><button type="button" class="btn" data-close>取消</button>' +
    '<button type="submit" class="btn btn-primary">' + (isNew ? "新增" : "保存") + "</button></div></form>"
  );
  $all("[data-close]", overlay).forEach(function (b) { b.addEventListener("click", closeModal); });
  $("#account-form", overlay).addEventListener("submit", async function (e) {
    e.preventDefault();
    var errBox = $("#account-form-error", overlay);
    errBox.hidden = true;
    var fd = new FormData(e.target);
    var btn = e.target.querySelector('button[type="submit"]');
    await withBusy(btn, async function () {
      try {
        if (isNew) {
          await api("POST", "/accounts", {
            platform: String(fd.get("platform") || ""),
            name: String(fd.get("name") || ""),
            home_url: String(fd.get("home_url") || ""),
            account_id: String(fd.get("account_id") || ""),
            remark: String(fd.get("remark") || "") || null,
          });
          toast("账号已新增", "success");
        } else {
          await api("PATCH", "/accounts/" + acc.id, {
            name: String(fd.get("name") || ""),
            home_url: String(fd.get("home_url") || ""),
            remark: String(fd.get("remark") || "") || null,
          });
          toast("已保存", "success");
        }
        closeModal();
        PAGE_LOADERS.accounts();
      } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
    });
  });
}
function openLoginStateForm(acc) {
  var overlay = openModal(
    '<div class="modal-head"><h2>配置登录态</h2>' +
    '<button type="button" class="icon-btn" data-close aria-label="关闭">✕</button></div>' +
    '<form id="login-state-form">' +
    '<div class="alert alert-error" id="login-state-error" hidden></div>' +
    "<p>账号：<strong>" + esc(acc.name) + "</strong>（" + esc(labelOf(PLATFORM_LABEL, acc.platform)) + "）</p>" +
    '<p class="form-hint">粘贴登录态后会立即加密存在本机服务里，页面不回显原文。重新配置会覆盖旧的登录态，健康状态会恢复正常。</p>' +
    '<label class="field"><span>登录态</span><textarea name="login_state" required placeholder="粘贴登录态内容" autocomplete="off" spellcheck="false"></textarea></label>' +
    '<div class="modal-foot"><button type="button" class="btn" data-close>取消</button>' +
    '<button type="submit" class="btn btn-primary">保存（加密存储）</button></div></form>'
  );
  $all("[data-close]", overlay).forEach(function (b) { b.addEventListener("click", closeModal); });
  $("#login-state-form", overlay).addEventListener("submit", async function (e) {
    e.preventDefault();
    var errBox = $("#login-state-error", overlay);
    errBox.hidden = true;
    var fd = new FormData(e.target);
    var btn = e.target.querySelector('button[type="submit"]');
    await withBusy(btn, async function () {
      try {
        await api("POST", "/accounts/" + acc.id + "/login-state", { login_state: String(fd.get("login_state") || "") });
        toast("登录态已配置", "success");
        closeModal();
        PAGE_LOADERS.accounts();
      } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
    });
  });
}

/* ================= 采集任务 =================
   GET /tasks · GET /tasks/:id · POST /tasks/trigger · POST /tasks/:id/retry
   POST /tasks/backfill · POST /intake/report（手动上报） */
PAGE_LOADERS.tasks = async function () {
  var page = $("#page");
  page.innerHTML = '<div class="loading">正在加载任务…</div>';
  try {
    await loadAccounts();
    var f = ui.tasks;
    var qs = new URLSearchParams();
    if (f.collect_date) qs.set("collect_date", f.collect_date);
    if (f.status) qs.set("status", f.status);
    if (f.account_id) qs.set("account_id", f.account_id);
    qs.set("page", String(f.page));
    qs.set("page_size", String(PAGE_SIZE));
    var data = await api("GET", "/tasks?" + qs.toString());
    var tasks = data.tasks || [];
    var rows = tasks.map(function (t) {
      return "<tr>" +
        "<td>" + esc(t.collect_date || "—") + "</td>" +
        "<td>" + esc(t.account_name || ("账号 " + t.account_id)) + "</td>" +
        "<td>" + esc(labelOf(PLATFORM_LABEL, t.platform)) + "</td>" +
        '<td><span class="badge ' + badgeClassForTaskStatus(t.status) + '">' + esc(labelOf(TASK_STATUS_LABEL, t.status)) + "</span>" +
          (t.needs_review ? '<div class="cell-sub" style="color:var(--warn)">待人工核对</div>' : "") + "</td>" +
        "<td>" + esc(labelOf(TRIGGER_LABEL, t.trigger)) + "</td>" +
        "<td>" + fmtCount(t.retry_count) + " / " + fmtCount(t.max_retries) + "</td>" +
        "<td>" + (t.error_code ? esc(labelOf(ERROR_CODE_LABEL, t.error_code)) : "—") + "</td>" +
        "<td>" + fmtCount(t.collected_count) + "</td>" +
        '<td><div class="btn-row">' +
          '<button type="button" class="btn btn-sm" data-task="detail" data-id="' + t.id + '">详情</button>' +
          (t.status === "failed" ? '<button type="button" class="btn btn-sm" data-task="retry" data-id="' + t.id + '">重试</button>' : "") +
        "</div></td></tr>";
    }).join("");
    page.innerHTML =
      '<div class="card"><h2>手动采集</h2>' +
        '<div class="btn-row"><select id="trigger-account" class="inline-select" aria-label="选择账号">' + accountOptions("", false) + "</select>" +
        '<button type="button" class="btn btn-primary" data-task="trigger-one">采集选中账号</button>' +
        '<button type="button" class="btn" data-task="trigger-all">采集全部启用账号</button></div>' +
        '<p class="form-hint" style="margin:10px 0 0">同一天重复触发不会重复建任务。每天北京时间 8:00 会自动采集一次。</p></div>' +
      '<div class="card"><h2>漏跑补采</h2>' +
        '<div class="btn-row"><input type="date" id="backfill-date" class="inline-input" value="' + beijingToday() + '">' +
        '<button type="button" class="btn" data-task="backfill">补采这一天缺失的任务</button></div>' +
        '<p class="form-hint" style="margin:10px 0 0">补采只补建缺失的任务，不会重复建。</p></div>' +
      '<div class="card"><div class="card-head"><h2>任务列表</h2></div>' +
        '<div class="filters">' +
          '<label class="field"><span>采集日期</span><input type="date" id="task-filter-date" value="' + esc(f.collect_date) + '"></label>' +
          '<label class="field"><span>状态</span><select id="task-filter-status"><option value="">全部状态</option>' +
            ["waiting", "running", "success", "partial", "failed"].map(function (s) {
              return '<option value="' + s + '"' + (f.status === s ? " selected" : "") + ">" + esc(TASK_STATUS_LABEL[s]) + "</option>";
            }).join("") + "</select></label>" +
          '<label class="field"><span>账号</span><select id="task-filter-account">' + accountOptions(f.account_id, true) + "</select></label>" +
          '<button type="button" class="btn" data-task="clear-filters">重置筛选</button>' +
        "</div>" +
        (tasks.length === 0
          ? '<div class="empty">暂无任务。每天 8:00 自动采集，或在上面手动触发一次。</div>'
          : '<div class="table-wrap"><table><thead><tr><th>日期</th><th>账号</th><th>平台</th><th>状态</th><th>触发方式</th><th>重试</th><th>失败原因</th><th>入库数</th><th>操作</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
            pagerHtml(data.page, data.total, data.page_size)) +
      "</div>" +
      '<div class="card"><h2>手动上报</h2>' +
        '<p class="form-hint">自动采集失败时的兜底：选账号，粘贴作品 JSON 数组提交。上报只存作品信息，不下载视频文件；置顶作品会被跳过，重复上报不会产生重复作品。</p>' +
        '<form id="intake-form"><div class="alert alert-error" id="intake-error" hidden></div><div class="alert alert-success" id="intake-ok" hidden></div>' +
        '<label class="field"><span>账号</span><select name="account" required>' + accountOptions("", false) + "</select></label>" +
        '<label class="field"><span>作品 JSON 数组（1～50 条）</span><textarea name="works_json" class="json-textarea" required spellcheck="false" placeholder=\'[{"work_id":"作品ID","title":"标题","origin_url":"作品链接","published_at":1790000000000,"likes":123,"topics":["话题"],"is_pinned":false}]\'></textarea></label>' +
        '<p class="form-hint">每条必填：work_id、title、origin_url、published_at（毫秒时间戳，也可写日期文字如 2026-11-14 08:00:00）、likes。可选：topics（话题数组）、cover_url、video_url、is_pinned（置顶为 true 时会被跳过）。</p>' +
        '<div class="btn-row"><button type="submit" class="btn btn-primary">提交上报</button></div></form></div>';
    /* 筛选与分页 */
    $("#task-filter-date", page).addEventListener("change", function (e) { ui.tasks.collect_date = e.target.value; ui.tasks.page = 1; PAGE_LOADERS.tasks(); });
    $("#task-filter-status", page).addEventListener("change", function (e) { ui.tasks.status = e.target.value; ui.tasks.page = 1; PAGE_LOADERS.tasks(); });
    $("#task-filter-account", page).addEventListener("change", function (e) { ui.tasks.account_id = e.target.value; ui.tasks.page = 1; PAGE_LOADERS.tasks(); });
    $all("[data-goto]", page).forEach(function (b) {
      b.addEventListener("click", function () { ui.tasks.page = Number(b.getAttribute("data-goto")); PAGE_LOADERS.tasks(); });
    });
    $("#intake-form", page).addEventListener("submit", onIntakeSubmit);
  } catch (err) {
    page.innerHTML = errorBoxHtml(err.message);
  }
};
async function onTasksClick(e) {
  var btn = e.target.closest("[data-task]");
  if (!btn) return;
  var action = btn.getAttribute("data-task");
  if (action === "clear-filters") {
    ui.tasks = { collect_date: "", status: "", account_id: "", page: 1 };
    PAGE_LOADERS.tasks();
    return;
  }
  if (action === "trigger-one") {
    var sel = $("#trigger-account");
    var accountId = sel ? Number(sel.value) : NaN;
    if (!accountId) { toast("请先选择一个账号", "error"); return; }
    await withBusy(btn, async function () {
      try {
        var data = await api("POST", "/tasks/trigger", { account_id: accountId });
        toast(data.task ? "任务已建好（" + labelOf(TASK_STATUS_LABEL, data.task.status) + "），等待执行" : "已触发", "success");
        PAGE_LOADERS.tasks();
      } catch (err) { toast(err.message, "error"); }
    });
    return;
  }
  if (action === "trigger-all") {
    await withBusy(btn, async function () {
      try {
        var data = await api("POST", "/tasks/trigger", {});
        toast("已触发全部采集，新建 " + fmtCount(data.created) + " 个任务（" + esc(data.collect_date || "") + "）", "success");
        PAGE_LOADERS.tasks();
      } catch (err) { toast(err.message, "error"); }
    });
    return;
  }
  if (action === "backfill") {
    var dateInput = $("#backfill-date");
    await withBusy(btn, async function () {
      try {
        var data = await api("POST", "/tasks/backfill", { collect_date: dateInput ? dateInput.value : undefined });
        toast("补采完成，新建 " + fmtCount(data.created) + " 个任务（" + esc(data.collect_date || "") + "）", "success");
        PAGE_LOADERS.tasks();
      } catch (err) { toast(err.message, "error"); }
    });
    return;
  }
  var id = Number(btn.getAttribute("data-id"));
  if (action === "retry") {
    await withBusy(btn, async function () {
      try {
        await api("POST", "/tasks/" + id + "/retry");
        toast("已重新排队等待执行", "success");
        PAGE_LOADERS.tasks();
      } catch (err) { toast(err.message, "error"); }
    });
    return;
  }
  if (action === "detail") {
    try {
      var data = await api("GET", "/tasks/" + id);
      var t = data.task;
      openModal(
        '<div class="modal-head"><h2>任务详情</h2><button type="button" class="icon-btn" data-close aria-label="关闭">✕</button></div>' +
        (t.needs_review ? '<div class="alert alert-warn">待人工核对：没拿到置顶标记，未入库——这次采集返回的数据里没有置顶字段，无法确认哪些是置顶作品，所以整批都没有入库。等置顶标记确认后，重新采集即可。</div>' : "") +
        '<dl class="kv">' +
        "<dt>账号</dt><dd>" + esc(t.account_name || ("账号 " + t.account_id)) + "</dd>" +
        "<dt>平台</dt><dd>" + esc(labelOf(PLATFORM_LABEL, t.platform)) + "</dd>" +
        "<dt>采集日期</dt><dd>" + esc(t.collect_date || "—") + "</dd>" +
        "<dt>状态</dt><dd>" + esc(labelOf(TASK_STATUS_LABEL, t.status)) + "</dd>" +
        "<dt>触发方式</dt><dd>" + esc(labelOf(TRIGGER_LABEL, t.trigger)) + "</dd>" +
        "<dt>重试</dt><dd>" + fmtCount(t.retry_count) + " / " + fmtCount(t.max_retries) + "</dd>" +
        "<dt>入库作品</dt><dd>" + fmtCount(t.collected_count) + " 条</dd>" +
        "<dt>开始时间</dt><dd>" + fmtDateTime(t.started_at) + "</dd>" +
        "<dt>结束时间</dt><dd>" + fmtDateTime(t.finished_at) + "</dd>" +
        "<dt>失败分类</dt><dd>" + (t.error_code ? esc(labelOf(ERROR_CODE_LABEL, t.error_code)) : "—") + "</dd>" +
        "<dt>失败原因</dt><dd>" + esc(t.error_message || "—") + "</dd>" +
        (t.next_retry_at ? "<dt>下次重试</dt><dd>" + fmtDateTime(t.next_retry_at) + "</dd>" : "") +
        "</dl>" +
        '<div class="modal-foot"><button type="button" class="btn" data-close>关闭</button></div>'
      );
      $all("[data-close]").forEach(function (b) { b.addEventListener("click", closeModal); });
    } catch (err) { toast(err.message, "error"); }
  }
}
/* 手动上报：校验字段与 validIntakeWork 一致（必填 5 项），published_at 接受毫秒数或日期文字 */
function normalizeIntakeWorks(raw) {
  if (!Array.isArray(raw)) return { error: "粘贴的内容须为 JSON 数组" };
  if (raw.length === 0 || raw.length > 50) return { error: "作品须为 1～50 条" };
  var works = [];
  for (var i = 0; i < raw.length; i++) {
    var w = raw[i];
    var at = "第 " + (i + 1) + " 条";
    if (!w || typeof w !== "object" || Array.isArray(w)) return { error: at + "：须为对象" };
    var workId = typeof w.work_id === "string" ? w.work_id.trim() : "";
    var title = typeof w.title === "string" ? w.title.trim() : "";
    var originUrl = typeof w.origin_url === "string" ? w.origin_url.trim() : "";
    if (!workId) return { error: at + "：work_id 不能为空" };
    if (!title) return { error: at + "：title 不能为空" };
    if (!originUrl) return { error: at + "：origin_url 不能为空" };
    var publishedAt = null;
    if (typeof w.published_at === "number" && Number.isInteger(w.published_at) && w.published_at >= 0) publishedAt = w.published_at;
    else if (typeof w.published_at === "string" && w.published_at.trim() !== "") {
      var s = w.published_at.trim();
      if (/^\d+$/.test(s)) publishedAt = Number(s);
      else { var parsed = Date.parse(s); if (!isNaN(parsed)) publishedAt = parsed; }
    }
    if (publishedAt === null) return { error: at + "：published_at 须为毫秒时间戳或日期文字" };
    var likes = null;
    if (typeof w.likes === "number" && Number.isInteger(w.likes) && w.likes >= 0) likes = w.likes;
    else if (typeof w.likes === "string" && /^\d+$/.test(w.likes.trim())) likes = Number(w.likes.trim());
    if (likes === null) return { error: at + "：likes 须为大于等于 0 的整数" };
    var item = { work_id: workId, title: title, origin_url: originUrl, published_at: publishedAt, likes: likes };
    if (Array.isArray(w.topics)) item.topics = w.topics.filter(function (t) { return typeof t === "string"; }).slice(0, 20);
    if (typeof w.cover_url === "string" && w.cover_url) item.cover_url = w.cover_url;
    if (typeof w.video_url === "string" && w.video_url) item.video_url = w.video_url;
    if (w.is_pinned === true) item.is_pinned = true;
    works.push(item);
  }
  return { works: works };
}
async function onIntakeSubmit(e) {
  e.preventDefault();
  var form = e.target;
  var errBox = $("#intake-error", form);
  var okBox = $("#intake-ok", form);
  errBox.hidden = true; okBox.hidden = true;
  var fd = new FormData(form);
  var accountId = Number(fd.get("account"));
  var acc = (state.accounts || []).filter(function (a) { return a.id === accountId; })[0];
  if (!acc) { errBox.textContent = "请先选择一个账号"; errBox.hidden = false; return; }
  var rawText = String(fd.get("works_json") || "");
  var parsed;
  try { parsed = JSON.parse(rawText); }
  catch (err) { errBox.textContent = "JSON 解析失败：请检查括号、引号是否成对"; errBox.hidden = false; return; }
  var norm = normalizeIntakeWorks(parsed);
  if (norm.error) { errBox.textContent = norm.error; errBox.hidden = false; return; }
  var btn = form.querySelector('button[type="submit"]');
  await withBusy(btn, async function () {
    try {
      /* 注意：intake 的 account_id 是平台账号 ID（字符串），不是数字主键 */
      var data = await api("POST", "/intake/report", { platform: acc.platform, account_id: acc.account_id, works: norm.works });
      okBox.textContent = "上报成功：新增 " + fmtCount(data.created) + " 条，更新 " + fmtCount(data.updated) + " 条，跳过置顶 " + fmtCount(data.skipped_pinned) + " 条。";
      okBox.hidden = false;
      form.querySelector('textarea[name="works_json"]').value = "";
    } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
  });
}

/* ================= 作品库 =================
   GET /works（分组＋排序＋筛选＋分页）· GET /downloads（下载记录）
   注意：列表接口不返回封面/视频直链（publicWork 无 cover_url/video_url），
   列表只显示封面占位，真实封面与视频须经 POST /works/:id/preview 拿签名链接。 */
PAGE_LOADERS.works = async function () {
  var page = $("#page");
  page.innerHTML = '<div class="loading">正在加载作品…</div>';
  try {
    await loadAccounts();
    var f = ui.works;
    var qs = new URLSearchParams();
    if (f.platform) qs.set("platform", f.platform);
    if (f.account_id) qs.set("account_id", f.account_id);
    if (f.date) qs.set("date", f.date);
    if (f.downloaded) qs.set("downloaded", f.downloaded);
    qs.set("sort", f.sort);
    qs.set("page", String(f.page));
    qs.set("page_size", String(PAGE_SIZE));
    var data = await api("GET", "/works?" + qs.toString());
    var groups = data.groups || [];
    state.worksById = {};
    groups.forEach(function (g) {
      (g.works || []).forEach(function (w) { state.worksById[w.id] = w; });
    });
    var groupsHtml = groups.map(function (g) {
      var cards = (g.works || []).map(function (w) { return workCardHtml(w); }).join("");
      return '<div class="group-title">' + esc(labelOf(PLATFORM_LABEL, g.platform)) + ' <span class="muted small">本页 ' + (g.works || []).length + " 条</span></div>" +
        '<div class="works-grid">' + cards + "</div>";
    }).join("");
    page.innerHTML =
      '<div class="card"><div class="btn-row" style="justify-content:space-between">' +
        '<div class="sort-switch" role="group" aria-label="组内排序">' +
          '<button type="button" data-sort-btn="likes_desc" class="' + (data.sort === "likes_desc" ? "active" : "") + '">点赞降序</button>' +
          '<button type="button" data-sort-btn="published_desc" class="' + (data.sort === "published_desc" ? "active" : "") + '">发布时间降序</button>' +
        "</div>" +
        '<span class="sort-note">当前排序：' + esc(labelOf(SORT_LABEL, data.sort)) + "（先按平台分组，组内按此规则排）</span>" +
      "</div></div>" +
      '<div class="card"><div class="filters">' +
        '<label class="field"><span>平台</span><select id="works-filter-platform">' + platformOptions(f.platform) + "</select></label>" +
        '<label class="field"><span>账号</span><select id="works-filter-account">' + accountOptions(f.account_id, true) + "</select></label>" +
        '<label class="field"><span>采集日期</span><input type="date" id="works-filter-date" value="' + esc(f.date) + '"></label>' +
        '<label class="field"><span>是否已下载</span><select id="works-filter-downloaded"><option value="">全部</option>' +
          '<option value="1"' + (f.downloaded === "1" ? " selected" : "") + '>已下载</option>' +
          '<option value="0"' + (f.downloaded === "0" ? " selected" : "") + '>未下载</option></select></label>' +
        '<button type="button" class="btn" data-work="clear-filters">重置筛选</button>' +
      "</div>" +
      (data.total === 0
        ? '<div class="empty">暂无作品。等每天 8:00 自动采集，或去“采集任务”里手动触发一次。</div>'
        : groupsHtml + pagerHtml(data.page, data.total, data.page_size)) +
      "</div>" +
      '<div class="card"><div class="card-head"><h2>最近下载记录</h2><button type="button" class="btn btn-sm" data-work="refresh-downloads">刷新</button></div><div id="downloads-box"><div class="loading">正在加载…</div></div></div>';
    $all("[data-sort-btn]", page).forEach(function (b) {
      b.addEventListener("click", function () {
        ui.works.sort = b.getAttribute("data-sort-btn");
        ui.works.page = 1;
        PAGE_LOADERS.works();
      });
    });
    $("#works-filter-platform", page).addEventListener("change", function (e) { ui.works.platform = e.target.value; ui.works.page = 1; PAGE_LOADERS.works(); });
    $("#works-filter-account", page).addEventListener("change", function (e) { ui.works.account_id = e.target.value; ui.works.page = 1; PAGE_LOADERS.works(); });
    $("#works-filter-date", page).addEventListener("change", function (e) { ui.works.date = e.target.value; ui.works.page = 1; PAGE_LOADERS.works(); });
    $("#works-filter-downloaded", page).addEventListener("change", function (e) { ui.works.downloaded = e.target.value; ui.works.page = 1; PAGE_LOADERS.works(); });
    $all("[data-goto]", page).forEach(function (b) {
      b.addEventListener("click", function () { ui.works.page = Number(b.getAttribute("data-goto")); PAGE_LOADERS.works(); });
    });
    renderDownloadRecords();
  } catch (err) {
    page.innerHTML = errorBoxHtml(err.message);
  }
};
function workCardHtml(w) {
  var topics = (w.topics || []).map(function (t) { return "#" + t; }).join(" ");
  return '<article class="work-card">' +
    '<div class="cover-box"><svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M10 9.5l5 2.5-5 2.5z"/></svg>' +
    "<span>" + (w.has_cover ? "封面已保存，点预览查看" : "暂无封面") + "</span></div>" +
    '<div class="work-body"><div class="work-title">' + esc(w.title || "") + "</div>" +
    (topics ? '<div class="work-topics">' + esc(topics) + "</div>" : "") +
    '<div class="work-meta"><span>' + esc(w.account_name || "—") + "</span><span>点赞 " + fmtCount(w.likes) + "</span></div>" +
    '<div class="work-meta"><span>发布：' + fmtDateTime(w.published_at) + "</span></div>" +
    '<div class="work-meta"><span>过期：' + fmtDateTime(w.expires_at) + "</span></div>" +
    '<div class="btn-row"><span class="badge ' + (w.downloaded ? "badge-green" : "badge-gray") + '">' + (w.downloaded ? "已下载" : "未下载") + "</span>" +
    '<span class="badge ' + (w.file_status === "ok" ? "badge-blue" : "badge-amber") + '">' + esc(labelOf(FILE_STATUS_LABEL, w.file_status)) + "</span></div>" +
    '<div class="work-foot"><button type="button" class="btn btn-sm btn-primary" data-work="preview" data-id="' + w.id + '">预览</button>' +
    '<button type="button" class="btn btn-sm" data-work="download" data-id="' + w.id + '">下载</button></div>' +
    "</div></article>";
}
async function renderDownloadRecords() {
  var box = $("#downloads-box");
  if (!box) return;
  try {
    var data = await api("GET", "/downloads?page=1&page_size=10");
    var records = data.records || [];
    if (records.length === 0) { box.innerHTML = '<div class="empty">暂无下载记录</div>'; return; }
    box.innerHTML = '<div class="table-wrap"><table><thead><tr><th>作品</th><th>下载人</th><th>下载时间</th><th>状态</th><th>失败原因</th></tr></thead><tbody>' +
      records.map(function (r) {
        return "<tr><td><div class=\"cell-main\">" + esc(r.title || "—") + '</div><div class="cell-sub">作品 ID：' + esc(r.platform_work_id || "") + "</div></td>" +
          "<td>" + esc(r.downloaded_by || "—") + "</td><td>" + fmtDateTime(r.downloaded_at) + "</td>" +
          '<td><span class="badge ' + (r.status === "success" ? "badge-green" : "badge-red") + '">' + (r.status === "success" ? "成功" : "失败") + "</span></td>" +
          "<td>" + esc(r.error_message || "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  } catch (err) {
    box.innerHTML = '<div class="alert alert-error">' + esc(err.message) + "</div>";
  }
}
async function onWorksClick(e) {
  var btn = e.target.closest("[data-work]");
  if (!btn) return;
  var action = btn.getAttribute("data-work");
  if (action === "clear-filters") {
    ui.works = { platform: "", account_id: "", date: "", downloaded: "", sort: ui.works.sort, page: 1 };
    PAGE_LOADERS.works();
    return;
  }
  if (action === "refresh-downloads") {
    await withBusy(btn, async function () { await renderDownloadRecords(); });
    return;
  }
  var id = Number(btn.getAttribute("data-id"));
  if (action === "preview") { openPreviewDrawer(id); return; }
  if (action === "download") {
    var work = state.worksById[id];
    if (!work) {
      try { var d = await api("GET", "/works/" + id); work = d.work; }
      catch (err) { toast(err.message, "error"); return; }
    }
    openDownloadDialog(work);
  }
}

/* ================= 预览抽屉：GET /works/:id ＋ POST /works/:id/preview ================= */
async function openPreviewDrawer(workId) {
  openDrawer('<div class="drawer-head"><h2>正在加载…</h2><button type="button" class="icon-btn" data-drawer-close aria-label="关闭">✕</button></div><div class="loading">正在拿预览链接…</div>');
  $all("[data-drawer-close]").forEach(function (b) { b.addEventListener("click", closeDrawer); });
  var settled = await Promise.allSettled([
    api("GET", "/works/" + workId),
    api("POST", "/works/" + workId + "/preview"),
  ]);
  var detail = settled[0].status === "fulfilled" ? settled[0].value : null;
  var preview = settled[1].status === "fulfilled" ? settled[1].value : null;
  var previewErr = settled[1].status === "rejected" ? settled[1].reason.message : null;
  if (!detail) {
    var msg = settled[0].status === "rejected" ? settled[0].reason.message : "加载失败";
    $("#drawer-root").innerHTML = '<div class="drawer-overlay"><div class="drawer"><div class="drawer-head"><h2>预览</h2><button type="button" class="icon-btn" data-drawer-close aria-label="关闭">✕</button></div>' +
      '<div class="alert alert-error">' + esc(msg) + "</div></div></div>";
    $all("[data-drawer-close]").forEach(function (b) { b.addEventListener("click", closeDrawer); });
    return;
  }
  var w = detail.work;
  var mediaHtml;
  if (preview && preview.video_url) {
    mediaHtml = '<video controls preload="metadata" src="' + esc(preview.video_url) + '"' +
      (preview.cover_url ? ' poster="' + esc(preview.cover_url) + '"' : "") + "></video>";
  } else if (preview && preview.cover_url) {
    mediaHtml = '<img class="preview-cover" src="' + esc(preview.cover_url) + '" alt="封面">' +
      '<p class="form-hint" style="margin-top:8px">暂无视频文件，仅显示封面。</p>';
  } else {
    mediaHtml = '<div class="alert alert-warn">' + esc(previewErr || "该作品暂无可预览的文件") + "</div>";
  }
  var assets = detail.assets || [];
  var assetsHtml = assets.length === 0 ? '<p class="muted">暂无已保存的文件。</p>' :
    '<div class="table-wrap"><table><thead><tr><th>文件</th><th>大小</th><th>过期时间</th></tr></thead><tbody>' +
    assets.map(function (a) {
      return "<tr><td>" + esc(labelOf(KIND_LABEL, a.kind)) + "</td><td>" + fmtBytes(a.size_bytes) + "</td><td>" + fmtDateTime(a.expires_at) + "</td></tr>";
    }).join("") + "</tbody></table></div>";
  var snaps = detail.snapshots || [];
  var snapsHtml = snaps.length === 0 ? "" :
    '<h3 style="margin-top:20px">点赞数记录</h3><div class="table-wrap"><table><thead><tr><th>点赞数</th><th>采集时间</th></tr></thead><tbody>' +
    snaps.map(function (s) { return "<tr><td>" + fmtCount(s.likes) + "</td><td>" + fmtDateTime(s.collected_at) + "</td></tr>"; }).join("") +
    "</tbody></table></div>";
  var topics = (w.topics || []).map(function (t) { return "#" + t; }).join(" ");
  openDrawer(
    '<div class="drawer-head"><h2>' + esc(w.title || "") + '</h2><button type="button" class="icon-btn" data-drawer-close aria-label="关闭">✕</button></div>' +
    mediaHtml +
    '<dl class="kv" style="margin-top:16px">' +
    "<dt>账号</dt><dd>" + esc(w.account_name || "—") + "（" + esc(labelOf(PLATFORM_LABEL, w.platform)) + "）</dd>" +
    "<dt>话题</dt><dd>" + esc(topics || "—") + "</dd>" +
    "<dt>点赞数</dt><dd>" + fmtCount(w.likes) + "</dd>" +
    "<dt>发布时间</dt><dd>" + fmtDateTime(w.published_at) + "</dd>" +
    "<dt>采集完成</dt><dd>" + fmtDateTime(w.collected_finished_at) + "</dd>" +
    "<dt>过期时间</dt><dd>" + fmtDateTime(w.expires_at) + "</dd>" +
    "<dt>文件状态</dt><dd>" + esc(labelOf(FILE_STATUS_LABEL, w.file_status)) +
      "（视频：" + (w.has_video ? "有" : "无") + "，封面：" + (w.has_cover ? "有" : "无") + "，压缩包：" + (w.has_zip ? "有" : "无") + "）</dd>" +
    "<dt>原链接</dt><dd>" + (w.origin_url ? '<a href="' + esc(w.origin_url) + '" target="_blank" rel="noopener noreferrer">打开原作品</a>' : "—") + "</dd>" +
    (preview ? "<dt>预览链接有效期</dt><dd>到 " + fmtDateTime(preview.expires_at) + "（北京时间）</dd>" : "") +
    "</dl>" +
    '<div class="btn-row" style="margin-top:16px"><button type="button" class="btn btn-primary" data-drawer-download>下载 ZIP</button></div>' +
    '<h3 style="margin-top:20px">已保存的文件</h3>' + assetsHtml + snapsHtml
  );
  $all("[data-drawer-close]").forEach(function (b) { b.addEventListener("click", closeDrawer); });
  var dlBtn = $("[data-drawer-download]");
  if (dlBtn) dlBtn.addEventListener("click", function () { openDownloadDialog(w); });
}

/* ================= 下载：POST /works/:id/download（须勾选仅限内部使用） ================= */
function openDownloadDialog(work) {
  var overlay = openModal(
    '<div class="modal-head"><h2>下载作品</h2><button type="button" class="icon-btn" data-close aria-label="关闭">✕</button></div>' +
    '<div class="alert alert-error" id="download-error" hidden></div>' +
    "<p>作品：<strong>" + esc(work.title || "") + "</strong></p>" +
    '<p class="form-hint">下载的是 ZIP 压缩包，解压后是一个文件夹，里面有视频和文案。链接有有效期，过期后请重新点下载。</p>' +
    '<p class="notice-text">合规提示：下载内容仅限内部使用，注意平台条款与版权。请勿外传、勿用于侵犯他人权益的用途。</p>' +
    '<label class="check-row"><input type="checkbox" id="confirm-internal-use"><span>我确认下载内容仅限内部使用</span></label>' +
    '<div class="modal-foot"><button type="button" class="btn" data-close>取消</button>' +
    '<button type="button" class="btn btn-primary" id="download-confirm" disabled>确认下载</button></div>'
  );
  $all("[data-close]", overlay).forEach(function (b) { b.addEventListener("click", closeModal); });
  var checkbox = $("#confirm-internal-use", overlay);
  var confirmBtn = $("#download-confirm", overlay);
  checkbox.addEventListener("change", function () { confirmBtn.disabled = !checkbox.checked; });
  confirmBtn.addEventListener("click", async function () {
    var errBox = $("#download-error", overlay);
    errBox.hidden = true;
    await withBusy(confirmBtn, async function () {
      try {
        var data = await api("POST", "/works/" + work.id + "/download", { confirm_internal_use: true });
        var a = document.createElement("a");
        a.href = data.download_url;
        a.download = data.filename || "download.zip";
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast("下载已开始，链接到 " + fmtDateTime(data.expires_at) + " 前有效", "success");
        closeModal();
        if (state.page === "works") PAGE_LOADERS.works();
      } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
    });
  });
}

/* ================= 通知中心：GET /notifications · POST mark-read / mark-all-read ================= */
PAGE_LOADERS.notifications = async function () {
  var page = $("#page");
  page.innerHTML = '<div class="loading">正在加载通知…</div>';
  try {
    var f = ui.notifications;
    var qs = new URLSearchParams();
    if (f.type) qs.set("type", f.type);
    if (f.unread_only) qs.set("unread_only", "1");
    qs.set("page", String(f.page));
    qs.set("page_size", String(PAGE_SIZE));
    var data = await api("GET", "/notifications?" + qs.toString());
    var list = data.notifications || [];
    var itemsHtml = list.map(function (n) {
      var unread = n.is_read === false || n.is_read === 0;
      return '<div class="notify-item"><span class="notify-dot' + (unread ? "" : " read") + '"></span><div class="notify-body">' +
        '<div class="notify-title">' + esc(n.title || "") + "</div>" +
        (n.detail ? '<div class="notify-detail">' + esc(n.detail) + "</div>" : "") +
        '<div class="notify-meta">' + esc(labelOf(NOTIFY_TYPE_LABEL, n.type)) +
        (n.account_name ? " · " + esc(n.account_name) : "") + " · " + fmtDateTime(n.created_at) + "</div></div>" +
        (unread ? '<button type="button" class="btn btn-sm" data-notify="mark-read" data-id="' + n.id + '">标已读</button>' : "") +
        "</div>";
    }).join("");
    page.innerHTML =
      '<div class="card"><div class="card-head"><h2>通知列表（未读 ' + fmtCount(data.unread_count) + ' 条）</h2>' +
      '<button type="button" class="btn" data-notify="mark-all-read">全部标已读</button></div>' +
      '<div class="filters">' +
        '<label class="field"><span>分类</span><select id="notify-filter-type"><option value="">全部分类</option>' +
          Object.keys(NOTIFY_TYPE_LABEL).map(function (t) {
            return '<option value="' + t + '"' + (f.type === t ? " selected" : "") + ">" + esc(NOTIFY_TYPE_LABEL[t]) + "</option>";
          }).join("") + "</select></label>" +
        '<label class="check-row" style="margin:0 0 2px"><input type="checkbox" id="notify-filter-unread"' + (f.unread_only ? " checked" : "") + '><span>只看未读</span></label>' +
      "</div>" +
      (list.length === 0 ? '<div class="empty">暂无通知</div>' : itemsHtml + pagerHtml(data.page, data.total, data.page_size)) +
      "</div>";
    $("#notify-filter-type", page).addEventListener("change", function (e) { ui.notifications.type = e.target.value; ui.notifications.page = 1; PAGE_LOADERS.notifications(); });
    $("#notify-filter-unread", page).addEventListener("change", function (e) { ui.notifications.unread_only = e.target.checked; ui.notifications.page = 1; PAGE_LOADERS.notifications(); });
    $all("[data-goto]", page).forEach(function (b) {
      b.addEventListener("click", function () { ui.notifications.page = Number(b.getAttribute("data-goto")); PAGE_LOADERS.notifications(); });
    });
  } catch (err) {
    page.innerHTML = errorBoxHtml(err.message);
  }
};
async function onNotifyClick(e) {
  var btn = e.target.closest("[data-notify]");
  if (!btn) return;
  var action = btn.getAttribute("data-notify");
  if (action === "mark-read") {
    var id = Number(btn.getAttribute("data-id"));
    await withBusy(btn, async function () {
      try {
        await api("POST", "/notifications/mark-read", { ids: [id] });
        refreshUnread();
        PAGE_LOADERS.notifications();
      } catch (err) { toast(err.message, "error"); }
    });
  } else if (action === "mark-all-read") {
    await withBusy(btn, async function () {
      try {
        await api("POST", "/notifications/mark-all-read");
        refreshUnread();
        toast("已全部标为已读", "success");
        PAGE_LOADERS.notifications();
      } catch (err) { toast(err.message, "error"); }
    });
  }
}

/* ================= 设置 =================
   GET /settings · PATCH /settings（collect_hour 不可改，提交时不带）
   GET /storage/usage · POST /cleanup/run · GET /cleanup/records
   GET /backup/export · GET /operation-logs · POST /auth/change-password */
var settingsOriginal = null;
PAGE_LOADERS.settings = async function () {
  var page = $("#page");
  page.innerHTML = '<div class="loading">正在加载设置…</div>';
  try {
    var data = await api("GET", "/settings");
    var s = data.settings || {};
    settingsOriginal = {
      retention_days: parseInt(s.retention_days, 10),
      download_link_ttl_minutes: parseInt(s.download_link_ttl_minutes, 10),
      max_concurrent_zip: parseInt(s.max_concurrent_zip, 10),
      collect_batch_size: parseInt(s.collect_batch_size, 10),
      storage_quota_bytes: parseInt(s.storage_quota_bytes, 10),
      login_state_warn_days: parseInt(s.login_state_warn_days, 10),
    };
    var quotaGb = settingsOriginal.storage_quota_bytes / 1024 / 1024 / 1024;
    page.innerHTML =
      '<div class="card"><h2>采集与下载配置</h2>' +
      '<form id="settings-form"><div class="alert alert-error" id="settings-error" hidden></div>' +
      '<label class="field"><span>保留天数（1～30 天，默认 3 天）</span><input type="number" name="retention_days" min="1" max="30" step="1" required value="' + settingsOriginal.retention_days + '"></label>' +
      '<p class="form-hint">改保留天数只对新采集的作品生效，已入库的作品按采集时的天数算过期时间。</p>' +
      '<label class="field"><span>下载链接有效期（5～120 分钟）</span><input type="number" name="download_link_ttl_minutes" min="5" max="120" step="1" required value="' + settingsOriginal.download_link_ttl_minutes + '"></label>' +
      '<label class="field"><span>ZIP 并发生成上限（1～10 个）</span><input type="number" name="max_concurrent_zip" min="1" max="10" step="1" required value="' + settingsOriginal.max_concurrent_zip + '"></label>' +
      '<label class="field"><span>每触发处理账号数（1～10 个）</span><input type="number" name="collect_batch_size" min="1" max="10" step="1" required value="' + settingsOriginal.collect_batch_size + '"></label>' +
      '<label class="field"><span>存储配额（GB，填 0 表示不限制）</span><input type="number" name="storage_quota_gb" min="0" step="0.5" required value="' + quotaGb + '"></label>' +
      '<label class="field"><span>登录态提醒天数（1～90 天）</span><input type="number" name="login_state_warn_days" min="1" max="90" step="1" required value="' + settingsOriginal.login_state_warn_days + '"></label>' +
      '<label class="field"><span>每天采集时间（北京时间，固定不可改）</span><input value="' + esc(String(s.collect_hour === undefined ? 8 : s.collect_hour)) + ':00" disabled></label>' +
      '<div class="btn-row"><button type="submit" class="btn btn-primary">保存配置</button></div></form></div>' +
      '<div class="card" id="browser-collect-card"><h2>浏览器采集</h2><div class="loading">正在加载…</div></div>' +
      '<div class="card"><div class="card-head"><h2>存储占用</h2><button type="button" class="btn" data-setting="run-cleanup">立即清理过期文件</button></div>' +
      '<div id="cleanup-result"></div><div id="storage-box"><div class="loading">正在加载…</div></div></div>' +
      '<div class="card"><h2>清理记录</h2><div id="cleanup-box"><div class="loading">正在加载…</div></div></div>' +
      '<div class="card"><h2>备份导出</h2><p class="form-hint">导出全部数据（账号、作品、任务、日志等）的 JSON 文件，方便留底。备份里不含登录会话与口令。</p>' +
      '<div class="btn-row"><button type="button" class="btn" data-setting="export-backup">导出备份 JSON</button></div></div>' +
      '<div class="card"><h2>操作日志</h2>' +
      '<div class="filters"><label class="field"><span>动作</span><select id="log-action-filter"><option value="">全部动作</option>' +
      KNOWN_ACTIONS.map(function (a) {
        return '<option value="' + a + '"' + (ui.logs.action === a ? " selected" : "") + ">" + esc(ACTION_LABEL[a]) + "</option>";
      }).join("") + "</select></label></div>" +
      '<div id="logs-box"><div class="loading">正在加载…</div></div></div>' +
      '<div class="card"><h2>修改访问口令</h2>' +
      '<form id="password-form"><div class="alert alert-error" id="password-error" hidden></div>' +
      '<label class="field"><span>旧口令</span><input type="password" name="old_password" autocomplete="current-password" required></label>' +
      '<label class="field"><span>新口令（至少 8 位）</span><input type="password" name="new_password" autocomplete="new-password" minlength="8" required></label>' +
      '<label class="field"><span>再输一次新口令</span><input type="password" name="new_password2" autocomplete="new-password" minlength="8" required></label>' +
      '<p class="form-hint">改完口令后，当前登录会失效，需要用新口令重新登录。</p>' +
      '<div class="btn-row"><button type="submit" class="btn btn-primary">修改口令</button></div></form></div>';
    $("#settings-form", page).addEventListener("submit", onSettingsSubmit);
    $("#password-form", page).addEventListener("submit", onPasswordSubmit);
    $("#log-action-filter", page).addEventListener("change", function (e) {
      ui.logs.action = e.target.value; ui.logs.page = 1; renderLogs();
    });
    renderStorageUsage();
    renderCleanupRecords();
    renderLogs();
    renderBrowserSection();
  } catch (err) {
    page.innerHTML = errorBoxHtml(err.message);
  }
};
/* 复制文本：优先剪贴板 API，不可用时回退到选中复制 */
async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}
/* 设置页「浏览器采集」区：按平台分块（登录状态 + 登录窗口按钮）+ 共用的上报地址与令牌 + 当前端口 */
var BROWSER_PLATFORMS = [
  { platform: "kuaishou", label: "快手", badgeId: "browser-login-badge", lastId: "browser-last-capture", btnId: "browser-login-btn" },
  { platform: "douyin", label: "抖音", badgeId: "browser-login-badge-douyin", lastId: "browser-last-capture-douyin", btnId: "browser-login-btn-douyin" },
  { platform: "xiaohongshu", label: "小红书", badgeId: "browser-login-badge-xiaohongshu", lastId: "browser-last-capture-xiaohongshu", btnId: "browser-login-btn-xiaohongshu" },
];
async function renderBrowserSection() {
  var card = $("#browser-collect-card");
  if (!card) return;
  try {
    var st = await api("GET", "/browser/status");
    if (!st.available) {
      card.innerHTML = "<h2>浏览器采集</h2>" +
        '<p class="form-hint">当前为命令行模式，没有内嵌浏览器，浏览器采集不可用。</p>';
      return;
    }
    var blocks = BROWSER_PLATFORMS.map(function (p) {
      return '<div class="browser-platform"><h3>' + p.label + "</h3>" +
        '<dl class="kv">' +
        "<dt>登录状态</dt><dd id=\"" + p.badgeId + "\">—</dd>" +
        "<dt>上次截获时间</dt><dd id=\"" + p.lastId + "\">—</dd>" +
        "</dl>" +
        '<div class="btn-row"><button type="button" class="btn btn-primary" id="' + p.btnId + '">打开' + p.label + '登录窗口</button></div></div>';
    }).join("");
    card.innerHTML =
      "<h2>浏览器采集</h2>" +
      blocks +
      '<dl class="kv">' +
      "<dt>本地服务端口</dt><dd id=\"browser-port\">—</dd>" +
      "</dl>" +
      '<p class="form-hint">点各平台的按钮打开对应登录窗口，在里面登录（验证码也在里面手动处理）。登录态存在程序自己的浏览器分区里，各平台互不干扰，重启程序还在。每天 8:00 采集时，程序用这个登录态打开账号主页截取数据。</p>' +
      '<div class="btn-row"><button type="button" class="btn" id="browser-status-refresh">刷新状态</button></div>' +
      '<div class="alert alert-error" id="browser-section-error" hidden></div>' +
      '<label class="field"><span>扩展上报地址（给扩展填这个地址）</span>' +
      '<div class="input-row"><input id="intake-report-url" readonly value=""><button type="button" class="btn btn-sm" id="copy-report-url">复制</button></div></label>' +
      '<label class="field"><span>上报令牌（只给上报接口用，不等于登录口令）</span>' +
      '<div class="input-row"><input id="intake-token-field" type="password" readonly value="" autocomplete="off" spellcheck="false"><button type="button" class="btn btn-sm" id="toggle-token-visible">显示</button><button type="button" class="btn btn-sm" id="copy-intake-token">复制</button><button type="button" class="btn btn-sm btn-danger" id="rotate-intake-token">轮换</button></div></label>' +
      '<p class="form-hint">令牌只在上报时作身份凭证。轮换后旧令牌立即失效，扩展里要同步换新的。</p>';
    var tokenValue = "";
    var errBox = $("#browser-section-error", card);
    function showBrowserError(msg) { errBox.textContent = msg; errBox.hidden = false; }
    function fillStatus(s) {
      BROWSER_PLATFORMS.forEach(function (p) {
        var pst = (s.platforms && s.platforms[p.platform]) || null;
        var logged = pst ? pst.logged_in : (p.platform === "kuaishou" ? s.logged_in : null);
        var last = pst ? pst.last_capture_at : (p.platform === "kuaishou" ? s.last_capture_at : null);
        var badge = $("#" + p.badgeId, card);
        if (badge) {
          badge.innerHTML = logged === true
            ? '<span class="badge badge-green">已登录</span>'
            : logged === false
              ? '<span class="badge badge-gray">未登录</span>'
              : '<span class="badge badge-gray">未知</span>';
        }
        var lastEl = $("#" + p.lastId, card);
        if (lastEl) lastEl.textContent = fmtDateTime(last);
      });
      var portEl = $("#browser-port", card);
      var port = s.port || (window.location.port ? Number(window.location.port) : null);
      if (portEl) portEl.textContent = port ? String(port) : "—";
      var addr = $("#intake-report-url", card);
      if (addr) addr.value = port ? "http://127.0.0.1:" + port + "/api/v1/intake/report" : "";
    }
    fillStatus(st);
    try {
      var tk = await api("GET", "/intake/token");
      tokenValue = tk.token || "";
      var tf = $("#intake-token-field", card);
      if (tf) tf.value = tokenValue;
    } catch (err) { showBrowserError("上报令牌取不到：" + err.message); }
    BROWSER_PLATFORMS.forEach(function (p) {
      $("#" + p.btnId, card).addEventListener("click", function () {
        var btn = this;
        errBox.hidden = true;
        withBusy(btn, async function () {
          try {
            await api("POST", "/browser/show-login", { platform: p.platform });
            toast("登录窗口已打开，请在里面登录" + p.label + "，登完点“刷新状态”", "success");
            /* 登录是人工操作，15 秒后自动刷新一次状态，免得用户反复点 */
            setTimeout(function () {
              if (!document.body.contains(card)) return;
              api("GET", "/browser/status").then(fillStatus).catch(function () {});
            }, 15000);
          } catch (err) { showBrowserError(err.message); }
        });
      });
    });
    $("#browser-status-refresh", card).addEventListener("click", function () {
      var btn = this;
      errBox.hidden = true;
      withBusy(btn, async function () {
        try { fillStatus(await api("GET", "/browser/status")); }
        catch (err) { showBrowserError(err.message); }
      });
    });
    $("#copy-report-url", card).addEventListener("click", async function () {
      try { await copyText($("#intake-report-url", card).value); toast("上报地址已复制", "success"); }
      catch (err) { showBrowserError("复制失败：" + err.message); }
    });
    $("#toggle-token-visible", card).addEventListener("click", function () {
      var tf = $("#intake-token-field", card);
      var showing = tf.type === "text";
      tf.type = showing ? "password" : "text";
      this.textContent = showing ? "显示" : "隐藏";
    });
    $("#copy-intake-token", card).addEventListener("click", async function () {
      if (!tokenValue) { showBrowserError("上报令牌还没取到，请稍后再试"); return; }
      try { await copyText(tokenValue); toast("上报令牌已复制", "success"); }
      catch (err) { showBrowserError("复制失败：" + err.message); }
    });
    $("#rotate-intake-token", card).addEventListener("click", async function () {
      var ok = await confirmDialog({
        title: "轮换上报令牌",
        bodyHtml: "<p>轮换后旧令牌立即失效，扩展里填的旧令牌就上报不上来了，要同步换新的。确定轮换吗？</p>",
        confirmText: "轮换", danger: true,
      });
      if (!ok) return;
      var btn = this;
      errBox.hidden = true;
      await withBusy(btn, async function () {
        try {
          var data = await api("POST", "/intake/token/rotate", {});
          tokenValue = data.token || "";
          var tf = $("#intake-token-field", card);
          if (tf) { tf.value = tokenValue; tf.type = "password"; }
          var tg = $("#toggle-token-visible", card);
          if (tg) tg.textContent = "显示";
          toast("上报令牌已轮换，记得同步换扩展里的令牌", "success");
        } catch (err) { showBrowserError(err.message); }
      });
    });
  } catch (err) {
    card.innerHTML = "<h2>浏览器采集</h2>" + errorBoxHtml(err.message);
  }
}
async function onSettingsSubmit(e) {
  e.preventDefault();
  var form = e.target;
  var errBox = $("#settings-error", form);
  errBox.hidden = true;
  var fd = new FormData(form);
  function intVal(name) {
    var v = Number(fd.get(name));
    return Number.isInteger(v) ? v : NaN;
  }
  var quotaGb = Number(fd.get("storage_quota_gb"));
  if (isNaN(quotaGb) || quotaGb < 0) { errBox.textContent = "存储配额须为大于等于 0 的数字"; errBox.hidden = false; return; }
  var next = {
    retention_days: intVal("retention_days"),
    download_link_ttl_minutes: intVal("download_link_ttl_minutes"),
    max_concurrent_zip: intVal("max_concurrent_zip"),
    collect_batch_size: intVal("collect_batch_size"),
    storage_quota_bytes: Math.round(quotaGb * 1024 * 1024 * 1024),
    login_state_warn_days: intVal("login_state_warn_days"),
  };
  var ranges = {
    retention_days: [1, 30, "保留天数"], download_link_ttl_minutes: [5, 120, "下载链接有效期"],
    max_concurrent_zip: [1, 10, "ZIP 并发生成上限"], collect_batch_size: [1, 10, "每触发处理账号数"],
    login_state_warn_days: [1, 90, "登录态提醒天数"],
  };
  for (var k in ranges) {
    var r = ranges[k];
    if (isNaN(next[k]) || next[k] < r[0] || next[k] > r[1]) {
      errBox.textContent = r[2] + "须为 " + r[0] + "～" + r[1] + " 的整数";
      errBox.hidden = false; return;
    }
  }
  /* 只提交改过的项（后端对“没有可更新的配置”会报 400）；collect_hour 固定，绝不提交 */
  var body = {};
  Object.keys(next).forEach(function (key) {
    if (next[key] !== settingsOriginal[key]) body[key] = next[key];
  });
  if (Object.keys(body).length === 0) { toast("没有改动，不用保存"); return; }
  var btn = form.querySelector('button[type="submit"]');
  await withBusy(btn, async function () {
    try {
      var data = await api("PATCH", "/settings", body);
      var s = data.settings || {};
      settingsOriginal = {
        retention_days: parseInt(s.retention_days, 10),
        download_link_ttl_minutes: parseInt(s.download_link_ttl_minutes, 10),
        max_concurrent_zip: parseInt(s.max_concurrent_zip, 10),
        collect_batch_size: parseInt(s.collect_batch_size, 10),
        storage_quota_bytes: parseInt(s.storage_quota_bytes, 10),
        login_state_warn_days: parseInt(s.login_state_warn_days, 10),
      };
      toast("配置已保存", "success");
      renderStorageUsage();
    } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
  });
}
async function onPasswordSubmit(e) {
  e.preventDefault();
  var form = e.target;
  var errBox = $("#password-error", form);
  errBox.hidden = true;
  var fd = new FormData(form);
  var oldP = String(fd.get("old_password") || "");
  var newP = String(fd.get("new_password") || "");
  var newP2 = String(fd.get("new_password2") || "");
  if (newP.length < 8) { errBox.textContent = "新口令至少 8 位"; errBox.hidden = false; return; }
  if (newP !== newP2) { errBox.textContent = "两次输入的新口令不一致"; errBox.hidden = false; return; }
  var btn = form.querySelector('button[type="submit"]');
  await withBusy(btn, async function () {
    try {
      await api("POST", "/auth/change-password", { old_password: oldP, new_password: newP });
      state.token = null;
      state.accounts = null;
      try { localStorage.removeItem(TOKEN_KEY); } catch (err) {}
      closeDrawer(); closeModal();
      showAuth("login", "口令已修改，请用新口令重新登录");
      toast("口令已修改，请重新登录", "success");
    } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
  });
}
async function renderStorageUsage() {
  var box = $("#storage-box");
  if (!box) return;
  try {
    var d = await api("GET", "/storage/usage");
    var ratio = Number(d.usage_ratio) || 0;
    var pct = Math.round(ratio * 100);
    var barClass = ratio >= 0.95 ? "bar-fill danger" : ratio >= 0.8 ? "bar-fill warn" : "bar-fill";
    var kinds = d.by_kind || [];
    var kindsHtml = kinds.length === 0 ? '<p class="muted">暂无已保存的文件。</p>' :
      '<div class="table-wrap"><table><thead><tr><th>文件类型</th><th>数量</th><th>占用</th></tr></thead><tbody>' +
      kinds.map(function (k) {
        return "<tr><td>" + esc(labelOf(KIND_LABEL, k.kind)) + "</td><td>" + fmtCount(k.count) + "</td><td>" + fmtBytes(k.bytes) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    box.innerHTML =
      '<div class="bar"><div class="' + barClass + '" style="width:' + Math.min(100, pct) + '%"></div></div>' +
      '<p class="muted" style="margin:10px 0">已用 ' + fmtBytes(d.used_bytes) + " / 配额 " + fmtBytes(d.quota_bytes) + "（" + pct + "%） · 24 小时内过期文件 " + fmtCount(d.expiring_soon_24h) + " 个</p>" +
      kindsHtml;
  } catch (err) {
    box.innerHTML = '<div class="alert alert-error">' + esc(err.message) + "</div>";
  }
}
async function renderCleanupRecords() {
  var box = $("#cleanup-box");
  if (!box) return;
  try {
    var qs = new URLSearchParams({ page: String(ui.cleanup.page), page_size: String(PAGE_SIZE) });
    var d = await api("GET", "/cleanup/records?" + qs.toString());
    var records = d.records || [];
    if (records.length === 0) { box.innerHTML = '<div class="empty">暂无清理记录</div>'; return; }
    box.innerHTML = '<div class="table-wrap"><table><thead><tr><th>作品 ID</th><th>文件类型</th><th>大小</th><th>原因</th><th>清理时间</th></tr></thead><tbody>' +
      records.map(function (r) {
        return "<tr><td>" + fmtCount(r.work_id) + "</td><td>" + esc(labelOf(KIND_LABEL, r.kind)) + "</td><td>" + fmtBytes(r.size_bytes) +
          "</td><td>" + esc(labelOf(REASON_LABEL, r.reason)) + "</td><td>" + fmtDateTime(r.created_at) + "</td></tr>";
      }).join("") + "</tbody></table></div>" + pagerHtml(d.page, d.total, d.page_size);
    $all("[data-goto]", box).forEach(function (b) {
      b.addEventListener("click", function () { ui.cleanup.page = Number(b.getAttribute("data-goto")); renderCleanupRecords(); });
    });
  } catch (err) {
    box.innerHTML = '<div class="alert alert-error">' + esc(err.message) + "</div>";
  }
}
async function renderLogs() {
  var box = $("#logs-box");
  if (!box) return;
  try {
    var qs = new URLSearchParams();
    if (ui.logs.action) qs.set("action", ui.logs.action);
    qs.set("page", String(ui.logs.page));
    qs.set("page_size", String(PAGE_SIZE));
    var d = await api("GET", "/operation-logs?" + qs.toString());
    var logs = d.logs || [];
    if (logs.length === 0) { box.innerHTML = '<div class="empty">暂无操作日志</div>'; return; }
    box.innerHTML = '<div class="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody>' +
      logs.map(function (l) {
        return "<tr><td style=\"white-space:nowrap\">" + fmtDateTime(l.created_at) + "</td><td>" + esc(l.actor || "—") + "</td>" +
          "<td>" + esc(labelOf(ACTION_LABEL, l.action)) + "</td>" +
          "<td>" + esc(l.target_type || "—") + (l.target_id !== null && l.target_id !== undefined ? " #" + l.target_id : "") + "</td>" +
          "<td>" + esc(l.detail || "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>" + pagerHtml(d.page, d.total, d.page_size);
    $all("[data-goto]", box).forEach(function (b) {
      b.addEventListener("click", function () { ui.logs.page = Number(b.getAttribute("data-goto")); renderLogs(); });
    });
  } catch (err) {
    box.innerHTML = '<div class="alert alert-error">' + esc(err.message) + "</div>";
  }
}
async function exportBackup(btn) {
  await withBusy(btn, async function () {
    var res;
    try {
      res = await fetch(API_BASE + "/backup/export", {
        headers: state.token ? { Authorization: "Bearer " + state.token } : {},
      });
    } catch (e) {
      toast("连不上本机服务，请确认服务已启动后再试", "error");
      return;
    }
    if (res.status === 401) {
      var msg = "未登录或会话已过期，请重新登录";
      try { var j = await res.clone().json(); if (j && j.error) msg = j.error; } catch (e) {}
      state.token = null;
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
      showAuth("login", msg);
      return;
    }
    if (!res.ok) {
      var em = "导出失败，请稍后再试";
      try { var ej = await res.json(); if (ej && ej.error) em = ej.error; } catch (e) {}
      toast(em, "error");
      return;
    }
    var blob = await res.blob();
    var filename = "monitor-backup-" + beijingFileStamp(Date.now()) + ".json";
    var disp = res.headers.get("Content-Disposition") || "";
    var m = /filename="?([^";]+)"?/.exec(disp);
    if (m) filename = m[1];
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    toast("备份已导出：" + filename, "success");
  });
}
async function onSettingsClick(e) {
  var btn = e.target.closest("[data-setting]");
  if (!btn) return;
  var action = btn.getAttribute("data-setting");
  if (action === "export-backup") { exportBackup(btn); return; }
  if (action === "run-cleanup") {
    var ok = await confirmDialog({
      title: "立即清理过期文件",
      bodyHtml: "<p>只删除已过期的文件（视频、封面、文案、压缩包），作品信息和日志不会删。确定现在清理吗？</p>",
      confirmText: "开始清理",
    });
    if (!ok) return;
    await withBusy(btn, async function () {
      try {
        var d = await api("POST", "/cleanup/run");
        var box = $("#cleanup-result");
        if (box) {
          box.innerHTML = '<div class="alert alert-success">清理完成：删除 ' + fmtCount(d.deleted_assets) + " 个过期文件（" + fmtBytes(d.deleted_bytes) +
            "），归档 " + fmtCount(d.pruned_logs) + " 条旧日志、" + fmtCount(d.pruned_notifications) + " 条旧通知、" + fmtCount(d.pruned_sessions) + " 个过期会话。</div>";
        }
        renderStorageUsage();
        ui.cleanup.page = 1;
        renderCleanupRecords();
      } catch (err) { toast(err.message, "error"); }
    });
  }
}

/* ================= 启动 ================= */
async function boot() {
  bindAuthForms();
  bindShell();
  try { state.token = localStorage.getItem(TOKEN_KEY); } catch (e) { state.token = null; }
  var st;
  try {
    st = await api("GET", "/auth/setup-status", undefined, { skipAuthRedirect: true });
  } catch (err) {
    showAuth("login", err.message);
    return;
  }
  if (!st.setup_done) { showAuth("setup"); return; }
  if (state.token) {
    try {
      var me = await api("GET", "/auth/me", undefined, { skipAuthRedirect: true });
      enterApp(me);
    } catch (err) {
      state.token = null;
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
      showAuth("login");
    }
  } else {
    showAuth("login");
  }
}
boot();
