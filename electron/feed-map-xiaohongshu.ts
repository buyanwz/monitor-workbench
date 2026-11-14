// 小红书 user_posted 返回正文 → FetchedWork 映射（纯函数，无 Electron/Node 依赖）。
// 字段出处：扩展代码已证实（content.js，探针报告 X1 节证据索引）。
// 接受三种输入形态（同一笔记形状，不同包裹）：
//   1. user_posted 信封 {success, code, msg, data: {notes: [...]}}（截获主路）；
//   2. {notes: [...]}；3. 裸笔记数组（__INITIAL_STATE__ 补充捕获源）。
//   work_id     = note_id
//   origin_url  = https://www.xiaohongshu.com/explore/<note_id>，note/user 对象上
//                 若带 xsec_token/xsec_source 则原样附在查询参数里
//   标题        = display_title（缺失时退回 title）
//   话题        = 未知：字段定义中无话题字段，留空并如实记录，不得编造（R-X4）
//   点赞        = interact_info.liked_count
//   发布时间    = time（毫秒；小于 1e12 时按秒换算）
//   封面        = image_list[0] 自身的 URL（url / url_default / url_pre 依次取，
//                 扩展的 tl() 还会重写 CDN host 与格式，这里直接用原 URL，
//                 重写依赖的 VIP 判定在 exe 里不存在，实测确认）
//   播放地址    = 两条路径（cGe 原样）：
//                 ① video.consumer.origin_video_key 存在 →
//                    https://sns-video-bd.xhscdn.com/<key>（扩展在 hw/bd 两 host
//                    间随机选，这里固定用 bd，与 tl() 的非 VIP 默认一致）；
//                 ② 否则 T7 清晰度表：video.media.stream 各清晰度取
//                    1080P → 720P → 2K → highest，URL 取 master_url 或 backup_urls[0]
//   图文笔记    = type 存在且不为 "video"：无视频文件，按已定保守默认不入库，计入 skippedCount。
//   置顶        = interact_info.sticky（bJ @2608537 已证实）：
//                 is_pinned = !!interact_info.sticky，has_pinned_field=true。
// 信封语义（xc/拦截器已证实）：success===false 或 code!==1000 → 失败，带 msg。
// 登录门禁（yGe @2607601 已证实）：notes 里有笔记缺 note_id → 须登录。

import { FetcherError, type FetchedWork } from "../server/src/fetcher";
import { asRecord, asString, normalizeTimestamp, toNumber, type MapResult } from "./feed-map-common";

const VIDEO_CDN_HOST = "https://sns-video-bd.xhscdn.com";

/** 清晰度分桶（dGe 原样）：按宽高中较小边分档。 */
function clarityKey(width: unknown, height: unknown): string {
  const n = Math.min(toNumber(width, 0), toNumber(height, 0));
  if (n < 720) return "540P";
  if (n <= 900) return "720P";
  if (n < 1440) return "1080P";
  if (n < 2160) return "2K";
  return "4K";
}

/**
 * 清晰度表（T7 原样）：media.stream 各条目按清晰度分桶，桶内只留 mp4 更大者；
 * highest/lowest 取 [4K, 2K, 1080P, 720P, 540P] 中首个/末个现档。
 */
function clarityTable(video: Record<string, unknown>): Record<string, { url: string; data_size: number }> {
  const media = asRecord(video.media);
  const stream = media ? asRecord(media.stream) : null;
  if (!stream) return {};
  let entries: Record<string, unknown>[] = [];
  for (const v of Object.values(stream)) {
    if (!Array.isArray(v)) continue;
    for (const e of v) {
      const r = asRecord(e);
      if (r) entries.push(r);
    }
  }
  entries = entries.filter(
    (e) => (typeof e.master_url === "string" && e.master_url) || (Array.isArray(e.backup_urls) && e.backup_urls.length > 0),
  );
  const withAudio = entries.filter((e) => toNumber(e.audio_bitrate, 0) > 0 || toNumber(e.audio_channels, 0) > 0);
  if (withAudio.length > 0) entries = withAudio;
  const filtered = entries.filter(
    (e) => !(typeof e.stream_desc === "string" && e.stream_desc.startsWith("WM_")) && e.stream_type !== 259,
  );
  if (filtered.length > 0) entries = filtered;
  const table: Record<string, { url: string; data_size: number }> = {};
  for (const c of entries) {
    const backup = Array.isArray(c.backup_urls) ? c.backup_urls : [];
    const url =
      typeof c.master_url === "string" && c.master_url
        ? c.master_url
        : typeof backup[0] === "string"
          ? backup[0]
          : "";
    if (!url) continue;
    const key = clarityKey(c.width, c.height);
    const size = toNumber(c.size, 0);
    const prev = table[key];
    if (!prev) {
      table[key] = { url, data_size: size };
    } else if (c.format === "mp4" && (prev.data_size ?? 0) < size) {
      table[key] = { url, data_size: size };
    }
  }
  const order = ["4K", "2K", "1080P", "720P", "540P"];
  const present = order.filter((k) => table[k]);
  if (present.length > 0) {
    table.highest = table[present[0]];
    table.lowest = table[present[present.length - 1]];
  }
  return table;
}

/** 播放地址（cGe 原样）：origin_video_key 路径优先，否则清晰度表。 */
function pickVideoUrl(video: Record<string, unknown> | null): string {
  if (!video) return "";
  const consumer = asRecord(video.consumer);
  const key = consumer ? asString(consumer.origin_video_key) : "";
  if (key) return `${VIDEO_CDN_HOST}/${key}`;
  const table = clarityTable(video);
  const pick = table["1080P"] || table["720P"] || table["2K"] || table.highest;
  return pick ? pick.url : "";
}

function pickCoverUrl(note: Record<string, unknown>): string {
  const list = Array.isArray(note.image_list) ? note.image_list : [];
  const first = list[0];
  if (typeof first === "string") return first;
  const img = asRecord(first);
  if (!img) return "";
  return asString(img.url) || asString(img.url_default) || asString(img.url_pre);
}

function pickOriginUrl(note: Record<string, unknown>, id: string): string {
  const base = `https://www.xiaohongshu.com/explore/${id}`;
  const user = asRecord(note.user);
  const token = asString(note.xsec_token) || (user ? asString(user.xsec_token) : "");
  const source = asString(note.xsec_source) || (user ? asString(user.xsec_source) : "");
  const params = new URLSearchParams();
  if (token) params.set("xsec_token", token);
  if (source) params.set("xsec_source", source);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** 解析 user_posted 返回正文（或等价笔记数组）；分类错误直接抛 FetcherError。 */
export function parseXiaohongshuResponse(bodyText: string): MapResult {
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new FetcherError("other", "作品列表返回的不是合法 JSON");
  }

  let notes: unknown[];
  const root = asRecord(data);
  if (Array.isArray(data)) {
    notes = data;
  } else if (!root) {
    throw new FetcherError("other", "作品列表返回结构异常");
  } else {
    // 信封错误：success===false 或 code!==1000（拦截器语义）
    const msg = asString(root.msg) || asString(root.message);
    if (root.success === false) {
      throw new FetcherError("other", msg ? msg.slice(0, 200) : "小红书接口返回失败");
    }
    if (typeof root.code === "number" && root.code !== 1000) {
      throw new FetcherError("other", msg ? msg.slice(0, 200) : `小红书接口返回异常（code=${root.code})`);
    }
    const d = asRecord(root.data);
    if (d && Array.isArray(d.notes)) {
      notes = d.notes;
    } else if (Array.isArray(root.notes)) {
      notes = root.notes;
    } else {
      throw new FetcherError("other", "作品列表返回结构异常（缺少 notes）");
    }
  }

  // 登录门禁（yGe 原样）：有笔记缺 note_id → 未登录
  for (const n of notes) {
    const note = asRecord(n);
    if (!note || !note.note_id) {
      throw new FetcherError("login_expired", "小红书要求先登录，请在小红书登录窗口登录");
    }
  }

  const works: FetchedWork[] = [];
  let skippedCount = 0;
  for (const item of notes) {
    const note = asRecord(item);
    if (!note) continue;
    const id = String(note.note_id);
    const type = asString(note.type);
    if (type && type !== "video") {
      skippedCount++; // 图文笔记：无视频文件，不入库
      continue;
    }
    const interact = asRecord(note.interact_info);
    const video = asRecord(note.video);
    works.push({
      work_id: id,
      title: asString(note.display_title) || asString(note.title),
      topics: [], // 话题字段未知：无证据，不得编造（R-X4）
      cover_url: pickCoverUrl(note),
      video_url: pickVideoUrl(video),
      origin_url: pickOriginUrl(note, id),
      published_at: normalizeTimestamp(note.time),
      likes: Math.max(0, Math.floor(toNumber(interact ? interact.liked_count : undefined, 0))),
      is_pinned: !!interact?.sticky,
    });
  }
  return { works, skippedCount };
}

/**
 * 字段清单（取证用）：列出第一条笔记里笔记层、interact_info 层、video 层、
 * 首图层的全部字段名，供人工核对 sticky 字段与话题/游标字段是否存在。
 */
export function collectXiaohongshuFieldInventory(data: unknown): {
  note_keys: string[];
  interact_info_keys: string[];
  video_keys: string[];
  image_keys: string[];
  note_count: number;
} {
  let notes: unknown[] = [];
  if (Array.isArray(data)) {
    notes = data;
  } else {
    const root = asRecord(data);
    const d = root ? asRecord(root.data) : null;
    if (d && Array.isArray(d.notes)) notes = d.notes;
    else if (root && Array.isArray(root.notes)) notes = root.notes;
  }
  const first = notes.length > 0 ? asRecord(notes[0]) : null;
  const interact = first ? asRecord(first.interact_info) : null;
  const video = first ? asRecord(first.video) : null;
  const images = first && Array.isArray(first.image_list) ? first.image_list : [];
  const firstImage = images.length > 0 ? asRecord(images[0]) : null;
  return {
    note_keys: first ? Object.keys(first).sort() : [],
    interact_info_keys: interact ? Object.keys(interact).sort() : [],
    video_keys: video ? Object.keys(video).sort() : [],
    image_keys: firstImage ? Object.keys(firstImage).sort() : [],
    note_count: notes.length,
  };
}
