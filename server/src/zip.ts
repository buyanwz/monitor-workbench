// ZIP 下载：按需生成＋缓存、HMAC 签名链接、Range 流式放行。
// ZIP 格式（设计 R8/R9）：解压后为文件夹 平台_账号_作品ID_发布时间/，内含 视频.mp4＋文案.txt。
// ZIP 写 STORE（不压缩，视频已压缩）+ CRC32，文件名 UTF-8（flag bit 11），无第三方依赖。

import { newNonce, sha256HexBytes, signDownloadToken, verifyDownloadToken } from "./crypto";
import {
  authenticate,
  clientIp,
  err,
  getSettingInt,
  json,
  nowMs,
  opLog,
  rateLimit,
  unauthorized,
  type Env,
} from "./db";
import { readJsonBody, safeSegment, shanghaiDateTime, shanghaiFileStamp } from "./util";
import type { BucketObjectBody } from "./localbucket";

// ---- CRC32（标准 IEEE 多项式） ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTimeDate(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

export interface ZipEntry {
  name: string; // ZIP 内路径（UTF-8），目录以 / 结尾
  data: ArrayBuffer; // 目录条目传空 buffer
  isDir?: boolean;
}

/** 生成 STORE 方式的 ZIP（本地头＋中央目录＋EOCD）。 */
export function buildZip(entries: ZipEntry[], now: number): ArrayBuffer {
  const { time, date } = dosTimeDate(now);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = new Uint8Array(e.data);
    const crc = e.isDir ? 0 : crc32(data);
    const size = e.isDir ? 0 : data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 文件名
    local.setUint16(8, 0, true); // STORE
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, size, true);
    cen.setUint32(24, size, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint16(30, 0, true);
    cen.setUint16(32, 0, true);
    cen.setUint16(34, 0, true);
    cen.setUint16(36, 0, true);
    cen.setUint32(38, e.isDir ? 0x10 : 0, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + size;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  return out.buffer as ArrayBuffer;
}

/** 文案.txt 内容（设计 R9）：5 行 UTF-8，缺失字段写“未知”不空行。 */
export function buildTxtContent(work: {
  title: string;
  topics: string;
  origin_url: string;
  published_at: number;
  collected_finished_at: number;
}): string {
  let topics: string[] = [];
  try {
    const parsed = JSON.parse(work.topics);
    if (Array.isArray(parsed)) topics = parsed.filter((t) => typeof t === "string");
  } catch {
    topics = [];
  }
  const title = work.title?.trim() ? work.title.trim() : "未知";
  const topicLine = topics.length > 0 ? topics.map((t) => `#${t}`).join(" ") : "未知";
  const link = work.origin_url?.trim() ? work.origin_url.trim() : "未知";
  const published = work.published_at ? shanghaiDateTime(work.published_at) : "未知";
  const collected = shanghaiDateTime(work.collected_finished_at);
  return [`标题：${title}`, `话题：${topicLine}`, `作品链接：${link}`, `发布时间：${published}`, `采集时间：${collected}`].join("\n") + "\n";
}

/** ZIP 内目录名：平台_账号_作品ID_发布时间（各段安全处理）。 */
export function zipFolderName(platform: string, accountName: string, workId: string, publishedAt: number): string {
  const seg = (s: string, fb: string) => safeSegment(s, fb);
  return `${seg(platform, "platform")}_${seg(accountName, "account")}_${seg(workId, "work")}_${shanghaiFileStamp(publishedAt)}`;
}

// ---- 并发生成限制（本 isolate 内计数，超限 429；设计 M5） ----
let activeZipGenerations = 0;

interface WorkDownloadRow {
  id: number;
  platform: string;
  work_id: string;
  account_id: number;
  title: string;
  topics: string;
  origin_url: string;
  published_at: number;
  collected_finished_at: number;
  expires_at: number;
  account_name: string;
}

/** 申请下载：生成/取缓存 ZIP，返回签名链接。须勾选“仅限内部使用”（M8 合规）。 */
export async function handleRequestDownload(env: Env, req: Request, workId: number): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  if (!rateLimit(`download:${clientIp(req)}`, 10, 60_000)) return err("下载请求太频繁，请稍后再试", 429);
  if (!env.DOWNLOAD_SIGNING_KEY) return err("服务端未配置下载签名密钥", 500);
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  if (body.confirm_internal_use !== true) return err("请先确认下载内容仅限内部使用", 400);

  const work = await env.DB.prepare(
    "SELECT w.id, w.platform, w.work_id, w.account_id, w.title, w.topics, w.origin_url, w.published_at, w.collected_finished_at, w.expires_at, a.name AS account_name FROM work w LEFT JOIN monitor_account a ON a.id = w.account_id WHERE w.id = ?",
  )
    .bind(workId)
    .first<WorkDownloadRow>();
  if (!work) return err("作品不存在", 404);
  const now = nowMs();
  if (work.expires_at <= now) return err("该作品已过期，文件已清理", 410);

  const video = await env.DB.prepare("SELECT id, storage_path, expires_at FROM file_asset WHERE work_id = ? AND kind = 'video'")
    .bind(workId)
    .first<{ id: number; storage_path: string; expires_at: number }>();
  if (!video || video.expires_at <= now) {
    await env.DB.prepare("INSERT INTO download_record (work_id, zip_asset_id, downloaded_by, downloaded_at, status, error_message) VALUES (?, NULL, '本人', ?, 'failed', '视频文件缺失或已过期')")
      .bind(workId, now)
      .run();
    return err("该作品视频文件缺失或已过期，无法下载", 404);
  }

  // 缓存 ZIP：未过期则直接复用
  let zipAsset = await env.DB.prepare("SELECT id, storage_path, expires_at FROM file_asset WHERE work_id = ? AND kind = 'zip'")
    .bind(workId)
    .first<{ id: number; storage_path: string; expires_at: number }>();
  if (zipAsset && zipAsset.expires_at <= now) {
    await env.BUCKET.delete(zipAsset.storage_path);
    await env.DB.prepare("DELETE FROM file_asset WHERE id = ?").bind(zipAsset.id).run();
    zipAsset = null;
  }
  if (!zipAsset) {
    const maxConcurrent = await getSettingInt(env.DB, "max_concurrent_zip");
    if (activeZipGenerations >= Math.max(1, maxConcurrent)) {
      return err("正在生成的下载太多，请稍后重试", 429);
    }
    activeZipGenerations++;
    try {
      const videoObj = await env.BUCKET.get(video.storage_path);
      if (!videoObj) return err("视频文件丢失，请重新采集", 404);
      const videoBytes = await videoObj.arrayBuffer();
      const folder = zipFolderName(work.platform, work.account_name ?? "account", work.work_id, work.published_at);
      const txt = new TextEncoder().encode(buildTxtContent(work));
      const zipBytes = buildZip(
        [
          { name: `${folder}/`, data: new ArrayBuffer(0), isDir: true },
          { name: `${folder}/视频.mp4`, data: videoBytes },
          { name: `${folder}/文案.txt`, data: txt.buffer as ArrayBuffer },
        ],
        now,
      );
      const zipPath = `zips/${work.platform}/${work.work_id}/package.zip`;
      await env.BUCKET.put(zipPath, zipBytes, { httpMetadata: { contentType: "application/zip" } });
      const sha = await sha256HexBytes(zipBytes);
      await env.DB.prepare(
        "INSERT INTO file_asset (work_id, kind, storage_path, size_bytes, sha256, expires_at, created_at) VALUES (?, 'zip', ?, ?, ?, ?, ?) " +
          "ON CONFLICT(work_id, kind) DO UPDATE SET storage_path = excluded.storage_path, size_bytes = excluded.size_bytes, sha256 = excluded.sha256, expires_at = excluded.expires_at, created_at = excluded.created_at",
      )
        .bind(workId, zipPath, zipBytes.byteLength, sha, work.expires_at, now)
        .run();
      zipAsset = await env.DB.prepare("SELECT id, storage_path, expires_at FROM file_asset WHERE work_id = ? AND kind = 'zip'")
        .bind(workId)
        .first<{ id: number; storage_path: string; expires_at: number }>();
    } finally {
      activeZipGenerations--;
    }
    if (!zipAsset) return err("ZIP 生成失败，请重试", 500);
  }

  const ttl = await getSettingInt(env.DB, "download_link_ttl_minutes");
  const exp = now + ttl * 60 * 1000;
  const token = await signDownloadToken(env.DOWNLOAD_SIGNING_KEY, { asset_id: zipAsset.id, exp, nonce: newNonce() });
  const url = new URL(req.url);
  const downloadUrl = `${url.origin}/api/v1/files/download?token=${token}`;
  const folder = zipFolderName(work.platform, work.account_name ?? "account", work.work_id, work.published_at);
  await env.DB.prepare("INSERT INTO download_record (work_id, zip_asset_id, downloaded_by, downloaded_at, status) VALUES (?, ?, '本人', ?, 'success')")
    .bind(workId, zipAsset.id, now)
    .run();
  await env.DB.prepare("UPDATE work SET downloaded = 1 WHERE id = ?").bind(workId).run();
  await opLog(env.DB, "download", "work", workId, `申请下载 ZIP：${folder}.zip，链接 ${ttl} 分钟有效`);
  return json({ ok: true, download_url: downloadUrl, filename: `${folder}.zip`, expires_at: exp });
}

export async function handleListDownloadRecords(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const url = new URL(req.url);
  const workId = url.searchParams.get("work_id");
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") ?? 20) || 20));
  let where = "WHERE 1=1";
  const binds: unknown[] = [];
  if (workId) {
    where += " AND d.work_id = ?";
    binds.push(Number(workId));
  }
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM download_record d ${where}`)
    .bind(...binds)
    .first<{ c: number }>();
  const rows = await env.DB.prepare(
    `SELECT d.id, d.work_id, d.zip_asset_id, d.downloaded_by, d.downloaded_at, d.status, d.error_message, w.title, w.work_id AS platform_work_id FROM download_record d LEFT JOIN work w ON w.id = d.work_id ${where} ORDER BY d.downloaded_at DESC, d.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, pageSize, (page - 1) * pageSize)
    .all();
  return json({ ok: true, records: rows.results ?? [], total: countRow?.c ?? 0, page, page_size: pageSize });
}

// ---- 签名文件放行：校验 HMAC + 过期 + 资产存在性，支持 Range 流式 ----

function parseRange(header: string, size: number): { offset: number; length: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  if (m[1] === "" && m[2] === "") return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  if (!Number.isInteger(start) || start >= size) return null;
  const end = m[2] === "" ? size - 1 : Number(m[2]);
  if (!Number.isInteger(end) || end < start) return null;
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

export async function handleFileDownload(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return err("缺少下载签名，请重新点下载", 403);
  if (!env.DOWNLOAD_SIGNING_KEY) return err("服务端未配置下载签名密钥", 500);
  const payload = await verifyDownloadToken(env.DOWNLOAD_SIGNING_KEY, token);
  if (!payload) return err("下载链接已过期或无效，请重新点下载", 403);

  const asset = await env.DB.prepare(
    "SELECT fa.id, fa.work_id, fa.kind, fa.storage_path, fa.size_bytes, fa.expires_at, w.platform, w.work_id AS platform_work_id, w.published_at, a.name AS account_name FROM file_asset fa LEFT JOIN work w ON w.id = fa.work_id LEFT JOIN monitor_account a ON a.id = w.account_id WHERE fa.id = ?",
  )
    .bind(payload.asset_id)
    .first<{
      id: number;
      work_id: number;
      kind: string;
      storage_path: string;
      size_bytes: number;
      expires_at: number;
      platform: string;
      platform_work_id: string;
      published_at: number;
      account_name: string | null;
    }>();
  if (!asset) return err("文件不存在或已被清理", 404);
  const now = nowMs();
  if (asset.expires_at <= now) return err("文件已过期失效，请重新采集", 410);

  const rangeHeader = req.headers.get("Range");
  let obj: BucketObjectBody | null;
  let status = 200;
  let contentRange: string | undefined;
  if (rangeHeader) {
    const range = parseRange(rangeHeader, asset.size_bytes);
    if (!range) {
      return new Response("Range 不合法", { status: 416, headers: { "Content-Range": `bytes */${asset.size_bytes}` } });
    }
    obj = await env.BUCKET.get(asset.storage_path, { range: { offset: range.offset, length: range.length } });
    if (!obj) return err("文件丢失", 404);
    status = 206;
    contentRange = `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size_bytes}`;
  } else {
    obj = await env.BUCKET.get(asset.storage_path);
    if (!obj) return err("文件丢失", 404);
  }

  const contentType =
    asset.kind === "zip" ? "application/zip" : asset.kind === "cover" ? "image/jpeg" : "video/mp4";
  let filename: string;
  if (asset.kind === "zip") {
    const folder = zipFolderName(asset.platform, asset.account_name ?? "account", asset.platform_work_id, asset.published_at);
    filename = `${folder}.zip`;
  } else if (asset.kind === "cover") {
    filename = `${asset.platform_work_id}_cover.jpg`;
  } else {
    filename = `${asset.platform_work_id}.mp4`;
  }
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(obj.size),
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${asset.kind === "zip" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, no-store",
  };
  if (contentRange) headers["Content-Range"] = contentRange;
  if (req.method === "HEAD") return new Response(null, { status, headers });
  return new Response(obj.body, { status, headers });
}
