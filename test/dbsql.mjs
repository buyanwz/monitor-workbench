// 测试用 SQLite 直连小工具：e2e.mjs 经它读写测试库（替代 Cloudflare 版的 wrangler d1 execute）。
//   node test/dbsql.mjs "<SQL>"            写/删改语句，无输出，失败非零退出
//   node test/dbsql.mjs --json "<SQL>"     查询语句，输出 JSON 数组
// 库路径：$MONITOR_DATA_DIR/monitor.db（测试脚本负责设置并指向全新临时目录）。

import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";

const args = process.argv.slice(2);
const asJson = args[0] === "--json";
const sql = asJson ? args[1] : args[0];
if (!sql) {
  console.error("用法：node test/dbsql.mjs [--json] \"<SQL>\"");
  process.exit(2);
}
const dataDir = process.env.MONITOR_DATA_DIR;
if (!dataDir) {
  console.error("MONITOR_DATA_DIR 未设置");
  process.exit(2);
}
const db = new DatabaseSync(path.join(dataDir, "monitor.db"));
db.exec("PRAGMA busy_timeout = 5000;");
try {
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) {
    const rows = db.prepare(sql).all();
    if (asJson) console.log(JSON.stringify(rows));
    else console.log(JSON.stringify(rows, null, 2));
  } else {
    db.exec(sql);
  }
} finally {
  db.close();
}
