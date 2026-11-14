// 作品库：平台分组、组内排序切换、筛选、稳定分页、详情、预览签名链接。
// 排序：点赞数取最近一次快照；决胜键 work_id，保证分页稳定（设计 R5/R7）。

import { newNonce, signDownloadToken } from "./crypto";
import { authenticate, err, getSettingInt, json, nowMs, unauthorized, type Env } from "./db";
import { DAY_MS, shanghaiDateTime } from "./util";

const LIKES_SUBQUERY =
  "(SELECT s.likes FROM work_snapshot s WHERE s.work_id = w.id ORDER BY s.collected_at DESC, s.id DESC LIMIT 1)";

interface WorkRow {
  id: number;
  platform: string;
  work_id: string;
  account_id: number;
  account_name: string | null;
  title: string;
  topics: string;
  cover_url: string | null;
  video_url: string | null;
  origin_url: string;
  published_at: number;
  is_pinned: number;
  collected_at: number;
  collected_finished_at: number;
  expires_at: number;
  retention_days: number;
  downloaded: number;
  file_status: string;
  likes: number | null;
  has_video: number;
  has_cover: number;
  has_zip: number;
}

function publicWork(r: WorkRow) {
  let topics: string[] = [];
  try {
    const parsed = JSON.parse(r.topics);
    if (Array.isArray(parsed)) topics = parsed.filter((t) => typeof t === "string");
  } catch {
    topics = [];
  }
  return {
    id: r.id,
    platform: r.platform,
    work_id: r.work_id,
    account_id: r.account_id,
    account_name: r.account_name,
    title: r.title,
    topics,
    origin_url: r.origin_url,
    published_at: r.published_at,
    published_at_text: shanghaiDateTime(r.published_at),
    likes: r.likes ?? 0,
    collected_at: r.collected_at,
    collected_finished_at: r.collected_finished_at,
    expires_at: r.expires_at,
    retention_days: r.retention_days,
    downloaded: r.downloaded === 1,
    file_status: r.file_status,
    has_video: r.has_video === 1,
    has_cover: r.has_cover === 1,
    has_zip: r.has_zip === 1,
  };
}

const WORK_SELECT = `
  w.id, w.platform, w.work_id, w.account_id, a.name AS account_name, w.title, w.topics,
  w.cover_url, w.video_url, w.origin_url, w.published_at, w.is_pinned, w.collected_at,
  w.collected_finished_at, w.expires_at, w.retention_days, w.downloaded, w.file_status,
  ${LIKES_SUBQUERY} AS likes,
  EXISTS(SELECT 1 FROM file_asset fa WHERE fa.work_id = w.id AND fa.kind = 'video') AS has_video,
  EXISTS(SELECT 1 FROM file_asset fa WHERE fa.work_id = w.id AND fa.kind = 'cover') AS has_cover,
  EXISTS(SELECT 1 FROM file_asset fa WHERE fa.work_id = w.id AND fa.kind = 'zip') AS has_zip
  FROM work w LEFT JOIN monitor_account a ON a.id = w.account_id`;

export async function handleListWorks(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform");
  const accountId = url.searchParams.get("account_id");
  const date = url.searchParams.get("date"); // 采集日期（北京时间 YYYY-MM-DD）
  const downloaded = url.searchParams.get("downloaded");
  const sort = url.searchParams.get("sort") === "likes_desc" ? "likes_desc" : "published_desc";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") ?? 20) || 20));

  let where = "WHERE 1=1";
  const binds: unknown[] = [];
  if (platform) {
    where += " AND w.platform = ?";
    binds.push(platform);
  }
  if (accountId) {
    where += " AND w.account_id = ?";
    binds.push(Number(accountId));
  }
  if (downloaded === "0" || downloaded === "1") {
    where += " AND w.downloaded = ?";
    binds.push(Number(downloaded));
  }
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const start = Date.parse(`${date}T00:00:00+08:00`);
    where += " AND w.collected_finished_at >= ? AND w.collected_finished_at < ?";
    binds.push(start, start + DAY_MS);
  }

  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM work w ${where}`)
    .bind(...binds)
    .first<{ c: number }>();

  // 第一层固定按平台分组；组内按所选规则排序；work_id 作决胜键保证分页稳定
  const orderKey = sort === "likes_desc" ? `${LIKES_SUBQUERY} DESC` : "w.published_at DESC";
  const rows = await env.DB.prepare(
    `SELECT ${WORK_SELECT} ${where} ORDER BY w.platform ASC, ${orderKey}, w.work_id ASC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, pageSize, (page - 1) * pageSize)
    .all<WorkRow>();

  const works = (rows.results ?? []).map(publicWork);
  const groups: Array<{ platform: string; works: typeof works }> = [];
  for (const w of works) {
    const g = groups.find((x) => x.platform === w.platform);
    if (g) g.works.push(w);
    else groups.push({ platform: w.platform, works: [w] });
  }
  return json({ ok: true, groups, total: countRow?.c ?? 0, page, page_size: pageSize, sort });
}

export async function handleGetWork(env: Env, req: Request, id: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const row = await env.DB.prepare(`SELECT ${WORK_SELECT} WHERE w.id = ?`).bind(id).first<WorkRow>();
  if (!row) return err("作品不存在", 404);
  const assets = await env.DB.prepare("SELECT kind, size_bytes, expires_at, created_at FROM file_asset WHERE work_id = ?")
    .bind(id)
    .all<{ kind: string; size_bytes: number; expires_at: number; created_at: number }>();
  const snapshots = await env.DB.prepare(
    "SELECT likes, collected_at, task_id FROM work_snapshot WHERE work_id = ? ORDER BY collected_at DESC, id DESC LIMIT 10",
  )
    .bind(id)
    .all<{ likes: number; collected_at: number; task_id: number | null }>();
  return json({ ok: true, work: publicWork(row), assets: assets.results ?? [], snapshots: snapshots.results ?? [] });
}

/** 预览：为视频与封面资产签发临时链接（默认 30 分钟过期，可配）。 */
export async function handlePreview(env: Env, req: Request, id: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  if (!env.DOWNLOAD_SIGNING_KEY) return err("服务端未配置下载签名密钥", 500);
  const work = await env.DB.prepare("SELECT id, expires_at FROM work WHERE id = ?").bind(id).first<{ id: number; expires_at: number }>();
  if (!work) return err("作品不存在", 404);
  const ttl = await getSettingInt(env.DB, "download_link_ttl_minutes");
  const exp = nowMs() + ttl * 60 * 1000;
  const assets = await env.DB.prepare("SELECT id, kind, expires_at FROM file_asset WHERE work_id = ? AND kind IN ('video', 'cover')")
    .bind(id)
    .all<{ id: number; kind: string; expires_at: number }>();
  const now = nowMs();
  const out: Record<string, string | null> = { video_url: null, cover_url: null };
  for (const a of assets.results ?? []) {
    if (a.expires_at <= now) continue;
    const token = await signDownloadToken(env.DOWNLOAD_SIGNING_KEY, { asset_id: a.id, exp, nonce: newNonce() });
    const url = new URL(req.url);
    out[a.kind === "video" ? "video_url" : "cover_url"] = `${url.origin}/api/v1/files/download?token=${token}`;
  }
  if (!out.video_url && !out.cover_url) return err("该作品暂无可预览的文件（可能已过期或文件缺失）", 404);
  return json({ ok: true, ...out, expires_at: exp });
}
