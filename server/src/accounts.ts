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

export const PLATFORMS = ["kuaishou", "douyin", "xiaohongshu"] as const; // v0.3.0 起三平台（与 fetcher.ts 的 BROWSER_PLATFORMS 保持一致）
export const HEALTH_VALUES = ["normal", "invalid", "risk", "failing"] as const;

/**
 * 主页链接校验与归一（v0.3.0 已定保守默认）：
 * - 抖音短链（v.douyin.com）不接受：报“请贴完整主页链接”，不静默解析；
 * - 小红书链接去 xsec_token/xsec_source 参数再存（干净 URL，由页面自行补 token）；
 * - 其他平台原样存（仅去首尾空白）。
 */
export function normalizeHomeUrl(platform: string, homeUrl: string): { url: string } | { error: string } {
  const trimmed = homeUrl.trim();
  if (platform === "douyin") {
    let host = "";
    try {
      host = new URL(trimmed).hostname.toLowerCase();
    } catch {
      host = "";
    }
    if (host === "v.douyin.com" || host.endsWith(".v.douyin.com") || /(^|[/?#])v\.douyin\.com\//i.test(trimmed)) {
      return { error: "请贴完整主页链接（短链暂不支持）" };
    }
    return { url: trimmed };
  }
  if (platform === "xiaohongshu") {
    try {
      const u = new URL(trimmed);
      u.searchParams.delete("xsec_token");
      u.searchParams.delete("xsec_source");
      return { url: u.toString() };
    } catch {
      return { url: trimmed }; // 解析失败时原样存，不新增拒绝口径
    }
  }
  return { url: trimmed };
}

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
  const normalized = normalizeHomeUrl(platform, homeUrl);
  if ("error" in normalized) return err(normalized.error, 400);
  const now = nowMs();
  const res = await env.DB.prepare(
    "INSERT INTO monitor_account (platform, name, home_url, account_id, remark, status, login_state_status, health, fail_streak, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 'missing', 'normal', 0, ?, ?)",
  )
    .bind(platform, name, normalized.url, accountId, remark, now, now)
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

const BATCH_MAX_LINES = 200;

/**
 * 从主页链接里取平台账号 ID：取 URL 路径最后一段（查询串/锚点/末尾斜杠已去掉）。
 * 三平台主页链接的最后一段就是账号 ID（快手 profile/<eid>、抖音 user/<secUid>、
 * 小红书 user/profile/<user_id>）。取不到（不是合法 URL、路径为空、最后一段是
 * 通用路径词）时返回 null，调用方按行报错，绝不编造 ID。
 */
export function deriveAccountIdFromUrl(rawUrl: string): string | null {
  let pathname = "";
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last) return null;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  if (!decoded || decoded.length > 200) return null;
  if (
    ["user", "profile", "explore", "video", "note", "search", "channel", "discover", "home", "short-video"].includes(
      decoded.toLowerCase(),
    )
  ) {
    return null;
  }
  return decoded;
}

export interface BatchLineResult {
  line: number;
  url: string;
  status: "added" | "skipped" | "failed";
  account_id: string | null;
  id: number | null;
  reason?: string;
}

/**
 * 批量添加账号：一批一个平台，一行一个主页链接，行尾可跟备注。
 * 逐行处理：有效行入库、无效行不影响其他行；每行一条结果（空行忽略）；
 * 名称默认取链接里的账号 ID（添加后可在列表里编辑改名）；整批写一条操作日志。
 * 校验与单个添加同一套：平台白名单、抖音短链拒绝、小红书去 xsec 参数、
 * UNIQUE(platform, account_id) 去重。
 */
export async function handleBatchCreateAccounts(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const platform = reqString(body.platform, 32);
  if (!platform || !(PLATFORMS as readonly string[]).includes(platform)) return err("平台不在支持范围内", 400);
  const lines = body.lines;
  if (!Array.isArray(lines) || lines.length === 0) return err("请至少粘贴一行主页链接", 400);
  if (lines.length > BATCH_MAX_LINES) return err(`一次最多 ${BATCH_MAX_LINES} 行`, 400);
  for (const l of lines) {
    if (typeof l !== "string") return err("lines 须为字符串数组", 400);
  }
  const results: BatchLineResult[] = [];
  let added = 0;
  let skipped = 0;
  let failed = 0;
  const now = nowMs();
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] as string).trim();
    if (!trimmed) continue; // 空行直接跳过，不计入结果
    const m = /^(\S+)(?:\s+(.*))?$/.exec(trimmed);
    const urlToken = m ? m[1] : trimmed;
    const remarkText = m && m[2] ? m[2].trim() : "";
    const fail = (reason: string) => {
      results.push({ line: i + 1, url: urlToken, status: "failed", account_id: null, id: null, reason });
      failed++;
    };
    if (urlToken.length > 500) {
      fail("主页链接过长");
      continue;
    }
    if (remarkText.length > 500) {
      fail("备注过长");
      continue;
    }
    const normalized = normalizeHomeUrl(platform, urlToken);
    if ("error" in normalized) {
      fail(normalized.error);
      continue;
    }
    const derived = deriveAccountIdFromUrl(normalized.url);
    if (!derived) {
      fail("无法从链接里识别账号 ID，请确认这是达人主页链接，或用单个添加填写平台账号 ID");
      continue;
    }
    const res = await env.DB.prepare(
      "INSERT INTO monitor_account (platform, name, home_url, account_id, remark, status, login_state_status, health, fail_streak, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 'missing', 'normal', 0, ?, ?)",
    )
      .bind(platform, derived, normalized.url, derived, remarkText || null, now, now)
      .run()
      .catch((e: unknown) => {
        if (String(e).includes("UNIQUE")) return null;
        throw e;
      });
    if (!res) {
      results.push({
        line: i + 1,
        url: urlToken,
        status: "skipped",
        account_id: derived,
        id: null,
        reason: "该平台下已存在相同账号，已跳过",
      });
      skipped++;
      continue;
    }
    const id = res.meta.last_row_id as number;
    results.push({ line: i + 1, url: urlToken, status: "added", account_id: derived, id });
    added++;
  }
  await opLog(
    env.DB,
    "account_batch_create",
    "account",
    null,
    `批量添加（${platform}）：新增 ${added} 个、跳过重复 ${skipped} 个、失败 ${failed} 个`,
  );
  return json({
    ok: true,
    platform,
    summary: { total: results.length, added, skipped, failed },
    results,
  });
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
  const existing = await env.DB.prepare("SELECT id, platform FROM monitor_account WHERE id = ?").bind(id).first<{ id: number; platform: string }>();
  if (!existing) return err("账号不存在", 404);
  const name = body.name === undefined ? undefined : reqString(body.name, 100);
  const homeUrl = body.home_url === undefined ? undefined : reqString(body.home_url, 500);
  const remark = body.remark === undefined ? undefined : optString(body.remark, 500);
  if (body.name !== undefined && !name) return err("账号名称不能为空", 400);
  if (body.home_url !== undefined && !homeUrl) return err("主页链接不能为空", 400);
  let normalizedHomeUrl: string | undefined;
  if (homeUrl) {
    const normalized = normalizeHomeUrl(existing.platform, homeUrl);
    if ("error" in normalized) return err(normalized.error, 400);
    normalizedHomeUrl = normalized.url;
  }
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
    binds.push(normalizedHomeUrl);
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
