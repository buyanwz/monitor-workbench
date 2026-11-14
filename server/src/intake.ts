// 扩展/手动上报：兜底输入，写入同一 work 表，走同一去重与保留规则（设计 A7）。
// 上报只存元数据与快照（file_status='missing'），不下载媒体——媒体由定时采集补齐，
// 因为上报链路的播放链接需登录态，Worker 侧无权直接取用。置顶作品同样排除。

import { authenticate, authenticateIntakeToken, err, getSettingInt, json, nowMs, opLog, unauthorized, type Env } from "./db";
import { PLATFORMS } from "./accounts";
import { DAY_MS, readJsonBody, reqInt, reqString } from "./util";

interface IntakeWork {
  work_id: string;
  title: string;
  topics?: string[];
  cover_url?: string;
  video_url?: string;
  origin_url: string;
  published_at: number;
  likes: number;
  is_pinned?: boolean;
}

function validIntakeWork(w: unknown): IntakeWork | null {
  if (typeof w !== "object" || w === null) return null;
  const o = w as Record<string, unknown>;
  const workId = reqString(o.work_id, 200);
  const title = reqString(o.title, 500);
  const originUrl = reqString(o.origin_url, 1000);
  const publishedAt = reqInt(o.published_at, 0, Number.MAX_SAFE_INTEGER);
  const likes = reqInt(o.likes, 0, Number.MAX_SAFE_INTEGER);
  if (!workId || !title || !originUrl || publishedAt === null || likes === null) return null;
  const topics = Array.isArray(o.topics) ? o.topics.filter((t) => typeof t === "string").slice(0, 20) : [];
  return {
    work_id: workId,
    title,
    topics,
    cover_url: typeof o.cover_url === "string" ? o.cover_url.slice(0, 1000) : undefined,
    video_url: typeof o.video_url === "string" ? o.video_url.slice(0, 1000) : undefined,
    origin_url: originUrl,
    published_at: publishedAt,
    likes,
    is_pinned: o.is_pinned === true,
  };
}

/** 上报令牌查看（仅会话鉴权后可见；令牌本身不能用来调这个接口）。 */
export async function handleGetIntakeToken(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  if (!env.INTAKE_TOKEN) return err("上报令牌未配置", 500);
  return json({ ok: true, token: env.INTAKE_TOKEN });
}

/** 上报令牌轮换（仅会话鉴权；旧令牌立即失效）。环境变量模式下不可轮换。 */
export async function handleRotateIntakeToken(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  if (!env.rotateIntakeToken) return err("当前为环境变量模式，不可轮换上报令牌", 400);
  const token = await env.rotateIntakeToken();
  await opLog(env.DB, "intake_token_rotate", "settings", null, "上报令牌已轮换（旧令牌立即失效）");
  return json({ ok: true, token });
}

export async function handleIntakeReport(env: Env, req: Request): Promise<Response> {
  // 鉴权两条路：会话令牌（界面手动上报）或上报专用令牌（扩展上报）；后者只在此接口有效
  const session = await authenticate(env, req);
  if (!session && !(await authenticateIntakeToken(env, req))) return unauthorized();
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const platform = reqString(body.platform, 32);
  const accountIdStr = reqString(body.account_id, 200);
  if (!platform || !(PLATFORMS as readonly string[]).includes(platform)) return err("平台不在支持范围内", 400);
  if (!accountIdStr) return err("平台账号ID不能为空", 400);
  if (!Array.isArray(body.works) || body.works.length === 0 || body.works.length > 50) {
    return err("works 须为 1～50 条的数组", 400);
  }
  const account = await env.DB.prepare("SELECT id, name, status FROM monitor_account WHERE platform = ? AND account_id = ?")
    .bind(platform, accountIdStr)
    .first<{ id: number; name: string; status: string }>();
  if (!account) return err("账号不存在，请先在账号管理中新增", 404);
  if (account.status !== "active") return err("账号已停用", 409);

  const retentionDays = await getSettingInt(env.DB, "retention_days");
  const now = nowMs();
  const expiresAt = now + retentionDays * DAY_MS;
  let created = 0;
  let updated = 0;
  let skippedPinned = 0;
  for (const raw of body.works) {
    const w = validIntakeWork(raw);
    if (!w) return err("作品字段不合法（work_id/title/origin_url/published_at/likes 必填）", 400);
    if (w.is_pinned) {
      skippedPinned++;
      continue;
    }
    const existing = await env.DB.prepare("SELECT id FROM work WHERE platform = ? AND work_id = ?")
      .bind(platform, w.work_id)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO work (platform, work_id, account_id, title, topics, cover_url, video_url, origin_url, published_at, is_pinned, collected_at, collected_finished_at, expires_at, retention_days, file_status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'missing') " +
        "ON CONFLICT(platform, work_id) DO UPDATE SET title = excluded.title, topics = excluded.topics, cover_url = excluded.cover_url, video_url = excluded.video_url, origin_url = excluded.origin_url, published_at = excluded.published_at, collected_finished_at = excluded.collected_finished_at, expires_at = excluded.expires_at, retention_days = excluded.retention_days",
    )
      .bind(
        platform,
        w.work_id,
        account.id,
        w.title,
        JSON.stringify(w.topics ?? []),
        w.cover_url ?? null,
        w.video_url ?? null,
        w.origin_url,
        w.published_at,
        now,
        now,
        expiresAt,
        retentionDays,
      )
      .run();
    const row = await env.DB.prepare("SELECT id FROM work WHERE platform = ? AND work_id = ?")
      .bind(platform, w.work_id)
      .first<{ id: number }>();
    if (row) {
      await env.DB.prepare("INSERT INTO work_snapshot (work_id, likes, collected_at, task_id) VALUES (?, ?, ?, NULL)")
        .bind(row.id, w.likes, now)
        .run();
    }
    if (existing) updated++;
    else created++;
  }
  await opLog(env.DB, "intake", "account", account.id, `扩展/手动上报：新增 ${created} 条，更新 ${updated} 条，跳过置顶 ${skippedPinned} 条`);
  return json({ ok: true, created, updated, skipped_pinned: skippedPinned });
}
