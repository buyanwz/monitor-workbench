// 密码、会话令牌、登录态加密、下载签名：全部基于 WebCrypto（Worker 运行时原生能力）。
// 口令只存 PBKDF2 哈希（60 万次迭代，与 P7 同款）；登录态 AES-GCM 加密，密钥走 Worker secrets。

const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** 口令哈希，格式：pbkdf2-sha256$<迭代次数>$<b64盐>$<b64哈希> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    KEY_BYTES * 8,
  );
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const salt = b64ToBytes(parts[2]);
  const expected = b64ToBytes(parts[3]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    expected.length * 8,
  );
  return timingSafeEqual(new Uint8Array(bits), expected);
}

/** 会话 token：32 字节随机串，base64url；服务端只存其 SHA-256 */
export function newSessionToken(): string {
  return bytesToB64Url(randomBytes(32));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256HexBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

// ---- 登录态 AES-GCM 加密（密钥为 base64 编码的 32 字节，走 Worker secret LOGIN_STATE_KEY） ----

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64);
  if (raw.length !== 32) throw new Error("LOGIN_STATE_KEY 必须是 32 字节");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 加密：输出 base64(iv 12 字节 + 密文)。失败抛错（调用方按 login_expired 分类，设计第六节）。 */
export async function encryptLoginState(plain: string, keyB64: string): Promise<string> {
  const key = await aesKey(keyB64);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plain),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return bytesToB64(out);
}

/** 解密：失败抛错（调用方按 login_expired 分类，设计第六节第 1 步）。 */
export async function decryptLoginState(encB64: string, keyB64: string): Promise<string> {
  const key = await aesKey(keyB64);
  const raw = b64ToBytes(encB64);
  if (raw.length <= 12) throw new Error("密文过短");
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource);
  return new TextDecoder().decode(pt);
}

// ---- 下载签名 token（HMAC-SHA256，设计第七节） ----
// 格式：base64url(JSON{asset_id, exp, nonce}) + "." + base64url(HMAC)

export interface DownloadTokenPayload {
  asset_id: number;
  exp: number;
  nonce: string;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signDownloadToken(secret: string, payload: DownloadTokenPayload): Promise<string> {
  const body = bytesToB64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${bytesToB64Url(new Uint8Array(sig))}`;
}

/** 验签：返回 payload，签名不对/过期/格式错返回 null */
export async function verifyDownloadToken(secret: string, token: string): Promise<DownloadTokenPayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let sig: Uint8Array;
  let payload: DownloadTokenPayload;
  try {
    sig = b64UrlToBytes(sigB64);
    payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(body))) as DownloadTokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.asset_id !== "number" || typeof payload.exp !== "number" || typeof payload.nonce !== "string") {
    return null;
  }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sig as BufferSource, new TextEncoder().encode(body));
  if (!ok) return null;
  if (payload.exp <= Date.now()) return null;
  return payload;
}

export function newNonce(): string {
  return bytesToB64Url(randomBytes(12));
}
