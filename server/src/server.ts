// 本地服务组装：数据目录 → SQLite + 迁移 → 密钥 → Env → HTTP 服务 → 调度器。
// 数据布局（<数据目录> 默认取 Electron userData，环境变量 MONITOR_DATA_DIR 可覆盖）：
//   monitor.db        本地库（与 Cloudflare 版同一 schema）
//   files/            视频/封面/ZIP/备份（key 即相对路径）
//   secrets.json      本机密钥（首次启动自动生成，0600）

import type { Server } from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import worker from "./index";
import type { Env } from "./db";
import { LocalDb } from "./localdb";
import { LocalBucket } from "./localbucket";
import { loadOrCreateSecrets } from "./secrets";
import { applyMigrations } from "./migrate";
import { createHttpServer } from "./nodehttp";
import { startScheduler, type SchedulerHandle } from "./scheduler";

export interface ServerOptions {
  dataDir: string;
  port?: number; // 0 = 随机端口（Electron 默认）；CLI 默认 17881
  host?: string;
  noScheduler?: boolean; // 测试用：关调度器，手动驱动 cron
  migrationsDir?: string;
  staticDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  env: Env;
  close(): Promise<void>;
}

function hereDir(): string {
  // 运行形态一律是 esbuild 打出的 CJS 包，__dirname 即包所在目录
  return __dirname;
}

async function firstExistingDir(candidates: string[], mustContain: string): Promise<string | null> {
  for (const dir of candidates) {
    try {
      await fs.stat(path.join(dir, mustContain));
      return dir;
    } catch {
      // try next
    }
  }
  return null;
}

export async function resolveMigrationsDir(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    process.env.MONITOR_MIGRATIONS_DIR,
    path.join(hereDir(), "migrations"),
    path.join(hereDir(), "..", "migrations"),
    path.join(hereDir(), "..", "server", "migrations"),
  ].filter((x): x is string => !!x);
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, "migrations"));
  const found = await firstExistingDir(candidates, "0001_init.sql");
  if (!found) throw new Error("找不到迁移目录（含 0001_init.sql）");
  return found;
}

export async function resolveStaticDir(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    process.env.MONITOR_RENDERER_DIR,
    path.join(hereDir(), "renderer"),
    path.join(hereDir(), "..", "renderer"),
    path.join(hereDir(), "..", "..", "renderer"),
  ].filter((x): x is string => !!x);
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, "renderer"));
  const found = await firstExistingDir(candidates, "index.html");
  if (!found) throw new Error("找不到前端目录（含 index.html）");
  return found;
}

export async function startLocalServer(opts: ServerOptions): Promise<RunningServer> {
  const dataDir = opts.dataDir;
  const filesDir = path.join(dataDir, "files");
  await fs.mkdir(filesDir, { recursive: true });

  const db = new LocalDb(path.join(dataDir, "monitor.db"));
  const migrationsDir = await resolveMigrationsDir(opts.migrationsDir);
  await applyMigrations(db, migrationsDir);

  const secrets = await loadOrCreateSecrets(dataDir);
  const bucket = new LocalBucket(filesDir);
  const env: Env = {
    DB: db,
    BUCKET: bucket,
    LOGIN_STATE_KEY: secrets.loginStateKey,
    DOWNLOAD_SIGNING_KEY: secrets.downloadSigningKey,
    MOCK_FETCHER: process.env.MONITOR_MOCK_FETCHER,
    TEST_MODE: process.env.MONITOR_TEST_MODE,
    TEST_QUOTA_BYTES: process.env.MONITOR_TEST_QUOTA_BYTES,
    TEST_MAX_FILE_BYTES: process.env.MONITOR_TEST_MAX_FILE_BYTES,
    ALLOWED_ORIGIN: process.env.MONITOR_ALLOWED_ORIGIN,
  };

  const staticDir = await resolveStaticDir(opts.staticDir);
  const httpServer: Server = createHttpServer(
    (req: Request, e: unknown) => worker.fetch(req, e as Env),
    env,
    { staticDir },
  );

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  let scheduler: SchedulerHandle | null = null;
  if (!opts.noScheduler && process.env.MONITOR_NO_SCHEDULER !== "1") {
    scheduler = startScheduler(env);
  }

  let closed = false;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    env,
    async close() {
      if (closed) return;
      closed = true;
      scheduler?.stop();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      db.close();
    },
  };
}
