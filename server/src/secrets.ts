// 本机密钥管理：登录态加密密钥与下载签名密钥只存本机，永不打印、永不进日志。
// 首次启动自动生成并写 <数据目录>/secrets.json（POSIX 下 0600）；测试可用环境变量覆盖。

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface LocalSecrets {
  loginStateKey: string; // base64 编码的 32 字节（AES-GCM）
  downloadSigningKey: string; // HMAC 签名密钥（随机串）
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

/**
 * 读本机密钥；不存在则生成并落盘。环境变量 MONITOR_LOGIN_STATE_KEY /
 * MONITOR_DOWNLOAD_SIGNING_KEY 优先（仅测试与排障用）。
 */
export async function loadOrCreateSecrets(dataDir: string): Promise<LocalSecrets> {
  const envLogin = process.env.MONITOR_LOGIN_STATE_KEY;
  const envSign = process.env.MONITOR_DOWNLOAD_SIGNING_KEY;
  if (envLogin !== undefined || envSign !== undefined) {
    if (!envLogin || !isValidLoginStateKey(envLogin)) {
      throw new Error("MONITOR_LOGIN_STATE_KEY 须为 base64 编码的 32 字节");
    }
    if (!envSign) throw new Error("MONITOR_DOWNLOAD_SIGNING_KEY 不能为空");
    return { loginStateKey: envLogin, downloadSigningKey: envSign };
  }

  const file = path.join(dataDir, "secrets.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalSecrets>;
    if (parsed.loginStateKey && isValidLoginStateKey(parsed.loginStateKey) && parsed.downloadSigningKey) {
      return { loginStateKey: parsed.loginStateKey, downloadSigningKey: parsed.downloadSigningKey };
    }
    throw new Error("secrets.json 内容不完整");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as Error).message !== "secrets.json 内容不完整") {
      throw e;
    }
    // 首次启动：生成并落盘（先写临时文件再改名，避免半截文件）
    const secrets: LocalSecrets = {
      loginStateKey: b64(randomBytes(32)),
      downloadSigningKey: b64url(randomBytes(32)),
    };
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
    try {
      await fs.chmod(file, 0o600);
    } catch {
      // Windows 无 POSIX 权限位，忽略
    }
    return secrets;
  }
}
