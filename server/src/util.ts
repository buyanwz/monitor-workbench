// 通用小件：时间（Asia/Shanghai）、文件名安全处理、入参校验。
// 时间统一存 UTC 毫秒，展示与日期键用 Asia/Shanghai（设计第四节）。

export const DAY_MS = 24 * 3600 * 1000;

const SHANGHAI = "Asia/Shanghai";

/** 毫秒时间戳 → 北京时间日期 YYYY-MM-DD（collect_date 用） */
export function shanghaiDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** 毫秒时间戳 → 北京时间 YYYY-MM-DD HH:mm:ss（文案.txt 与展示用） */
export function shanghaiDateTime(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** 毫秒时间戳 → 文件名用北京时间 YYYYMMDD_HHmmss（ZIP 目录名用） */
export function shanghaiFileStamp(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}_${get("hour")}${get("minute")}${get("second")}`;
}

/**
 * 文件名/目录名单段安全处理（设计第七节）：
 * 去路径分隔符与控制字符、连续多点折下划线（防 .. 穿越）、去首尾空格与点、单段截断 ≤80 字符、空则回退 fallback。
 */
export function safeSegment(raw: string, fallback: string): string {
  let s = String(raw ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\.{2,}/g, "_")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  if (!s) s = fallback;
  return s;
}

/** 校验：非空字符串（去首尾空格后），超长返回 null */
export function reqString(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > maxLen) return null;
  return s;
}

/** 校验：可选字符串 */
export function optString(v: unknown, maxLen: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  return reqString(v, maxLen);
}

/** 校验：整数范围 */
export function reqInt(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return null;
  return v;
}

/** 读 JSON 请求体；非法 JSON 返回 null */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const data = await req.json();
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}
