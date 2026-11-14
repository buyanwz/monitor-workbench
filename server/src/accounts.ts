// 账号管理：增删改查、停用/启用、登录态配置（AES-GCM 加密存储）、健康状态。
// 响应中永不含登录态原文与密文，只含状态（ok/missing/expired）。

import { encryptLoginState } from "./crypto";
import {
  authenticate,
  err,
  json,
  nowMs,
  opLog,
  unauthorized,
  type Env,
} from "./db";
import { optString, readJsonBody, reqString } from "./util";

export const PLATFORMS = ["kuaishou"] as const; // v1 只做快手（设计 A1）；后续平台加白名单即可
export const HEALTH_VALUES = ["normal", "invalid", "risk", "failing"] as const;

export interface AccountRow {
  id: number;
  platform: string;
  name: string;
  home_url: string;
  account_id: string;
  remark: string | null;
  status: string;
  login_state_status: string;
  login_state_updated_at: number | null;
  health: string;
  fail_streak: number;
  created_at: number;
  updated_at: number;
}

export function publicAccount(r: AccountRow) {
  return {
    id: r.id,
    platform: r.platform,
    name: r.name,
    home_url: r.home_url,
    account_id: r.account_id,
    remark: r.remark,
    status: r.status,
    login_state_status: r.login_state_status,
    login_state_updated_at: r.login_state_updated_at,
    health: r.health,
    fail_streak: r.fail_streak,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const ACCOUNT_SELECT =
  "id, platform, name, home_url, account_id, remark, status, login_state_status, login_state_updated_at, health, fail_streak, created_at, updated_at";

export async function handleCreateAccount(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const platform = reqString(body.platform, 32);
  const name = reqString(body.name, 100);
  const homeUrl = reqString(body.home_url, 500);
  const accountId = reqString(body.account_id, 200);
  const remark = optString(body.remark, 500);
  if (!platform || !(PLATFORMS as readonly string[]).includes(platform)) return err("平台不在支持范围内", 400);
  if (!name) return err("账号名称不能为空", 400);
  if (!homeUrl) return err("主页链接不能为空", 400);
  if (!accountId) return err("平台账号ID不能为空", 400);
  const now = nowMs();
  const res = await env.DB.prepare(
    "INSERT INTO monitor_account (platform, name, home_url, account_id, remark, status, login_state_status, health, fail_streak, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 'missing', 'normal', 0, ?, ?)",
  )
    .bind(platform, name, homeUrl, accountId, remark, now, now)
    .run()
    .catch((e: unknown) => {
      if (String(e).includes("UNIQUE")) return null;
      throw e;
    });
  if (!res) return err("该平台下已存在相同账号ID", 409);
  const id = res.meta.last_row_id as number;
  await opLog(env.DB, "account_create", "account", id, `新增账号 ${name}（${platform}）`);
  const row = await env.DB.prepare(`SELECT ${ACCOUNT_SELECT} FROM monitor_account WHERE id = ?`)
    .bind(id)
    .first<AccountRow>();
  return json({ ok: true, account: row ? publicAccount(row) : null }, 201);
}

export async function handleListAccounts(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform");
  const status = url.searchParams.get("status");
  const health = url.searchParams.get("health");
  let sql = `SELECT ${ACCOUNT_SELECT} FROM monitor_account WHERE 1=1`;
  const binds: unknown[] = [];
  if (platform) {
    sql += " AND platform = ?";
    binds.push(platform);
  }
  if (status) {
    sql += " AND status = ?";
    binds.push(status);
  }
  if (health) {
    sql += " AND health = ?";
    binds.push(health);
  }
  sql += " ORDER BY id ASC";
  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<AccountRow>();
  return json({ ok: true, accounts: (rows.results ?? []).map(publicAccount) });
}

export async function handleGetAccount(env: Env, req: Request, id: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const row = await env.DB.prepare(`SELECT ${ACCOUNT_SELECT} FROM monitor_account WHERE id = ?`)
    .bind(id)
    .first<AccountRow>();
  if (!row) return err("账号不存在", 404);
  return json({ ok: true, account: publicAccount(row) });
}

export async function handleUpdateAccount(env: Env, req: Request, id: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const existing = await env.DB.prepare("SELECT id FROM monitor_account WHERE id = ?").bind(id).first<{ id: number }>();
  if (!existing) return err("账号不存在", 404);
  const name = body.name === undefined ? undefined : reqString(body.name, 100);
  const homeUrl = body.home_url === undefined ? undefined : reqString(body.home_url, 500);
  const remark = body.remark === undefined ? undefined : optString(body.remark, 500);
  if (body.name !== undefined && !name) return err("账号名称不能为空", 400);
  if (body.home_url !== undefined && !homeUrl) return err("主页链接不能为空", 400);
  if (body.remark !== undefined && body.remark !== null && body.remark !== "" && remark === null) {
    return err("备注过长", 400);
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (name !== undefined) {
    sets.push("name = ?");
    binds.push(name);
  }
  if (homeUrl !== undefined) {
    sets.push("home_url = ?");
    binds.push(homeUrl);
  }
  if (remark !== undefined) {
    sets.push("remark = ?");
    binds.push(remark);
  }
  if (sets.length === 0) return err("没有可更新的字段", 400);
  sets.push("updated_at = ?");
  binds.push(nowMs(), id);
  await env.DB.prepare(`UPDATE monitor_account SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  await opLog(env.DB, "account_update", "account", id, "更新账号信息");
  const row = await env.DB.prepare(`SELECT ${ACCOUNT_SELECT} FROM monitor_account WHERE id = ?`)
    .bind(id)
    .first<AccountRow>();
  return json({ ok: true, account: row ? publicAccount(row) : null });
}

/** 停用/启用：status 在 active/disabled 间切换；停用账号不建新采集任务。 */
export async function handleSetAccountStatus(env: Env, req: Request, id: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const status = reqString(body.status, 20);
  if (status !== "active" && status !== "disabled") return err("status 只能是 active 或 disabled", 400);
  const existing = await env.DB.prepare("SELECT id FROM monitor_account WHERE id = ?").bind(id).first<{ id: number }>();
  if (!existing) return err("账号不存在", 404);
  await env.DB.prepare("UPDATE monitor_account SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, nowMs(), id)
    .run();
  await opLog(env.DB, status === "disabled" ? "account_disable" : "account_enable", "account", id, `账号状态改为 ${status}`);
  return json({ ok: true });
}

/** 配置登录态：立即 AES-GCM 加密存储，页面不回显原文；重新配置即覆盖。 */
export async function handleSetLoginState(env: Env, req: Request, id: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  if (!env.LOGIN_STATE_KEY) return err("服务端未配置登录态加密密钥", 500);
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const loginState = reqString(body.login_state, 20000);
  if (!loginState) return err("登录态不能为空", 400);
  const existing = await env.DB.prepare("SELECT id FROM monitor_account WHERE id = ?").bind(id).first<{ id: number }>();
  if (!existing) return err("账号不存在", 404);
  const enc = await encryptLoginState(loginState, env.LOGIN_STATE_KEY);
  const now = nowMs();
  await env.DB.prepare(
    "UPDATE monitor_account SET login_state_enc = ?, login_state_status = 'ok', login_state_updated_at = ?, health = 'normal', fail_streak = 0, updated_at = ? WHERE id = ?",
  )
    .bind(enc, now, now, id)
    .run();
  // 日志只记“已配置”，永不含登录态原文与密文
  await opLog(env.DB, "login_state_update", "account", id, "登录态已配置（加密存储）");
  return json({ ok: true, login_state_status: "ok" });
}

/** 手动重置健康状态（人工处理后恢复正常，fail_streak 清零）。 */
export async function handleResetHealth(env: Env, req: Request, id: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const existing = await env.DB.prepare("SELECT id FROM monitor_account WHERE id = ?").bind(id).first<{ id: number }>();
  if (!existing) return err("账号不存在", 404);
  await env.DB.prepare("UPDATE monitor_account SET health = 'normal', fail_streak = 0, updated_at = ? WHERE id = ?")
    .bind(nowMs(), id)
    .run();
  await opLog(env.DB, "account_health_reset", "account", id, "手动重置健康状态为正常");
  return json({ ok: true });
}

/** 删除账号：仅当该账号无作品与任务时允许（防误删历史数据）；否则请先停用。 */
export async function handleDeleteAccount(env: Env, req: Request, id: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const existing = await env.DB.prepare("SELECT id, name FROM monitor_account WHERE id = ?")
    .bind(id)
    .first<{ id: number; name: string }>();
  if (!existing) return err("账号不存在", 404);
  const workCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM work WHERE account_id = ?")
    .bind(id)
    .first<{ c: number }>();
  const taskCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM collect_task WHERE account_id = ?")
    .bind(id)
    .first<{ c: number }>();
  if ((workCount?.c ?? 0) > 0 || (taskCount?.c ?? 0) > 0) {
    return err("该账号已有作品或任务记录，无法删除，请改用停用", 409);
  }
  await env.DB.prepare("DELETE FROM monitor_account WHERE id = ?").bind(id).run();
  await opLog(env.DB, "account_delete", "account", id, `删除账号 ${existing.name}`);
  return json({ ok: true });
}
