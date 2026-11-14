// 单用户访问口令：首次打开设口令（setup），之后登录拿会话令牌。
// 口令只存 PBKDF2 哈希；会话 token 服务端只存 SHA-256；连续输错 5 次锁 15 分钟。
// 内部状态存 settings 的下划线键（不暴露、不进备份）。

import { hashPassword, newSessionToken, sha256Hex, verifyPassword } from "./crypto";
import {
  LOGIN_LOCK_MS,
  LOGIN_MAX_FAILS,
  SESSION_TTL_MS,
  authenticate,
  err,
  getSetting,
  json,
  nowMs,
  opLog,
  setSetting,
  unauthorized,
  type Env,
} from "./db";
import { readJsonBody, reqString } from "./util";

const HASH_KEY = "_access_password_hash";
const FAILS_KEY = "_failed_attempts";
const LOCK_KEY = "_locked_until";

async function getHash(env: Env): Promise<string | null> {
  return getSetting(env.DB, HASH_KEY);
}

async function getFails(env: Env): Promise<number> {
  const v = await getSetting(env.DB, FAILS_KEY);
  return v === null ? 0 : Number(v) || 0;
}

async function getLockUntil(env: Env): Promise<number> {
  const v = await getSetting(env.DB, LOCK_KEY);
  return v === null ? 0 : Number(v) || 0;
}

async function issueSession(env: Env): Promise<{ token: string; expires_at: number }> {
  const token = newSessionToken();
  const tokenHash = await sha256Hex(token);
  const now = nowMs();
  await env.DB.prepare("INSERT INTO sessions (token_hash, expires_at, last_seen_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, now + SESSION_TTL_MS, now, now)
    .run();
  return { token, expires_at: now + SESSION_TTL_MS };
}

/** 首次设口令：仅当尚未设过口令时可用（已设则 409，避免覆盖）。 */
export async function handleSetup(env: Env, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const password = reqString(body.password, 128);
  if (!password || password.length < 8) return err("口令至少 8 位", 400);
  if (await getHash(env)) return err("访问口令已设置，请直接登录", 409);
  await setSetting(env.DB, HASH_KEY, await hashPassword(password));
  await setSetting(env.DB, FAILS_KEY, "0");
  await setSetting(env.DB, LOCK_KEY, "0");
  const sess = await issueSession(env);
  await opLog(env.DB, "auth_setup", "auth", null, "首次设置访问口令");
  return json({ ok: true, token: sess.token, expires_at: sess.expires_at });
}

export async function handleLogin(env: Env, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const password = reqString(body.password, 128);
  if (!password) return err("请填写口令", 400);
  const hash = await getHash(env);
  if (!hash) return err("尚未设置访问口令，请先设置", 409);
  const now = nowMs();
  if (now < (await getLockUntil(env))) return err("输错太多次，已锁定 15 分钟，请稍后再试", 403);
  if (!(await verifyPassword(password, hash))) {
    const fails = (await getFails(env)) + 1;
    await setSetting(env.DB, FAILS_KEY, String(fails));
    if (fails >= LOGIN_MAX_FAILS) {
      await setSetting(env.DB, LOCK_KEY, String(now + LOGIN_LOCK_MS));
      await setSetting(env.DB, FAILS_KEY, "0");
      return err("输错太多次，已锁定 15 分钟，请稍后再试", 403);
    }
    return err("口令不正确", 401);
  }
  await setSetting(env.DB, FAILS_KEY, "0");
  const sess = await issueSession(env);
  await opLog(env.DB, "auth_login", "auth", null, "登录成功");
  return json({ ok: true, token: sess.token, expires_at: sess.expires_at });
}

export async function handleLogout(env: Env, req: Request): Promise<Response> {
  const authed = await authenticate(env, req);
  if (!authed) return unauthorized();
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(authed.tokenHash).run();
  return json({ ok: true });
}

export async function handleMe(env: Env, req: Request): Promise<Response> {
  const authed = await authenticate(env, req);
  if (!authed) return unauthorized();
  const setupDone = (await getHash(env)) !== null;
  return json({ ok: true, actor: "本人", setup_done: setupDone });
}

/** 改口令：验证旧口令后换新哈希，并吊销全部会话（当前会话也作废，须重新登录）。 */
export async function handleChangePassword(env: Env, req: Request): Promise<Response> {
  const authed = await authenticate(env, req);
  if (!authed) return unauthorized();
  const body = await readJsonBody(req);
  if (!body) return err("请求体不是合法 JSON", 400);
  const oldPassword = reqString(body.old_password, 128);
  const newPassword = reqString(body.new_password, 128);
  if (!oldPassword || !newPassword) return err("请填写旧口令和新口令", 400);
  if (newPassword.length < 8) return err("新口令至少 8 位", 400);
  const hash = await getHash(env);
  if (!hash || !(await verifyPassword(oldPassword, hash))) return err("旧口令不正确", 401);
  await setSetting(env.DB, HASH_KEY, await hashPassword(newPassword));
  await env.DB.prepare("DELETE FROM sessions").run();
  await opLog(env.DB, "auth_change_password", "auth", null, "修改访问口令，全部会话已吊销");
  return json({ ok: true, relogin: true });
}

/** 是否已设置口令（前端据此决定显示设置页还是登录页；不泄露任何敏感信息）。 */
export async function handleSetupStatus(env: Env): Promise<Response> {
  return json({ ok: true, setup_done: (await getHash(env)) !== null });
}
