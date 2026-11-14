// 本机密钥管理：登录态加密密钥与下载签名密钥只存本机，永不打印、永不进日志。
// 首次启动自动生成并写 <数据目录>/secrets.json（POSIX 下 0600）；测试可用环境变量覆盖。

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface LocalSecrets {
  loginStateKey: string; // base64 编码的 32 字节（AES-GCM）
  downloadSigningKey: string; // HMAC 签名密钥（随机串）
  intakeToken: string; // 扩展上报专用令牌（只对 /intake/report 有效，不等于会话登录）
}

function b64(bytes: Buffer): string {
  return bytes.toString("base64");
}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function isValidLoginStateKey(v: string): boolean {
  try {
    return Buffer.from(v, "base64").length === 32;
  } catch {
    return false;
  }
}

function isValidIntakeToken(v: unknown): v is string {
  return typeof v === "string" && v.length >= 16;
}

/** 密钥文件是否走环境变量覆盖（仅测试与排障用；该模式下不可轮换上报令牌）。 */
export function secretsFromEnv(): boolean {
  return process.env.MONITOR_LOGIN_STATE_KEY !== undefined || process.env.MONITOR_DOWNLOAD_SIGNING_KEY !== undefined;
}

async function writeSecretsFile(file: string, secrets: LocalSecrets): Promise<void> {
  // 先写临时文件再改名，避免半截文件
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows 无 POSIX 权限位，忽略
  }
}

/**
 * 读本机密钥；不存在则生成并落盘。环境变量 MONITOR_LOGIN_STATE_KEY /
 * MONITOR_DOWNLOAD_SIGNING_KEY 优先（仅测试与排障用）。
 * 旧版 secrets.json 没有 intakeToken 时，补生成一个并回写（其余两项原样保留）。
 */
export async function loadOrCreateSecrets(dataDir: string): Promise<LocalSecrets> {
  const envLogin = process.env.MONITOR_LOGIN_STATE_KEY;
  const envSign = process.env.MONITOR_DOWNLOAD_SIGNING_KEY;
  if (envLogin !== undefined || envSign !== undefined) {
    if (!envLogin || !isValidLoginStateKey(envLogin)) {
      throw new Error("MONITOR_LOGIN_STATE_KEY 须为 base64 编码的 32 字节");
    }
    if (!envSign) throw new Error("MONITOR_DOWNLOAD_SIGNING_KEY 不能为空");
    // 环境变量模式：上报令牌可用 MONITOR_INTAKE_TOKEN 覆盖，否则进程内随机生成（不落盘）
    const envToken = process.env.MONITOR_INTAKE_TOKEN;
    if (envToken !== undefined && !isValidIntakeToken(envToken)) {
      throw new Error("MONITOR_INTAKE_TOKEN 至少 16 个字符");
    }
    return {
      loginStateKey: envLogin,
      downloadSigningKey: envSign,
      intakeToken: isValidIntakeToken(envToken) ? envToken : b64url(randomBytes(32)),
    };
  }

  const file = path.join(dataDir, "secrets.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalSecrets>;
    if (parsed.loginStateKey && isValidLoginStateKey(parsed.loginStateKey) && parsed.downloadSigningKey) {
      if (isValidIntakeToken(parsed.intakeToken)) {
        return { loginStateKey: parsed.loginStateKey, downloadSigningKey: parsed.downloadSigningKey, intakeToken: parsed.intakeToken };
      }
      // 旧文件迁移：补一个上报令牌并回写
      const migrated: LocalSecrets = {
        loginStateKey: parsed.loginStateKey,
        downloadSigningKey: parsed.downloadSigningKey,
        intakeToken: b64url(randomBytes(32)),
      };
      await writeSecretsFile(file, migrated);
      return migrated;
    }
    throw new Error("secrets.json 内容不完整");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as Error).message !== "secrets.json 内容不完整") {
      throw e;
    }
    // 首次启动：生成并落盘
    const secrets: LocalSecrets = {
      loginStateKey: b64(randomBytes(32)),
      downloadSigningKey: b64url(randomBytes(32)),
      intakeToken: b64url(randomBytes(32)),
    };
    await writeSecretsFile(file, secrets);
    return secrets;
  }
}

/**
 * 轮换上报令牌：重写 secrets.json（其余两项原样保留），返回新令牌。
 * 环境变量模式下抛错（无文件可写，轮换无意义）。
 */
export async function rotateIntakeToken(dataDir: string): Promise<string> {
  if (secretsFromEnv()) {
    throw new Error("当前为环境变量模式，不可轮换上报令牌");
  }
  const file = path.join(dataDir, "secrets.json");
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw) as Partial<LocalSecrets>;
  if (!parsed.loginStateKey || !isValidLoginStateKey(parsed.loginStateKey) || !parsed.downloadSigningKey) {
    throw new Error("secrets.json 内容不完整，无法轮换上报令牌");
  }
  const next: LocalSecrets = {
    loginStateKey: parsed.loginStateKey,
    downloadSigningKey: parsed.downloadSigningKey,
    intakeToken: b64url(randomBytes(32)),
  };
  await writeSecretsFile(file, next);
  return next.intakeToken;
}
