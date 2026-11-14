// 看板：今日成功/失败账号数、今日作品数、存储占用、即将过期作品数、近期通知、健康分布。

import { authenticate, json, nowMs, quotaBytes, storageUsedBytes, unauthorized, type Env } from "./db";
import { DAY_MS, shanghaiDate } from "./util";

export async function handleDashboard(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const today = shanghaiDate(nowMs());
  const dayStart = Date.parse(`${today}T00:00:00+08:00`);
  const taskCounts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS c FROM collect_task WHERE collect_date = ? GROUP BY status",
  )
    .bind(today)
    .all<{ status: string; c: number }>();
  const counts: Record<string, number> = {};
  for (const r of taskCounts.results ?? []) counts[r.status] = r.c;
  const worksToday = await env.DB.prepare("SELECT COUNT(*) AS c FROM work WHERE collected_finished_at >= ? AND collected_finished_at < ?")
    .bind(dayStart, dayStart + DAY_MS)
    .first<{ c: number }>();
  const quota = await quotaBytes(env);
  const used = await storageUsedBytes(env.DB);
  const expiringSoon = await env.DB.prepare("SELECT COUNT(*) AS c FROM work WHERE expires_at > ? AND expires_at <= ?")
    .bind(nowMs(), nowMs() + DAY_MS)
    .first<{ c: number }>();
  const health = await env.DB.prepare("SELECT health, COUNT(*) AS c FROM monitor_account WHERE status = 'active' GROUP BY health").all<{
    health: string;
    c: number;
  }>();
  const recent = await env.DB.prepare(
    "SELECT id, type, title, detail, account_id, is_read, created_at FROM notifications ORDER BY created_at DESC, id DESC LIMIT 5",
  ).all();
  const unread = await env.DB.prepare("SELECT COUNT(*) AS c FROM notifications WHERE is_read = 0").first<{ c: number }>();
  return json({
    ok: true,
    date: today,
    tasks: {
      success: counts["success"] ?? 0,
      partial: counts["partial"] ?? 0,
      failed: counts["failed"] ?? 0,
      waiting: counts["waiting"] ?? 0,
      running: counts["running"] ?? 0,
    },
    works_today: worksToday?.c ?? 0,
    storage: { used_bytes: used, quota_bytes: quota, usage_ratio: quota > 0 ? used / quota : 0 },
    expiring_soon_24h: expiringSoon?.c ?? 0,
    health: Object.fromEntries((health.results ?? []).map((r) => [r.health, r.c])),
    recent_notifications: recent.results ?? [],
    unread_count: unread?.c ?? 0,
  });
}
