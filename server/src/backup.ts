// 备份：手动导出 JSON + 每日快照写本地备份目录（保留 30 天）。
// 备份含登录态密文（随库走，密钥另管，设计第七节）；不含会话 token、不含内部配置键（口令哈希等）。

import { authenticate, err, json, nowMs, opLog, unauthorized, type Env } from "./db";
import { DAY_MS, shanghaiFileStamp } from "./util";

const DUMP_TABLES = [
  "monitor_account",
  "work",
  "work_snapshot",
  "collect_task",
  "file_asset",
  "download_record",
  "operation_log",
  "notifications",
  "cleanup_log",
] as const;

export async function buildBackup(env: Env): Promise<Record<string, unknown>> {
  const tables: Record<string, unknown[]> = {};
  for (const t of DUMP_TABLES) {
    const rows = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    tables[t] = rows.results ?? [];
  }
  const settings = await env.DB.prepare("SELECT key, value, updated_at FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'")
    .all();
  tables["settings"] = settings.results ?? [];
  return { version: 1, service: "monitor-workbench-server", exported_at: nowMs(), tables };
}

export async function handleExportBackup(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const dump = await buildBackup(env);
  await opLog(env.DB, "backup", null, null, "手动导出备份");
  const body = JSON.stringify(dump);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="monitor-backup-${shanghaiFileStamp(nowMs())}.json"`,
    },
  });
}

/** 每日快照：写本地 backups/ 前缀，删 30 天前的旧快照。 */
export async function snapshotBackup(env: Env): Promise<string> {
  const dump = await buildBackup(env);
  const key = `backups/monitor-backup-${shanghaiFileStamp(nowMs())}.json`;
  await env.BUCKET.put(key, JSON.stringify(dump), { httpMetadata: { contentType: "application/json" } });
  const listed = await env.BUCKET.list({ prefix: "backups/" });
  const cutoff = nowMs() - 30 * DAY_MS;
  for (const obj of listed.objects) {
    if (obj.uploaded.getTime() < cutoff) await env.BUCKET.delete(obj.key);
  }
  await opLog(env.DB, "backup", null, null, `每日快照已写本地备份目录：${key}`);
  return key;
}
