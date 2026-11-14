// 监控账号工作台后端入口：本地 Node HTTP 服务（Electron 主进程内运行）。
// 由 Cloudflare Worker 版移植：fetch 路由与 runScheduled 逻辑一字未动，
// 仅去掉 Worker 的 scheduled 钩子（定时改由 scheduler.ts 程序内调度器驱动）。
// 设计文档：~/workspace/goals/kuaishou-benchmark-account-monitoring/files/监控账号Web工作台-设计文档.md
// 鉴权：除健康检查、口令设置/登录、签名文件下载外，全部接口须 Bearer 会话令牌。

import {
  handleBatchCreateAccounts,
  handleCreateAccount,
  handleDeleteAccount,
  handleGetAccount,
  handleListAccounts,
  handleResetHealth,
  handleSetAccountStatus,
  handleSetLoginState,
  handleUpdateAccount,
} from "./accounts";
import { handleChangePassword, handleLogin, handleLogout, handleMe, handleSetup, handleSetupStatus } from "./auth";
import { handleExportBackup, snapshotBackup } from "./backup";
import { handleBrowserStatus, handleShowLogin } from "./browser";
import { handleRunCleanup, handleListCleanupRecords, handleStorageUsage, runCleanup } from "./cleanup";
import { ensureDailyTasks, processPendingTasks } from "./collect";
import { handleDashboard } from "./dashboard";
import { authenticate, clientIp, err, json, rateLimit, unauthorized, type Env } from "./db";
import { handleGetIntakeToken, handleIntakeReport, handleRotateIntakeToken } from "./intake";
import { handleListNotifications, handleMarkAllRead, handleMarkRead } from "./notify";
import { handleGetSettings, handleListOperationLogs, handleUpdateSettings } from "./settings";
import { handleBackfill, handleGetTask, handleListTasks, handleRetryTask, handleTriggerCollect } from "./tasks";
import { handleGetWork, handleListWorks, handlePreview } from "./works";
import { handleFileDownload, handleListDownloadRecords, handleRequestDownload } from "./zip";
import { newNonce, signDownloadToken } from "./crypto";
import { readJsonBody, shanghaiDate } from "./util";
import { nowMs } from "./db";

const API_DOC = {
  ok: true,
  service: "monitor-workbench-server",
  protocol: "v1",
  endpoints: [
    "GET  /api/v1/health",
    "GET  /api/v1/auth/setup-status",
    "POST /api/v1/auth/setup {password}",
    "POST /api/v1/auth/login {password}",
    "POST /api/v1/auth/logout (Bearer)",
    "GET  /api/v1/auth/me (Bearer)",
    "POST /api/v1/auth/change-password {old_password, new_password} (Bearer)",
    "POST /api/v1/accounts (Bearer)",
    "POST /api/v1/accounts/batch {platform, lines} (Bearer)",
    "GET  /api/v1/accounts (Bearer)",
    "GET  /api/v1/accounts/:id (Bearer)",
    "PATCH /api/v1/accounts/:id (Bearer)",
    "DELETE /api/v1/accounts/:id (Bearer)",
    "POST /api/v1/accounts/:id/status {status} (Bearer)",
    "POST /api/v1/accounts/:id/login-state {login_state} (Bearer)",
    "POST /api/v1/accounts/:id/reset-health (Bearer)",
    "POST /api/v1/tasks/trigger {account_id?} (Bearer)",
    "POST /api/v1/tasks/:id/retry (Bearer)",
    "POST /api/v1/tasks/backfill {collect_date?} (Bearer)",
    "GET  /api/v1/tasks (Bearer)",
    "GET  /api/v1/tasks/:id (Bearer)",
    "GET  /api/v1/works (Bearer)",
    "GET  /api/v1/works/:id (Bearer)",
    "POST /api/v1/works/:id/preview (Bearer)",
    "POST /api/v1/works/:id/download {confirm_internal_use: true} (Bearer)",
    "GET  /api/v1/downloads (Bearer)",
    "GET  /api/v1/files/download?token=... (签名链接，无需 Bearer)",
    "POST /api/v1/cleanup/run (Bearer)",
    "GET  /api/v1/cleanup/records (Bearer)",
    "GET  /api/v1/storage/usage (Bearer)",
    "GET  /api/v1/notifications (Bearer)",
    "POST /api/v1/notifications/mark-read {ids} (Bearer)",
    "POST /api/v1/notifications/mark-all-read (Bearer)",
    "GET  /api/v1/settings (Bearer)",
    "PATCH /api/v1/settings (Bearer)",
    "GET  /api/v1/operation-logs (Bearer)",
    "GET  /api/v1/dashboard (Bearer)",
    "GET  /api/v1/backup/export (Bearer)",
    "POST /api/v1/intake/report (Bearer 会话或上报令牌)",
    "GET  /api/v1/intake/token (Bearer)",
    "POST /api/v1/intake/token/rotate (Bearer)",
    "GET  /api/v1/browser/status (Bearer)",
    "POST /api/v1/browser/show-login {platform?} (Bearer)",
  ],
};

function corsHeaders(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin) return {};
  const allowed = env.ALLOWED_ORIGIN ?? "*";
  return {
    "Access-Control-Allow-Origin": allowed === "*" ? "*" : allowed,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    Vary: "Origin",
  };
}

function withCors(env: Env, req: Request, res: Response): Response {
  const headers = corsHeaders(env, req);
  if (Object.keys(headers).length === 0) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

function parseId(path: string, pattern: RegExp): number | null {
  const m = pattern.exec(path);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Cron 分发（生产 scheduled handler 与测试端点共用）：按 cron 表达式走不同分支。 */
export async function runScheduled(env: Env, cron: string): Promise<Record<string, unknown>> {
  const today = shanghaiDate(nowMs());
  if (cron === "0 0 * * *") {
    const created = await ensureDailyTasks(env, today, "scheduled");
    return { cron, created, collect_date: today };
  }
  if (cron === "30 0 * * *") {
    const created = await ensureDailyTasks(env, today, "backfill");
    return { cron, created, collect_date: today };
  }
  if (cron === "0 3 * * *") {
    const summary = await runCleanup(env);
    const snapshotKey = await snapshotBackup(env);
    return { cron, ...summary, snapshotKey };
  }
  // 每分钟：处理待处理任务
  const { claimed } = await processPendingTasks(env);
  return { cron, claimed };
}

async function handleTestRunCron(env: Env, req: Request): Promise<Response> {
  if (env.TEST_MODE !== "1") return err("测试端点未启用", 404);
  if (!(await authenticate(env, req))) return unauthorized();
  const body = await readJsonBody(req);
  const cron = typeof body?.cron === "string" ? body.cron : "";
  if (!["0 0 * * *", "30 0 * * *", "0 3 * * *", "* * * * *"].includes(cron)) {
    return err("cron 表达式不在支持列表内", 400);
  }
  const result = await runScheduled(env, cron);
  return json({ ok: true, ...result });
}

async function handleTestIssueToken(env: Env, req: Request): Promise<Response> {
  if (env.TEST_MODE !== "1") return err("测试端点未启用", 404);
  if (!(await authenticate(env, req))) return unauthorized();
  if (!env.DOWNLOAD_SIGNING_KEY) return err("服务端未配置下载签名密钥", 500);
  const body = await readJsonBody(req);
  const assetId = typeof body?.asset_id === "number" ? body.asset_id : null;
  const expiresIn = typeof body?.expires_in_seconds === "number" ? body.expires_in_seconds : null;
  if (assetId === null || expiresIn === null) return err("asset_id 与 expires_in_seconds 必填", 400);
  const token = await signDownloadToken(env.DOWNLOAD_SIGNING_KEY, {
    asset_id: assetId,
    exp: nowMs() + expiresIn * 1000,
    nonce: newNonce(),
  });
  const url = new URL(req.url);
  return json({ ok: true, download_url: `${url.origin}/api/v1/files/download?token=${token}` });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    try {
      // CORS 预检
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env, req) });
      }
      // 常规限流：每 IP 每路由每分钟 60 次（健康检查与签名文件下载除外，文件下载另设宽限）
      const exempt = path === "/api/v1/health" || path === "/api/v1/files/download";
      if (path.startsWith("/api/v1/") && !exempt) {
        const routeKey = `${clientIp(req)}:${method}:${path.replace(/\/\d+/g, "/:id")}`;
        if (!rateLimit(routeKey, 60, 60_000)) {
          return withCors(env, req, err("请求太频繁，请稍后再试", 429));
        }
      }
      if (path === "/api/v1/files/download" && (method === "GET" || method === "HEAD")) {
        if (!rateLimit(`files:${clientIp(req)}`, 300, 60_000)) {
          return withCors(env, req, err("请求太频繁，请稍后再试", 429));
        }
      }

      let res: Response | null = null;
      if (path === "/api/v1/health" && method === "GET") res = json({ ok: true });
      else if (path === "/" && method === "GET") res = json(API_DOC);
      else if (path === "/api/v1/auth/setup-status" && method === "GET") res = await handleSetupStatus(env);
      else if (path === "/api/v1/auth/setup" && method === "POST") res = await handleSetup(env, req);
      else if (path === "/api/v1/auth/login" && method === "POST") res = await handleLogin(env, req);
      else if (path === "/api/v1/auth/logout" && method === "POST") res = await handleLogout(env, req);
      else if (path === "/api/v1/auth/me" && method === "GET") res = await handleMe(env, req);
      else if (path === "/api/v1/auth/change-password" && method === "POST") res = await handleChangePassword(env, req);
      else if (path === "/api/v1/accounts" && method === "POST") res = await handleCreateAccount(env, req);
      else if (path === "/api/v1/accounts/batch" && method === "POST") res = await handleBatchCreateAccounts(env, req);
      else if (path === "/api/v1/accounts" && method === "GET") res = await handleListAccounts(env, req);
      else if (path === "/api/v1/tasks/trigger" && method === "POST") res = await handleTriggerCollect(env, req);
      else if (path === "/api/v1/tasks/backfill" && method === "POST") res = await handleBackfill(env, req);
      else if (path === "/api/v1/tasks" && method === "GET") res = await handleListTasks(env, req);
      else if (path === "/api/v1/works" && method === "GET") res = await handleListWorks(env, req);
      else if (path === "/api/v1/downloads" && method === "GET") res = await handleListDownloadRecords(env, req);
      else if (path === "/api/v1/files/download" && (method === "GET" || method === "HEAD")) res = await handleFileDownload(env, req);
      else if (path === "/api/v1/cleanup/run" && method === "POST") res = await handleRunCleanup(env, req);
      else if (path === "/api/v1/cleanup/records" && method === "GET") res = await handleListCleanupRecords(env, req);
      else if (path === "/api/v1/storage/usage" && method === "GET") res = await handleStorageUsage(env, req);
      else if (path === "/api/v1/notifications" && method === "GET") res = await handleListNotifications(env, req);
      else if (path === "/api/v1/notifications/mark-read" && method === "POST") res = await handleMarkRead(env, req);
      else if (path === "/api/v1/notifications/mark-all-read" && method === "POST") res = await handleMarkAllRead(env, req);
      else if (path === "/api/v1/settings" && method === "GET") res = await handleGetSettings(env, req);
      else if (path === "/api/v1/settings" && method === "PATCH") res = await handleUpdateSettings(env, req);
      else if (path === "/api/v1/operation-logs" && method === "GET") res = await handleListOperationLogs(env, req);
      else if (path === "/api/v1/dashboard" && method === "GET") res = await handleDashboard(env, req);
      else if (path === "/api/v1/backup/export" && method === "GET") res = await handleExportBackup(env, req);
      else if (path === "/api/v1/intake/report" && method === "POST") res = await handleIntakeReport(env, req);
      else if (path === "/api/v1/intake/token" && method === "GET") res = await handleGetIntakeToken(env, req);
      else if (path === "/api/v1/intake/token/rotate" && method === "POST") res = await handleRotateIntakeToken(env, req);
      else if (path === "/api/v1/browser/status" && method === "GET") res = await handleBrowserStatus(env, req);
      else if (path === "/api/v1/browser/show-login" && method === "POST") res = await handleShowLogin(env, req);
      else if (path === "/api/v1/_test/run-cron" && method === "POST") res = await handleTestRunCron(env, req);
      else if (path === "/api/v1/_test/issue-token" && method === "POST") res = await handleTestIssueToken(env, req);
      else {
        const accountId = parseId(path, /^\/api\/v1\/accounts\/(\d+)$/);
        const taskId = parseId(path, /^\/api\/v1\/tasks\/(\d+)$/);
        const retryId = parseId(path, /^\/api\/v1\/tasks\/(\d+)\/retry$/);
        const workId = parseId(path, /^\/api\/v1\/works\/(\d+)$/);
        const previewId = parseId(path, /^\/api\/v1\/works\/(\d+)\/preview$/);
        const downloadId = parseId(path, /^\/api\/v1\/works\/(\d+)\/download$/);
        const statusId = parseId(path, /^\/api\/v1\/accounts\/(\d+)\/status$/);
        const loginStateId = parseId(path, /^\/api\/v1\/accounts\/(\d+)\/login-state$/);
        const resetHealthId = parseId(path, /^\/api\/v1\/accounts\/(\d+)\/reset-health$/);
        if (accountId !== null && method === "GET") res = await handleGetAccount(env, req, accountId);
        else if (accountId !== null && method === "PATCH") res = await handleUpdateAccount(env, req, accountId);
        else if (accountId !== null && method === "DELETE") res = await handleDeleteAccount(env, req, accountId);
        else if (statusId !== null && method === "POST") res = await handleSetAccountStatus(env, req, statusId);
        else if (loginStateId !== null && method === "POST") res = await handleSetLoginState(env, req, loginStateId);
        else if (resetHealthId !== null && method === "POST") res = await handleResetHealth(env, req, resetHealthId);
        else if (taskId !== null && method === "GET") res = await handleGetTask(env, req, taskId);
        else if (retryId !== null && method === "POST") res = await handleRetryTask(env, req, retryId);
        else if (workId !== null && method === "GET") res = await handleGetWork(env, req, workId);
        else if (previewId !== null && method === "POST") res = await handlePreview(env, req, previewId);
        else if (downloadId !== null && method === "POST") res = await handleRequestDownload(env, req, downloadId);
      }
      if (!res) res = err("接口不存在", 404);
      return withCors(env, req, res);
    } catch (e) {
      console.error("unhandled error", e);
      return withCors(env, req, err("服务端内部错误", 500));
    }
  },
};
