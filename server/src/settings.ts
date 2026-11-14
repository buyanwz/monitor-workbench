// 配置与操作日志查询：配置逐项校验，collect_hour 固定 8 不可改（R1）；配置变更写操作日志。

import { authenticate, err, getPublicSettings, getSettingInt, json, opLog, setSetting, unauthorized, type Env } from "./db";
import { readJsonBody, reqInt } from "./util";

const RULES: Record<string, { min: number; max: number; label: string }> = {
  retention_days: { min: 1, max: 30, label: "保留天数" },
  download_link_ttl_minutes: { min: 5, max: 120, label: "下载链接有效期（分钟）" },
  max_concurrent_zip: { min: 1, max: 10, label: "ZIP 并发生成上限" },
  collect_batch_size: { min: 1, max: 10, label: "每触发处理账号数" },
  storage_quota_bytes: { min: 0, max: Number.MAX_SAFE_INTEGER, label: "存储配额（字节）" },
  login_state_warn_days: { min: 1, max: 90, label: "登录态提醒天数" },
};

export async function handleGetSettings(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const settings = await getPublicSettings(env.DB);
  return json({ ok: true, settings });
}

export async function handleUpdateSettings(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  if (body.collect_hour !== undefined) return err("采集时间固定为北京时间 8:00，不可修改", 400);
  const changes: Array<{ key: string; old: number; next: number }> = [];
  for (const [key, rule] of Object.entries(RULES)) {
    if (body[key] === undefined) continue;
    const next = reqInt(body[key], rule.min, rule.max);
    if (next === null) return err(`${rule.label}须为 ${rule.min}～${rule.max} 的整数`, 400);
    const old = await getSettingInt(env.DB, key);
    if (old !== next) changes.push({ key, old, next });
  }
  if (changes.length === 0) return err("没有可更新的配置", 400);
  for (const c of changes) {
    await setSetting(env.DB, c.key, String(c.next));
  }
  await opLog(
    env.DB,
    "config_change",
    "settings",
    null,
    changes.map((c) => `${c.key}: ${c.old} → ${c.next}`).join("; "),
  );
  const settings = await getPublicSettings(env.DB);
  return json({ ok: true, settings });
}

export async function handleListOperationLogs(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") ?? 20) || 20));
  let where = "WHERE 1=1";
  const binds: unknown[] = [];
  if (action) {
    where += " AND action = ?";
    binds.push(action);
  }
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM operation_log ${where}`).bind(...binds).first<{ c: number }>();
  const rows = await env.DB.prepare(
    `SELECT id, actor, action, target_type, target_id, detail, created_at FROM operation_log ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, pageSize, (page - 1) * pageSize)
    .all();
  return json({ ok: true, logs: rows.results ?? [], total: countRow?.c ?? 0, page, page_size: pageSize });
}
