// 本地 SQLite 适配层：实现与 Cloudflare D1 相同的 prepare/bind/first/all/run 接口，
// 业务代码（accounts/auth/collect/...）一行不改即可复用。底层为 Node 内置 node:sqlite，
// 零原生依赖、零第三方依赖。数据文件：<数据目录>/monitor.db。

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export interface LocalRunMeta {
  changes: number;
  last_row_id: number;
}

export interface LocalStatement {
  bind(...values: unknown[]): LocalStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: LocalRunMeta }>;
}

export interface LocalDatabase {
  prepare(sql: string): LocalStatement;
}

class LocalStatementImpl implements LocalStatement {
  private params: unknown[] = [];
  constructor(private stmt: StatementSync) {}

  bind(...values: unknown[]): LocalStatement {
    this.params = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.stmt.get(...(this.params as SQLInputValue[])) as T | undefined;
    return row === undefined ? null : row;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.stmt.all(...(this.params as SQLInputValue[])) as T[];
    return { results: rows };
  }

  async run(): Promise<{ meta: LocalRunMeta }> {
    const r = this.stmt.run(...(this.params as SQLInputValue[]));
    return {
      meta: {
        changes: typeof r.changes === "bigint" ? Number(r.changes) : r.changes,
        last_row_id: typeof r.lastInsertRowid === "bigint" ? Number(r.lastInsertRowid) : r.lastInsertRowid,
      },
    };
  }
}

export class LocalDb implements LocalDatabase {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL 提升崩溃安全性；busy_timeout 防短暂锁冲突。外键不强制（与 D1 默认行为一致）。
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  prepare(sql: string): LocalStatement {
    return new LocalStatementImpl(this.db.prepare(sql));
  }

  /** 执行多条 SQL（迁移用）。 */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
