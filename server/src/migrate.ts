// 迁移：启动时对本地库执行 migrations/0001_init.sql（IF NOT EXISTS + INSERT OR IGNORE，
// 幂等，每次启动重跑无害）。后续新增迁移文件时按文件名顺序执行并记入 _migrations 表。

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { LocalDb } from "./localdb";

export async function applyMigrations(db: LocalDb, migrationsDir: string): Promise<string[]> {
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);",
  );
  const applied: string[] = [];
  for (const f of files) {
    const done = db.prepare("SELECT name FROM _migrations WHERE name = ?");
    const row = await done.bind(f).first<{ name: string }>();
    if (row) continue;
    const sql = await fs.readFile(path.join(migrationsDir, f), "utf8");
    db.exec(sql);
    await db
      .prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
      .bind(f, Date.now())
      .run();
    applied.push(f);
  }
  return applied;
}
