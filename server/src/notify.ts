// 站内通知中心：列表、未读计数、标已读、全部已读。

import { authenticate, err, json, unauthorized, type Env } from "./db";
import { readJsonBody } from "./util";

export async function handleListNotifications(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const unreadOnly = url.searchParams.get("unread_only") === "1";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") ?? 20) || 20));
  let where = "WHERE 1=1";
  const binds: unknown[] = [];
  if (type) {
    where += " AND type = ?";
    binds.push(type);
  }
  if (unreadOnly) where += " AND is_read = 0";
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM notifications ${where}`).bind(...binds).first<{ c: number }>();
  const unreadRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM notifications WHERE is_read = 0").first<{ c: number }>();
  const rows = await env.DB.prepare(
    `SELECT n.id, n.type, n.title, n.detail, n.account_id, a.name AS account_name, n.is_read, n.created_at FROM notifications n LEFT JOIN monitor_account a ON a.id = n.account_id ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, pageSize, (page - 1) * pageSize)
    .all();
  return json({
    ok: true,
    notifications: (rows.results ?? []).map((r: Record<string, unknown>) => ({ ...r, is_read: r.is_read === 1 })),
    total: countRow?.c ?? 0,
    unread_count: unreadRow?.c ?? 0,
    page,
    page_size: pageSize,
  });
}

export async function handleMarkRead(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => Number.isInteger(x))) {
    return err("ids 须为非空整数数组", 400);
  }
  const placeholders = ids.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE notifications SET is_read = 1 WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
  return json({ ok: true });
}

export async function handleMarkAllRead(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  await env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE is_read = 0").run();
  return json({ ok: true });
}
