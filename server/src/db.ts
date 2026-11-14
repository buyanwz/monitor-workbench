// 本地 SQLite 访问、会话鉴权、操作日志、通知、配置公共件。
// （由 Cloudflare 版 db.ts 移植：Env 的 DB/BUCKET 改为本地适配层，其余逻辑一字未动。）

import type { LocalDatabase } from "./localdb";
import type { LocalBucket } from "./localbucket";
import type { PlatformFetcher } from "./fetcher";

/** 浏览器采集控制面（Electron 主进程注入；CLI 环境下 Env 里没有该对象）。 */
export interface BrowserControl {
  getStatus(): Promise<{ loggedIn: boolean; lastCaptureAt: number | null }>;
  showLoginWindow(): Promise<void>;
}

export interface Env {
  DB: LocalDatabase;
  BUCKET: LocalBucket;
  LOGIN_STATE_KEY?: string;
  DOWNLOAD_SIGNING_KEY?: string;
  MOCK_FETCHER?: string;
  TEST_MODE?: string;
  TEST_QUOTA_BYTES?: string;
  TEST_MAX_FILE_BYTES?: string;
  ALLOWED_ORIGIN?: string;
  /** 浏览器采集器（仅 Electron 注入；CLI/测试环境无此项，走 mock 或未实现占位）。 */
  BROWSER_FETCHER?: PlatformFetcher;
  /** 浏览器采集控制面（仅 Electron 注入）。 */
  BROWSER_CONTROL?: BrowserControl;
  /** 本地服务实际监听端口（固定端口兜底后可能与请求端口不同；上报地址显示用）。 */
  SERVER_PORT?: number;
  /** 扩展上报专用令牌（只对 /intake/report 有效，不等于会话登录）。 */
  INTAKE_TOKEN?: string;
  /** 轮换上报令牌（环境变量模式下无此项，不可轮换）。 */
  rotateIntakeToken?: () => Promise<string>;
}

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 会话 30 天，滑动续期
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000; // 连续输错 5 次锁 15 分钟

export function nowMs(): number {
  return Date.now();
}

export function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(extraHeaders ?? {}) },
  });
}

export function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("Authorization");
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim() || null;
}

/**
 * 会话鉴权：token 只比对 SHA-256 哈希；命中且未过期则滑动续期。
 * 单用户服务：会话表不分账号，主体恒为“本人”。
 */
export async function authenticate(env: Env, req: Request): Promise<{ tokenHash: string } | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { sha256Hex } = await import("./crypto");
  const tokenHash = await sha256Hex(token);
  const now = nowMs();
  const sess = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ expires_at: number }>();
  if (!sess || sess.expires_at <= now) return null;
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
    .bind(now, now + SESSION_TTL_MS, tokenHash)
    .run();
  return { tokenHash };
}

export function unauthorized(): Response {
  return err("未登录或会话已过期，请重新登录", 401);
}

/**
 * 上报令牌鉴权：只比对 SHA-256 哈希，不滑动续期、不产生会话。
 * 仅供 /intake/report 使用——令牌在其他接口上一律无效（不是登录凭证）。
 */
export async function authenticateIntakeToken(env: Env, req: Request): Promise<boolean> {
  const token = bearerToken(req);
  const expected = env.INTAKE_TOKEN;
  if (!token || !expected) return false;
  const { sha256Hex } = await import("./crypto");
  const a = await sha256Hex(token);
  const b = await sha256Hex(expected);
  return a === b;
}

// ---- 脚手架级内存限流（仅挡单机滥用；生产限流走 Cloudflare 规则，部署前补，见 README） ----
const hits = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || rec.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (rec.count >= limit) return false;
  rec.count++;
  return true;
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

// ---- 操作日志（设计第七节：全量记录，详情脱敏，永不含登录态原文） ----
export async function opLog(
  db: LocalDatabase,
  action: string,
  targetType: string | null,
  targetId: number | null,
  detail: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO operation_log (actor, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind("本人", action, targetType, targetId, detail, nowMs())
    .run();
}

// ---- 站内通知 ----
export type NotificationType =
  | "collect_failed"
  | "account_invalid"
  | "risk_control"
  | "failing_streak"
  | "storage_warning"
  | "storage_critical"
  | "file_too_large"
  | "task_timeout"
  | "login_expiry_warning"
  | "cleanup_done";

export async function notify(
  db: LocalDatabase,
  type: NotificationType,
  title: string,
  detail: string,
  accountId: number | null = null,
): Promise<void> {
  await db
    .prepare("INSERT INTO notifications (type, title, detail, account_id, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)")
    .bind(type, title, detail, accountId, nowMs())
    .run();
}

/** 去重通知：同一类型+同一账号在窗口内已有未读通知则跳过（防刷屏，如存储告警与登录态提醒） */
export async function notifyOnce(
  db: LocalDatabase,
  type: NotificationType,
  title: string,
  detail: string,
  accountId: number | null,
  windowMs: number,
): Promise<void> {
  const since = nowMs() - windowMs;
  const existing = await db
    .prepare(
      "SELECT id FROM notifications WHERE type = ? AND account_id IS ? AND is_read = 0 AND created_at >= ? LIMIT 1",
    )
    .bind(type, accountId, since)
    .first<{ id: number }>();
  if (existing) return;
  await notify(db, type, title, detail, accountId);
}

// ---- 配置（settings 键值表；以下划线开头的键为内部键，不暴露给前端、不进备份） ----
const SETTING_DEFAULTS: Record<string, string> = {
  retention_days: "3",
  download_link_ttl_minutes: "30",
  collect_hour: "8",
  max_concurrent_zip: "3",
  collect_batch_size: "3",
  storage_quota_bytes: "8589934592",
  login_state_warn_days: "30",
};

export async function getSetting(db: LocalDatabase, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (row) return row.value;
  return SETTING_DEFAULTS[key] ?? null;
}

export async function getSettingInt(db: LocalDatabase, key: string): Promise<number> {
  const v = await getSetting(db, key);
  const n = v === null ? NaN : Number(v);
  if (!Number.isFinite(n)) return Number(SETTING_DEFAULTS[key] ?? 0);
  return n;
}

export async function setSetting(db: LocalDatabase, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, value, nowMs())
    .run();
}

/** 前端可见的全部配置（内部键除外） */
export async function getPublicSettings(db: LocalDatabase): Promise<Record<string, string>> {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'").all<{
    key: string;
    value: string;
  }>();
  const out: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const r of rows.results ?? []) out[r.key] = r.value;
  return out;
}

/** 存储配额（字节）：测试环境变量优先（仅测试用小配额），否则取配置 */
export async function quotaBytes(env: Env): Promise<number> {
  if (env.TEST_QUOTA_BYTES !== undefined) {
    const n = Number(env.TEST_QUOTA_BYTES);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return getSettingInt(env.DB, "storage_quota_bytes");
}

/** 当前存储占用（file_asset 大小之和，本地库为准） */
export async function storageUsedBytes(db: LocalDatabase): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM file_asset").first<{ total: number }>();
  return row?.total ?? 0;
}
