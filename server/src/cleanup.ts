// 到期清理与存储看板：删过期文件资产（真删本地文件对象 + 资产行 + 清理记录），
// 链接校验查资产存在性，删后即失效（设计第七节）。元数据与日志保留 90 天以上，只清文件。

import { getSettingInt, notifyOnce, nowMs, opLog, quotaBytes, storageUsedBytes, type Env } from "./db";
import { authenticate, err, json, unauthorized } from "./db";
import { DAY_MS } from "./util";

const LOG_RETENTION_MS = 90 * DAY_MS;

export interface CleanupSummary {
  deleted_assets: number;
  deleted_bytes: number;
  pruned_logs: number;
  pruned_notifications: number;
  pruned_sessions: number;
}

export async function runCleanup(env: Env): Promise<CleanupSummary> {
  const now = nowMs();
  // 1. 过期文件资产：真删本地文件对象 + 资产行，逐条写清理记录
  const expired = await env.DB.prepare("SELECT id, work_id, kind, storage_path, size_bytes FROM file_asset WHERE expires_at <= ?")
    .bind(now)
    .all<{ id: number; work_id: number; kind: string; storage_path: string; size_bytes: number }>();
  let deletedBytes = 0;
  for (const a of expired.results ?? []) {
    await env.BUCKET.delete(a.storage_path);
    await env.DB.prepare("DELETE FROM file_asset WHERE id = ?").bind(a.id).run();
    await env.DB.prepare("INSERT INTO cleanup_log (work_id, kind, storage_path, size_bytes, reason, created_at) VALUES (?, ?, ?, ?, 'expired', ?)")
      .bind(a.work_id, a.kind, a.storage_path, a.size_bytes, now)
      .run();
    deletedBytes += a.size_bytes;
  }
  // 2. 超 90 天的日志/通知/过期会话
  const logs = await env.DB.prepare("DELETE FROM operation_log WHERE created_at < ?").bind(now - LOG_RETENTION_MS).run();
  const notifs = await env.DB.prepare("DELETE FROM notifications WHERE created_at < ?").bind(now - LOG_RETENTION_MS).run();
  const sessions = await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();

  // 3. 登录态过期提醒：配置超过 N 天未更新的账号提醒一次（7 天内不重复）
  const warnDays = await getSettingInt(env.DB, "login_state_warn_days");
  const stale = await env.DB.prepare(
    "SELECT id, name FROM monitor_account WHERE status = 'active' AND login_state_status = 'ok' AND login_state_updated_at IS NOT NULL AND login_state_updated_at < ?",
  )
    .bind(now - warnDays * DAY_MS)
    .all<{ id: number; name: string }>();
  for (const a of stale.results ?? []) {
    await notifyOnce(
      env.DB,
      "login_expiry_warning",
      `账号 ${a.name} 的登录态已超过 ${warnDays} 天未更新`,
      "登录态可能已过期，自动采集可能失败，请检查并重新配置。",
      a.id,
      7 * DAY_MS,
    );
  }

  // 4. 存储阈值告警（清理后复核）
  const quota = await quotaBytes(env);
  const used = await storageUsedBytes(env.DB);
  if (quota > 0) {
    const ratio = used / quota;
    if (ratio >= 0.95) {
      await notifyOnce(env.DB, "storage_critical", "存储占用超过 95%", "存储即将用满，请清理或调高配额。", null, DAY_MS);
    } else if (ratio >= 0.8) {
      await notifyOnce(env.DB, "storage_warning", "存储占用超过 80%", "存储占用已超过配额的 80%，请留意清理。", null, DAY_MS);
    }
  }

  const summary: CleanupSummary = {
    deleted_assets: expired.results?.length ?? 0,
    deleted_bytes: deletedBytes,
    pruned_logs: logs.meta.changes ?? 0,
    pruned_notifications: notifs.meta.changes ?? 0,
    pruned_sessions: sessions.meta.changes ?? 0,
  };
  await opLog(
    env.DB,
    "cleanup",
    null,
    null,
    `到期清理：删除 ${summary.deleted_assets} 个文件资产（${summary.deleted_bytes} 字节），归档 ${summary.pruned_logs} 条日志`,
  );
  return summary;
}

export async function handleRunCleanup(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const summary = await runCleanup(env);
  return json({ ok: true, ...summary });
}

export async function handleListCleanupRecords(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") ?? 20) || 20));
  const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM cleanup_log").first<{ c: number }>();
  const rows = await env.DB.prepare(
    "SELECT id, work_id, kind, storage_path, size_bytes, reason, created_at FROM cleanup_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
  )
    .bind(pageSize, (page - 1) * pageSize)
    .all();
  return json({ ok: true, records: rows.results ?? [], total: countRow?.c ?? 0, page, page_size: pageSize });
}

export async function handleStorageUsage(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const quota = await quotaBytes(env);
  const used = await storageUsedBytes(env.DB);
  const byKind = await env.DB.prepare("SELECT kind, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM file_asset GROUP BY kind").all<{
    kind: string;
    count: number;
    bytes: number;
  }>();
  const expiringSoon = await env.DB.prepare("SELECT COUNT(*) AS c FROM file_asset WHERE expires_at > ? AND expires_at <= ?")
    .bind(nowMs(), nowMs() + DAY_MS)
    .first<{ c: number }>();
  return json({
    ok: true,
    used_bytes: used,
    quota_bytes: quota,
    usage_ratio: quota > 0 ? used / quota : 0,
    by_kind: byKind.results ?? [],
    expiring_soon_24h: expiringSoon?.c ?? 0,
  });
}
