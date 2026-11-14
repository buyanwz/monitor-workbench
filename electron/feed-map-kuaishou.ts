// 快手 feed 返回正文 → FetchedWork 映射（纯函数，无 Electron/Node 依赖）。
// 字段出处：扩展拆解已证实（content.js /rest/v/profile/feed 响应结构）。
//   work_id     = feed.photo.id
//   origin_url  = https://www.kuaishou.com/short-video/<photo.id>
//   标题        = feed.photo.caption
//   话题        = feed.tags[].name（tags 在 feed 层，不在 photo 里）
//   点赞        = feed.photo.likeCount
//   发布时间    = feed.photo.timestamp（毫秒；小于 1e12 时按秒换算）
//   封面        = feed.photo.coverUrl
//   播放地址    = feed.photo.photoUrls 数组最后一条的 .url
// 置顶字段：扩展代码里 0 命中，无证据——这里不编字段名，is_pinned 一律不填，
// 调用方必须以 has_pinned_field=false 上报，批次走 needs_review 不入库（P5/R4）。
// result 码语义（扩展 axios 拦截器已证实）：
//   400002 (+验证码 URL) → 验证码；2056 / 带 loginUrl → 须登录；
//   7935 → 平台系统保护；errors[] 含 "Need captcha" → 验证码。

import { FetcherError, type FetchedWork } from "../server/src/fetcher";
import { asRecord, normalizeTimestamp, toNumber } from "./feed-map-common";

/** 解析 feed 返回正文，返回映射后的作品列表；分类错误直接抛 FetcherError。 */
export function parseFeedResponse(bodyText: string): FetchedWork[] {
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new FetcherError("other", "作品列表返回的不是合法 JSON");
  }
  const root = asRecord(data);
  if (!root) throw new FetcherError("other", "作品列表返回结构异常");

  const result = root.result;
  const errors = Array.isArray(root.errors) ? root.errors.map(String) : [];
  if (result === 400002 || errors.some((e) => /need captcha/i.test(e))) {
    throw new FetcherError("captcha", "触发验证码，请在快手登录窗口手动处理");
  }
  if (result === 2056 || typeof root.loginUrl === "string") {
    throw new FetcherError("login_expired", "快手要求重新登录，请在快手登录窗口重新登录");
  }
  if (result === 7935) {
    throw new FetcherError("other", "平台系统保护（7935），请稍后重试");
  }
  if (result !== 1) {
    const msg = typeof root.error_msg === "string" && root.error_msg ? root.error_msg.slice(0, 200) : `平台返回异常（result=${String(result)})`;
    throw new FetcherError("other", msg);
  }

  const feeds = Array.isArray(root.feeds) ? root.feeds : [];
  const works: FetchedWork[] = [];
  for (const item of feeds) {
    const feed = asRecord(item);
    const photo = feed ? asRecord(feed.photo) : null;
    if (!feed || !photo) continue;
    const id = photo.id === undefined || photo.id === null ? "" : String(photo.id);
    if (!id) continue; // 无作品 ID 的条目跳过，不编 ID
    const photoUrls = Array.isArray(photo.photoUrls) ? photo.photoUrls : [];
    let videoUrl = "";
    for (let i = photoUrls.length - 1; i >= 0; i--) {
      const u = asRecord(photoUrls[i]);
      if (u && typeof u.url === "string" && u.url) {
        videoUrl = u.url;
        break;
      }
    }
    const tags = Array.isArray(feed.tags) ? feed.tags : [];
    const topics: string[] = [];
    for (const t of tags) {
      const tag = asRecord(t);
      if (tag && typeof tag.name === "string" && tag.name) topics.push(tag.name);
    }
    works.push({
      work_id: id,
      title: typeof photo.caption === "string" ? photo.caption : "",
      topics,
      cover_url: typeof photo.coverUrl === "string" ? photo.coverUrl : "",
      video_url: videoUrl,
      origin_url: `https://www.kuaishou.com/short-video/${id}`,
      published_at: normalizeTimestamp(photo.timestamp),
      likes: Math.max(0, Math.floor(toNumber(photo.likeCount, 0))),
      // is_pinned 不填：无证据，调用方以 has_pinned_field=false 上报
    });
  }
  return works;
}

/**
 * 字段清单（取证用）：列出第一条 feed 里 feed 层、photo 层、tag 层的全部字段名，
 * 供人工判定哪个字段是置顶标记。不猜测、不编字段名。
 */
export function collectFieldInventory(data: unknown): {
  feed_keys: string[];
  photo_keys: string[];
  tag_keys: string[];
  feed_count: number;
} {
  const root = asRecord(data);
  const feeds = root && Array.isArray(root.feeds) ? root.feeds : [];
  const first = feeds.length > 0 ? asRecord(feeds[0]) : null;
  const photo = first ? asRecord(first.photo) : null;
  const tags = first && Array.isArray(first.tags) ? first.tags : [];
  const firstTag = tags.length > 0 ? asRecord(tags[0]) : null;
  return {
    feed_keys: first ? Object.keys(first).sort() : [],
    photo_keys: photo ? Object.keys(photo).sort() : [],
    tag_keys: firstTag ? Object.keys(firstTag).sort() : [],
    feed_count: feeds.length,
  };
}
