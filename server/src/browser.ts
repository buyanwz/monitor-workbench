// 浏览器采集控制面：登录状态查询与登录窗口弹出（按平台）。
// 全部接口须 Bearer 会话鉴权（上报令牌在此无效）；CLI 环境下 BROWSER_CONTROL 不存在，
// 状态接口如实返回 available=false，弹出接口报 503，绝不假装有浏览器。
// 状态接口的 logged_in/last_capture_at 是快手（首平台）的旧字段，保持不变；
// platforms 为每平台状态（logged_in/last_capture_at 蛇形键，与顶层一致）。

import { authenticate, err, json, opLog, unauthorized, type Env } from "./db";
import { BROWSER_PLATFORMS, platformLabel } from "./fetcher";
import { readJsonBody } from "./util";

export async function handleBrowserStatus(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const control = env.BROWSER_CONTROL;
  const port = env.SERVER_PORT ?? null;
  if (!control) {
    return json({ ok: true, available: false, logged_in: null, last_capture_at: null, platforms: null, port });
  }
  try {
    const s = await control.getStatus();
    const platforms: Record<string, { logged_in: boolean; last_capture_at: number | null }> = {};
    for (const [platform, st] of Object.entries(s.platforms)) {
      platforms[platform] = { logged_in: st.loggedIn, last_capture_at: st.lastCaptureAt };
    }
    return json({ ok: true, available: true, logged_in: s.loggedIn, last_capture_at: s.lastCaptureAt, platforms, port });
  } catch (e) {
    return err(`浏览器状态查询失败：${e instanceof Error ? e.message : String(e)}`, 500);
  }
}

export async function handleShowLogin(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const control = env.BROWSER_CONTROL;
  if (!control) return err("当前为命令行模式，没有浏览器采集窗口", 503);
  const body = await readJsonBody(req);
  const platform = typeof body?.platform === "string" && body.platform ? body.platform : "kuaishou";
  if (!BROWSER_PLATFORMS.includes(platform)) return err("平台不在支持范围内", 400);
  try {
    await control.showLoginWindow(platform);
  } catch (e) {
    return err(`打开登录窗口失败：${e instanceof Error ? e.message : String(e)}`, 500);
  }
  await opLog(env.DB, "browser_login_open", "browser", null, `打开${platformLabel(platform)}登录窗口`);
  return json({ ok: true });
}
