// 任务中心接口：手动触发、重试、补采、列表与详情。
// 手动触发与补采走同一幂等键，不产生重复任务（设计 M3 / 条件③-3）。

import { authenticate, clientIp, err, json, nowMs, opLog, rateLimit, unauthorized, type Env } from "./db";
import { ensureDailyTasks, type TaskRow } from "./collect";
import { readJsonBody, reqInt, shanghaiDate } from "./util";

const TASK_SELECT =
  "t.id, t.account_id, t.platform, t.collect_date, t.status, t.idempotency_key, t.error_code, t.error_message, t.retry_count, t.max_retries, t.trigger, t.started_at, t.finished_at, t.collected_count, t.needs_review, t.next_retry_at, a.name AS account_name";

function publicTask(r: TaskRow & { account_name?: string | null }) {
  return {
    id: r.id,
    account_id: r.account_id,
    account_name: r.account_name ?? null,
    platform: r.platform,
    collect_date: r.collect_date,
    status: r.status,
    error_code: r.error_code,
    error_message: r.error_message,
    retry_count: r.retry_count,
    max_retries: r.max_retries,
    trigger: r.trigger,
    started_at: r.started_at,
    finished_at: r.finished_at,
    collected_count: r.collected_count,
    needs_review: r.needs_review === 1,
    next_retry_at: r.next_retry_at,
  };
}

/** 手动立即采集：单账号或全部启用账号；同一天重复触发返回已有任务，不重复建。 */
export async function handleTriggerCollect(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  if (!rateLimit(`trigger:${clientIp(req)}`, 5, 60_000)) return err("采集触发太频繁，请稍后再试", 429);
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const accountId = body.account_id === undefined ? null : reqInt(body.account_id, 1, Number.MAX_SAFE_INTEGER);
  if (body.account_id !== undefined && accountId === null) return err("account_id 不合法", 400);
  const today = shanghaiDate(nowMs());
  if (accountId !== null) {
    const account = await env.DB.prepare("SELECT id, platform, status FROM monitor_account WHERE id = ?")
      .bind(accountId)
      .first<{ id: number; platform: string; status: string }>();
    if (!account) return err("账号不存在", 404);
    if (account.status !== "active") return err("账号已停用", 409);
    const key = `${account.platform}:${account.id}:${today}`;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO collect_task (account_id, platform, collect_date, status, idempotency_key, trigger) VALUES (?, ?, ?, 'waiting', ?, 'manual')",
    )
      .bind(account.id, account.platform, today, key)
      .run();
    await opLog(env.DB, "collect_trigger", "task", null, `手动触发采集：账号 ${accountId}，日期 ${today}`);
    const row = await env.DB.prepare(
      `SELECT ${TASK_SELECT} FROM collect_task t LEFT JOIN monitor_account a ON a.id = t.account_id WHERE t.idempotency_key = ?`,
    )
      .bind(key)
      .first<TaskRow & { account_name: string }>();
    return json({ ok: true, task: row ? publicTask(row) : null });
  }
  const created = await ensureDailyTasks(env, today, "manual");
  await opLog(env.DB, "collect_trigger", "task", null, `手动触发全部采集：日期 ${today}，新建 ${created} 个任务`);
  return json({ ok: true, created, collect_date: today });
}

/** 失败重试：仅 failed 任务可重试；重试计数清零，重新排队。 */
export async function handleRetryTask(env: Env, req: Request, id: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const task = await env.DB.prepare("SELECT id, status FROM collect_task WHERE id = ?")
    .bind(id)
    .first<{ id: number; status: string }>();
  if (!task) return err("任务不存在", 404);
  if (task.status !== "failed") return err("只有失败的任务可以重试", 409);
  await env.DB.prepare(
    "UPDATE collect_task SET status = 'waiting', retry_count = 0, error_code = NULL, error_message = NULL, needs_review = 0, next_retry_at = NULL, trigger = 'retry', started_at = NULL, finished_at = NULL WHERE id = ?",
  )
    .bind(id)
    .run();
  await opLog(env.DB, "collect_retry", "task", id, "手动重试失败任务");
  return json({ ok: true });
}

/** 漏跑补采：为指定日期（默认今天）补建缺失任务，标记 trigger=backfill。 */
export async function handleBackfill(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const body = await readJsonBody(req);
  const dateRaw = body?.collect_date;
  const collectDate = typeof dateRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : shanghaiDate(nowMs());
  const created = await ensureDailyTasks(env, collectDate, "backfill");
  await opLog(env.DB, "backfill", "task", null, `漏跑补采：日期 ${collectDate}，新建 ${created} 个任务`);
  return json({ ok: true, created, collect_date: collectDate });
}

export async function handleListTasks(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const url = new URL(req.url);
  const collectDate = url.searchParams.get("collect_date");
  const status = url.searchParams.get("status");
  const accountId = url.searchParams.get("account_id");
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") ?? 20) || 20));
  let sql = `SELECT ${TASK_SELECT} FROM collect_task t LEFT JOIN monitor_account a ON a.id = t.account_id WHERE 1=1`;
  const binds: unknown[] = [];
  if (collectDate) {
    sql += " AND t.collect_date = ?";
    binds.push(collectDate);
  }
  if (status) {
    sql += " AND t.status = ?";
    binds.push(status);
  }
  if (accountId) {
    sql += " AND t.account_id = ?";
    binds.push(Number(accountId));
  }
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM (${sql})`).bind(...binds).first<{ c: number }>();
  sql += " ORDER BY t.collect_date DESC, t.id DESC LIMIT ? OFFSET ?";
  binds.push(pageSize, (page - 1) * pageSize);
  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<TaskRow & { account_name: string }>();
  return json({
    ok: true,
    tasks: (rows.results ?? []).map(publicTask),
    total: countRow?.c ?? 0,
    page,
    page_size: pageSize,
  });
}

export async function handleGetTask(env: Env, req: Request, id: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const row = await env.DB.prepare(
    `SELECT ${TASK_SELECT} FROM collect_task t LEFT JOIN monitor_account a ON a.id = t.account_id WHERE t.id = ?`,
  )
    .bind(id)
    .first<TaskRow & { account_name: string }>();
  if (!row) return err("任务不存在", 404);
  return json({ ok: true, task: publicTask(row) });
}
