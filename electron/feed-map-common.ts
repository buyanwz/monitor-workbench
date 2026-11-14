// mapper 公共件：三个平台的截获正文映射共用的纯函数（无 Electron/Node 依赖）。
// 各平台字段出处见各自的 mapper 模块头注；无证据的字段一律不编。

import type { FetchedWork } from "../server/src/fetcher";

/** mapper 返回：映射后的作品 + 本批跳过的图文条数（图文无视频文件，按规则不入库）。 */
export interface MapResult {
  works: FetchedWork[];
  skippedCount: number;
}

export type FeedParser = (bodyText: string) => MapResult;

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

export function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** 时间戳归一到毫秒：小于 1e12 时按秒换算；无效/缺失返回 0。 */
export function normalizeTimestamp(v: unknown): number {
  const n = toNumber(v, 0);
  if (n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 取数组里第一个非空字符串（url_list 这类纯字符串数组用）。 */
export function firstString(list: unknown): string {
  if (!Array.isArray(list)) return "";
  for (const item of list) {
    if (typeof item === "string" && item) return item;
  }
  return "";
}
