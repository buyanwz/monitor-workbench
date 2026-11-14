// 采集引擎与任务中心：任务幂等建、每分钟分片处理、单账号隔离、异常分类、退避重试、漏跑补采。
// 采集流程（设计第六节）：解密登录态 → 取列表 → 排除置顶 → 取前 5 → upsert → 写快照 →
// 下载视频/封面到本地文件目录 → 写 file_asset。任意一步异常只影响本账号。

import { decryptLoginState, sha256HexBytes } from "./crypto";
import {
  getSettingInt,
  notify,
  notifyOnce,
  nowMs,
  opLog,
  quotaBytes,
  storageUsedBytes,
  type Env,
} from "./db";
import {
  NON_RETRYABLE,
  classifyError,
  platformLabel,
  selectFetcher,
  type ErrorCode,
  type FetchedWork,
} from "./fetcher";
import { shanghaiDate, DAY_MS } from "./util";

export const COLLECT_TIMEOUT_MS = 120_000; // 单账号采集超时（设计第六节）
const DOWNLOAD_TIMEOUT_MS = 60_000;
const STALE_RUNNING_MS = 30 * 60 * 1000; // running 超 30 分钟判为卡死
const MAX_WORKS_PER_ACCOUNT = 5;
const RETRY_BACKOFF_MINUTES = [1, 2, 4]; // 第 1/2/3 次重试的退避间隔

export interface TaskRow {
  id: number;
  account_id: number;
  platform: string;
  collect_date: string;
  status: string;
  idempotency_key: string;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  trigger: string;
  started_at: number | null;
  finished_at: number | null;
  collected_count: number;
  needs_review: number;
  next_retry_at: number | null;
}

interface AccountRow {
  id: number;
  platform: string;
  name: string;
  home_url: string;
  account_id: string;
  status: string;
  login_state_enc: string | null;
  login_state_status: string;
  health: string;
  fail_streak: number;
}

function idempotencyKey(platform: string, accountDbId: number, collectDate: string): string {
  return `${platform}:${accountDbId}:${collectDate}`;
}

/** 为指定日期建任务（幂等：INSERT OR IGNORE，已存在则跳过）。返回新建数。 */
export async function ensureDailyTasks(env: Env, collectDate: string, trigger: string): Promise<number> {
  const accounts = await env.DB.prepare("SELECT id, platform FROM monitor_account WHERE status = 'active'")
    .all<{ id: number; platform: string }>();
  let created = 0;
  for (const a of accounts.results ?? []) {
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO collect_task (account_id, platform, collect_date, status, idempotency_key, trigger) VALUES (?, ?, ?, 'waiting', ?, ?)",
    )
      .bind(a.id, a.platform, collectDate, idempotencyKey(a.platform, a.id, collectDate), trigger)
      .run();
    if ((res.meta.changes ?? 0) > 0) created++;
  }
  return created;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("请求超时")), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function updateHealthOnFailure(env: Env, account: AccountRow, code: ErrorCode, browserMode = false): Promise<void> {
  const now = nowMs();
  if (code === "login_expired") {
    if (browserMode) {
      // 浏览器模式：登录态在浏览器分区里，不动账号的 login_state_status（那是另一套登录态）
      const label = platformLabel(account.platform);
      await env.DB.prepare("UPDATE monitor_account SET health = 'invalid', fail_streak = fail_streak + 1, updated_at = ? WHERE id = ?")
        .bind(now, account.id)
        .run();
      await notify(env.DB, "account_invalid", `账号 ${account.name} 登录态失效`, `采集失败：浏览器里还没登录${label}，请在设置页打开${label}登录窗口登录。`, account.id);
      return;
    }
    await env.DB.prepare(
      "UPDATE monitor_account SET health = 'invalid', fail_streak = fail_streak + 1, login_state_status = 'expired', updated_at = ? WHERE id = ?",
    )
      .bind(now, account.id)
      .run();
    await notify(env.DB, "account_invalid", `账号 ${account.name} 登录态失效`, "采集失败：登录态已失效，请重新配置登录态。", account.id);
    return;
  }
  if (code === "captcha" || code === "banned") {
    await env.DB.prepare("UPDATE monitor_account SET health = 'risk', fail_streak = fail_streak + 1, updated_at = ? WHERE id = ?")
      .bind(now, account.id)
      .run();
    await notify(
      env.DB,
      "risk_control",
      `账号 ${account.name} 触发风控`,
      code === "captcha" ? "采集失败：触发验证码，请人工处理。" : "采集失败：账号受限，请人工处理。",
      account.id,
    );
    return;
  }
  const streak = account.fail_streak + 1;
  const health = streak >= 3 ? "failing" : account.health;
  await env.DB.prepare("UPDATE monitor_account SET health = ?, fail_streak = ?, updated_at = ? WHERE id = ?")
    .bind(health, streak, now, account.id)
    .run();
  if (streak >= 3 && account.health !== "failing") {
    await notify(env.DB, "failing_streak", `账号 ${account.name} 连续失败 ${streak} 次`, "已连续失败 3 次以上，请检查账号与登录态。", account.id);
  }
}

async function updateHealthOnSuccess(env: Env, accountId: number): Promise<void> {
  await env.DB.prepare("UPDATE monitor_account SET health = 'normal', fail_streak = 0, updated_at = ? WHERE id = ?")
    .bind(nowMs(), accountId)
    .run();
}

/** 单文件上限（设计条件 ①-1）：500MB；TEST_MAX_FILE_BYTES 仅测试用覆盖。 */
export const MAX_SINGLE_FILE_BYTES = 500 * 1024 * 1024;

function singleFileLimitBytes(env: Env): number {
  if (env.TEST_MAX_FILE_BYTES !== undefined) {
    const n = Number(env.TEST_MAX_FILE_BYTES);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return MAX_SINGLE_FILE_BYTES;
}

/** 配额检查：返回 ok（可存）/ warn（可存但已过 80%）/ full（超配额，拒绝入库）。 */
async function checkQuota(env: Env, extraBytes: number): Promise<"ok" | "warn" | "full"> {
  const quota = await quotaBytes(env);
  const used = await storageUsedBytes(env.DB);
  if (used + extraBytes > quota) return "full";
  if ((used + extraBytes) / quota >= 0.8) return "warn";
  return "ok";
}

async function storeMedia(
  env: Env,
  workDbId: number,
  kind: "video" | "cover",
  storagePath: string,
  bytes: ArrayBuffer,
  contentType: string,
  expiresAt: number,
): Promise<"stored" | "quota_full" | "too_large"> {
  // 单文件上限：超限拒存、告警、只留元数据（设计条件 ①-1）
  const limit = singleFileLimitBytes(env);
  if (bytes.byteLength > limit) {
    await notifyOnce(
      env.DB,
      "file_too_large",
      `单文件超过上限（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB > ${Math.round(limit / 1024 / 1024)}MB）`,
      "该文件拒绝入库，只保留作品元数据。请确认作品来源或联系维护者。",
      null,
      DAY_MS,
    );
    return "too_large";
  }
  const quota = await checkQuota(env, bytes.byteLength);
  if (quota === "full") {
    await notifyOnce(
      env.DB,
      "storage_critical",
      "存储配额已满",
      "存储已满，新文件拒绝入库，只保留作品元数据。请清理或调高配额。",
      null,
      DAY_MS,
    );
    return "quota_full";
  }
  if (quota === "warn") {
    await notifyOnce(env.DB, "storage_warning", "存储占用超过 80%", "存储占用已超过配额的 80%，请留意清理。", null, DAY_MS);
  }
  const sha = await sha256HexBytes(bytes);
  await env.BUCKET.put(storagePath, bytes, { httpMetadata: { contentType } });
  await env.DB.prepare(
    "INSERT INTO file_asset (work_id, kind, storage_path, size_bytes, sha256, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(work_id, kind) DO UPDATE SET storage_path = excluded.storage_path, size_bytes = excluded.size_bytes, sha256 = excluded.sha256, expires_at = excluded.expires_at, created_at = excluded.created_at",
  )
    .bind(workDbId, kind, storagePath, bytes.byteLength, sha, expiresAt, nowMs())
    .run();
  return "stored";
}

/** 旧 ZIP 缓存失效：源视频重采后，已缓存的 ZIP 作废（下次下载时重建）。 */
async function invalidateZipCache(env: Env, workDbId: number): Promise<void> {
  const zip = await env.DB.prepare("SELECT id, storage_path FROM file_asset WHERE work_id = ? AND kind = 'zip'")
    .bind(workDbId)
    .first<{ id: number; storage_path: string }>();
  if (!zip) return;
  await env.BUCKET.delete(zip.storage_path);
  await env.DB.prepare("DELETE FROM file_asset WHERE id = ?").bind(zip.id).run();
}

async function ingestWork(
  env: Env,
  account: AccountRow,
  w: FetchedWork,
  taskId: number,
  finishedAt: number,
  retentionDays: number,
): Promise<{ ingested: boolean; filesOk: boolean }> {
  const expiresAt = finishedAt + retentionDays * DAY_MS;
  await env.DB.prepare(
    "INSERT INTO work (platform, work_id, account_id, title, topics, cover_url, video_url, origin_url, published_at, is_pinned, collected_at, collected_finished_at, expires_at, retention_days, file_status) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok') " +
      "ON CONFLICT(platform, work_id) DO UPDATE SET title = excluded.title, topics = excluded.topics, cover_url = excluded.cover_url, video_url = excluded.video_url, origin_url = excluded.origin_url, published_at = excluded.published_at, collected_finished_at = excluded.collected_finished_at, expires_at = excluded.expires_at, retention_days = excluded.retention_days",
  )
    .bind(
      account.platform,
      w.work_id,
      account.id,
      w.title,
      JSON.stringify(w.topics ?? []),
      w.cover_url,
      w.video_url,
      w.origin_url,
      w.published_at,
      w.is_pinned ? 1 : 0,
      finishedAt,
      finishedAt,
      expiresAt,
      retentionDays,
    )
    .run();
  const workRow = await env.DB.prepare("SELECT id FROM work WHERE platform = ? AND work_id = ?")
    .bind(account.platform, w.work_id)
    .first<{ id: number }>();
  if (!workRow) return { ingested: false, filesOk: false };
  await env.DB.prepare("INSERT INTO work_snapshot (work_id, likes, collected_at, task_id) VALUES (?, ?, ?, ?)")
    .bind(workRow.id, w.likes, finishedAt, taskId)
    .run();

  // 下载视频与封面到本地文件目录（单条失败不阻塞其他作品，任务标部分失败）
  const fetcher = selectFetcher(env);
  let filesOk = true;
  const jobs: Array<{ kind: "video" | "cover"; url: string; path: string }> = [
    { kind: "video", url: w.video_url, path: `works/${account.platform}/${w.work_id}/video.mp4` },
    { kind: "cover", url: w.cover_url, path: `works/${account.platform}/${w.work_id}/cover.jpg` },
  ];
  for (const job of jobs) {
    try {
      const media = await withTimeout(fetcher.download(job.url), DOWNLOAD_TIMEOUT_MS);
      const stored = await storeMedia(env, workRow.id, job.kind, job.path, media.bytes, media.contentType, expiresAt);
      if (stored !== "stored") filesOk = false;
    } catch (e) {
      const { code } = classifyError(e);
      // deleted：作品已删，跳过该文件，继续（设计第六节）；其余下载失败同为文件缺失
      void code;
      filesOk = false;
    }
  }
  if (filesOk) await invalidateZipCache(env, workRow.id);
  await env.DB.prepare("UPDATE work SET file_status = ? WHERE id = ?")
    .bind(filesOk ? "ok" : "missing", workRow.id)
    .run();
  return { ingested: true, filesOk };
}

/** 处理单个任务（单账号全程隔离，异常只记本任务）。 */
export async function processTask(env: Env, taskId: number): Promise<void> {
  const task = await env.DB.prepare("SELECT * FROM collect_task WHERE id = ?").bind(taskId).first<TaskRow>();
  if (!task || task.status !== "running") return;
  const account = await env.DB.prepare("SELECT * FROM monitor_account WHERE id = ?")
    .bind(task.account_id)
    .first<AccountRow>();
  const startedAt = task.started_at ?? nowMs();
  const fetcher = selectFetcher(env, account?.platform);
  const browserMode = fetcher.usesBrowserLogin === true;

  const finishFailed = async (code: ErrorCode, message: string, needsReview: boolean, punishAccount: boolean) => {
    const now = nowMs();
    const effectiveMax = code === "other" ? Math.min(1, task.max_retries) : task.max_retries;
    const canRetry = !NON_RETRYABLE.has(code) && !needsReview && task.retry_count < effectiveMax;
    if (canRetry) {
      const backoff = RETRY_BACKOFF_MINUTES[Math.min(task.retry_count, RETRY_BACKOFF_MINUTES.length - 1)] * 60 * 1000;
      await env.DB.prepare(
        "UPDATE collect_task SET status = 'waiting', error_code = ?, error_message = ?, retry_count = ?, next_retry_at = ? WHERE id = ?",
      )
        .bind(code, message, task.retry_count + 1, now + backoff, task.id)
        .run();
    } else {
      await env.DB.prepare(
        "UPDATE collect_task SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?, needs_review = ? WHERE id = ?",
      )
        .bind(code, message, now, needsReview ? 1 : 0, task.id)
        .run();
      if (account) {
        await notify(
          env.DB,
          "collect_failed",
          `账号 ${account.name} 采集失败`,
          needsReview ? "返回数据无置顶字段，已标记待人工核对，未入库。" : `失败原因：${message}`,
          account.id,
        );
        if (punishAccount) await updateHealthOnFailure(env, account, code, browserMode);
      }
    }
  };

  if (!account) {
    await finishFailed("other", "账号不存在", false, false);
    return;
  }
  if (account.status !== "active") {
    await env.DB.prepare("UPDATE collect_task SET status = 'failed', error_code = 'other', error_message = ?, finished_at = ? WHERE id = ?")
      .bind("账号已停用", nowMs(), task.id)
      .run();
    return;
  }

  // 1. 登录态门（设计第六节第 1 步）
  // 浏览器模式：登录态在浏览器分区 cookie 里，不走 login_state_enc 解密，改查分区登录状态；
  // 直调/mock 模式：解密 login_state_enc（失败 → login_expired）。
  let loginState = "";
  if (browserMode) {
    const label = platformLabel(account.platform);
    const loggedIn = fetcher.checkBrowserLogin ? await fetcher.checkBrowserLogin(account.platform) : false;
    if (!loggedIn) {
      await finishFailed("login_expired", `浏览器里还没登录${label}，请在设置页打开${label}登录窗口登录`, false, true);
      return;
    }
  } else {
    try {
      if (!account.login_state_enc) throw new Error("未配置登录态");
      if (!env.LOGIN_STATE_KEY) throw new Error("服务端未配置登录态加密密钥");
      loginState = await decryptLoginState(account.login_state_enc, env.LOGIN_STATE_KEY);
    } catch {
      await finishFailed("login_expired", "登录态失效或未配置，请重新配置登录态", false, true);
      return;
    }
  }

  // 2. 取作品列表（120 秒超时 → network）
  let result;
  try {
    result = await withTimeout(fetcher.fetchWorks(account, loginState), COLLECT_TIMEOUT_MS);
  } catch (e) {
    const { code, message } = classifyError(e);
    await finishFailed(code, message, false, true);
    return;
  }

  // 3. 置顶字段缺失 → 标记待人工核对，不入库（R3）
  if (!result.has_pinned_field) {
    await finishFailed("other", "返回数据无置顶字段，已标记待人工核对", true, false);
    return;
  }

  // 4. 排除置顶，取前 5
  const picked = result.works.filter((w) => !w.is_pinned).slice(0, MAX_WORKS_PER_ACCOUNT);
  const retentionDays = await getSettingInt(env.DB, "retention_days");
  const finishedAt = nowMs();
  let collected = 0;
  let allFilesOk = true;
  for (const w of picked) {
    try {
      const r = await ingestWork(env, account, w, task.id, finishedAt, retentionDays);
      if (r.ingested) collected++;
      if (!r.filesOk) allFilesOk = false;
    } catch (e) {
      // 单条入库异常不阻塞其他作品
      allFilesOk = false;
      void e;
    }
  }

  const status = allFilesOk ? "success" : "partial";
  await env.DB.prepare(
    "UPDATE collect_task SET status = ?, collected_count = ?, finished_at = ?, error_code = NULL, error_message = NULL, next_retry_at = NULL WHERE id = ?",
  )
    .bind(status, collected, finishedAt, task.id)
    .run();
  await updateHealthOnSuccess(env, account.id);
  // 图文跳过如实通知：跳过数由采集器上报（图文无视频文件，按规则不入库），一天内同一账号只报一次
  const skipped = result.skippedCount ?? 0;
  if (skipped > 0) {
    await notifyOnce(
      env.DB,
      "collect_skipped",
      `账号 ${account.name} 采集跳过 ${skipped} 条图文作品`,
      `本次采集遇到 ${skipped} 条${result.skippedNote ?? "图文作品"}，没有视频文件，按当前规则不入库。`,
      account.id,
      DAY_MS,
    );
  }
  void startedAt;
}

/** 回收卡死的 running 任务（超 30 分钟）：有重试次数则回 waiting，否则判失败并告警。 */
async function recoverStaleRunning(env: Env): Promise<void> {
  const stale = await env.DB.prepare("SELECT * FROM collect_task WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?")
    .bind(nowMs() - STALE_RUNNING_MS)
    .all<TaskRow>();
  for (const t of stale.results ?? []) {
    if (t.retry_count < t.max_retries) {
      await env.DB.prepare("UPDATE collect_task SET status = 'waiting', retry_count = ?, next_retry_at = ?, error_code = 'network', error_message = '任务执行超时，已重新排队' WHERE id = ?")
        .bind(t.retry_count + 1, nowMs(), t.id)
        .run();
    } else {
      await env.DB.prepare("UPDATE collect_task SET status = 'failed', error_code = 'network', error_message = '任务执行超时', finished_at = ? WHERE id = ?")
        .bind(nowMs(), t.id)
        .run();
      const account = await env.DB.prepare("SELECT name FROM monitor_account WHERE id = ?")
        .bind(t.account_id)
        .first<{ name: string }>();
      await notify(env.DB, "task_timeout", `账号 ${account?.name ?? t.account_id} 采集任务超时`, "任务执行超过 30 分钟未完成，已标记失败。", t.account_id);
    }
  }
}

/** 每分钟触发：回收卡死任务，认领最多 N 个待处理任务并逐个处理（断点续跑）。 */
export async function processPendingTasks(env: Env): Promise<{ claimed: number }> {
  await recoverStaleRunning(env);
  const batchSize = await getSettingInt(env.DB, "collect_batch_size");
  const now = nowMs();
  const waiting = await env.DB.prepare(
    "SELECT id FROM collect_task WHERE status = 'waiting' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY id ASC LIMIT ?",
  )
    .bind(now, Math.max(1, batchSize))
    .all<{ id: number }>();
  let claimed = 0;
  for (const row of waiting.results ?? []) {
    // 认领：只有仍为 waiting 的行才能抢到（防并发重复处理）
    const res = await env.DB.prepare("UPDATE collect_task SET status = 'running', started_at = ? WHERE id = ? AND status = 'waiting'")
      .bind(now, row.id)
      .run();
    if ((res.meta.changes ?? 0) === 0) continue;
    claimed++;
    try {
      await processTask(env, row.id);
    } catch (e) {
      // 引擎自身异常兜底：任务标失败，不阻塞下一账号
      const { code, message } = classifyError(e);
      await env.DB.prepare("UPDATE collect_task SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ?")
        .bind(code, message, nowMs(), row.id)
        .run();
    }
  }
  return { claimed };
}
