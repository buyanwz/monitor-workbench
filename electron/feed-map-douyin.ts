// 抖音 aweme/post 返回正文 → FetchedWork 映射（纯函数，无 Electron/Node 依赖）。
// 字段出处：扩展代码已证实（content.js，探针报告 D1 节证据索引）。
//   work_id     = aweme_id
//   origin_url  = https://www.douyin.com/video/<aweme_id>（视频作品；图文已跳过）
//   标题        = desc
//   话题        = text_extra[] 中 type===1 且带 hashtag_name 的项
//   点赞        = statistics.digg_count
//   发布时间    = create_time（秒）×1000
//   封面        = video.{raw_cover, cover, origin_cover, dynamic_cover,
//                 cover_original_scale} 的 url_list 依次并入后取第一条（TQ）
//   播放地址    = video.play_addr.url_list 里第一条不被排除规则命中的地址（AQ）；
//                 无可用项时用 play_addr.uri 拼
//                 https://aweme.snssdk.com/aweme/v1/play/?video_id=<uri>
//                 （uri 本身是 https 链接时直接用它）
//   排除规则（AQ 原样）：跳过 https://v26-web.douyinvod.com/ 开头与
//                 含 -webf.douyinvod.com/ 的地址——排除原因扩展代码里未写，未知，不得臆测。
//   图文作品    = media_type===2 或 42：无视频文件，按已定保守默认不入库，计入 skippedCount。
// 风控语义（Yo @1534381，已证实）：whaleDecisionCustom === "black_no_login" → 须登录；
// 其他非空决策值 → other 并原样记录决策值（取值含义未知，不得臆测）。
// 置顶字段：扩展代码里 0 命中，无证据——is_pinned 一律不填，调用方以
// has_pinned_field=false 上报，批次走 needs_review 不入库（与快手同缺口，D4）。

import { FetcherError, type FetchedWork } from "../server/src/fetcher";
import { asRecord, asString, firstString, normalizeTimestamp, toNumber, type MapResult } from "./feed-map-common";

const COVER_KEYS = ["raw_cover", "cover", "origin_cover", "dynamic_cover", "cover_original_scale"];

function pickCoverUrl(video: Record<string, unknown> | null): string {
  if (!video) return "";
  for (const key of COVER_KEYS) {
    const cover = asRecord(video[key]);
    const url = cover ? firstString(cover.url_list) : "";
    if (url) return url;
  }
  return "";
}

/** AQ 原样：url_list 里第一条不被排除规则命中的地址，uri 回退拼播放链接。 */
function pickVideoUrl(video: Record<string, unknown> | null): string {
  if (!video) return "";
  const playAddr = asRecord(video.play_addr);
  if (!playAddr) return "";
  const list = Array.isArray(playAddr.url_list) ? playAddr.url_list : [];
  for (const item of list) {
    if (typeof item !== "string" || !item) continue;
    if (item.startsWith("https://v26-web.douyinvod.com/")) continue;
    if (item.includes("-webf.douyinvod.com/")) continue;
    return item;
  }
  const uri = asString(playAddr.uri);
  if (!uri) return "";
  if (uri.startsWith("https://")) return uri;
  return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}`;
}

/** 解析 aweme/post 返回正文；分类错误直接抛 FetcherError。 */
export function parseDouyinResponse(bodyText: string): MapResult {
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new FetcherError("other", "作品列表返回的不是合法 JSON");
  }
  const root = asRecord(data);
  if (!root) throw new FetcherError("other", "作品列表返回结构异常");

  const whale = root.whaleDecisionCustom;
  if (typeof whale === "string" && whale) {
    if (whale === "black_no_login") {
      throw new FetcherError("login_expired", "抖音要求先登录，请在抖音登录窗口登录");
    }
    throw new FetcherError("other", `抖音风控决策：${whale.slice(0, 100)}，请人工处理`);
  }

  if (!Array.isArray(root.aweme_list)) {
    throw new FetcherError("other", "作品列表返回结构异常（缺少 aweme_list）");
  }

  const works: FetchedWork[] = [];
  let skippedCount = 0;
  for (const item of root.aweme_list) {
    const aweme = asRecord(item);
    if (!aweme) continue;
    const id = aweme.aweme_id === undefined || aweme.aweme_id === null ? "" : String(aweme.aweme_id);
    if (!id) continue; // 无作品 ID 的条目跳过，不编 ID
    const mediaType = toNumber(aweme.media_type, -1);
    if (mediaType === 2 || mediaType === 42) {
      skippedCount++; // 图文作品：无视频文件，不入库
      continue;
    }
    const statistics = asRecord(aweme.statistics);
    const video = asRecord(aweme.video);
    const textExtra = Array.isArray(aweme.text_extra) ? aweme.text_extra : [];
    const topics: string[] = [];
    for (const t of textExtra) {
      const extra = asRecord(t);
      if (extra && typeof extra.hashtag_name === "string" && extra.hashtag_name && extra.type === 1) {
        topics.push(extra.hashtag_name);
      }
    }
    works.push({
      work_id: id,
      title: asString(aweme.desc),
      topics,
      cover_url: pickCoverUrl(video),
      video_url: pickVideoUrl(video),
      origin_url: `https://www.douyin.com/video/${id}`,
      published_at: normalizeTimestamp(aweme.create_time),
      likes: Math.max(0, Math.floor(toNumber(statistics ? statistics.digg_count : undefined, 0))),
      // is_pinned 不填：无证据，调用方以 has_pinned_field=false 上报
    });
  }
  return { works, skippedCount };
}

/**
 * 字段清单（取证用）：列出第一条 aweme 里 aweme 层、statistics 层、video 层的
 * 全部字段名，供人工判定哪个字段是置顶标记。不猜测、不编字段名。
 */
export function collectDouyinFieldInventory(data: unknown): {
  aweme_keys: string[];
  statistics_keys: string[];
  video_keys: string[];
  aweme_count: number;
} {
  const root = asRecord(data);
  const list = root && Array.isArray(root.aweme_list) ? root.aweme_list : [];
  const first = list.length > 0 ? asRecord(list[0]) : null;
  const statistics = first ? asRecord(first.statistics) : null;
  const video = first ? asRecord(first.video) : null;
  return {
    aweme_keys: first ? Object.keys(first).sort() : [],
    statistics_keys: statistics ? Object.keys(statistics).sort() : [],
    video_keys: video ? Object.keys(video).sort() : [],
    aweme_count: list.length,
  };
}
