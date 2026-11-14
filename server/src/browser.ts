// 浏览器采集控制面：登录状态查询与登录窗口弹出。
// 全部接口须 Bearer 会话鉴权（上报令牌在此无效）；CLI 环境下 BROWSER_CONTROL 不存在，
// 状态接口如实返回 available=false，弹出接口报 503，绝不假装有浏览器。

import { authenticate, err, json, opLog, unauthorized, type Env } from "./db";

export async function handleBrowserStatus(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const control = env.BROWSER_CONTROL;
  const port = env.SERVER_PORT ?? null;
  if (!control) {
    return json({ ok: true, available: false, logged_in: null, last_capture_at: null, port });
  }
  try {
    const s = await control.getStatus();
    return json({ ok: true, available: true, logged_in: s.loggedIn, last_capture_at: s.lastCaptureAt, port });
  } catch (e) {
    return err(`浏览器状态查询失败：${e instanceof Error ? e.message : String(e)}`, 500);
  }
}

export async function handleShowLogin(env: Env, req: Request): Promise<Response> {
  if (!(await authenticate(env, req))) return unauthorized();
  const control = env.BROWSER_CONTROL;
  if (!control) return err("当前为命令行模式，没有浏览器采集窗口", 503);
  try {
    await control.showLoginWindow();
  } catch (e) {
    return err(`打开登录窗口失败：${e instanceof Error ? e.message : String(e)}`, 500);
  }
  await opLog(env.DB, "browser_login_open", "browser", null, "打开快手登录窗口");
  return json({ ok: true });
}
