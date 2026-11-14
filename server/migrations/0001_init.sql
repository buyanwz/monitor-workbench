-- 监控账号 Web 工作台 D1 schema（对应设计文档第四节）
-- D1 与 SQLite 兼容；本地 wrangler dev 会对本地库跑本迁移。
-- 除设计文档 7 张表 + settings 外，另有 3 张支撑表（sessions / notifications / cleanup_log），
-- 以及 4 处有据可查的增补字段（见 README“与设计文档的差异”）：
--   monitor_account.login_state_updated_at（登录态过期提醒用）
--   work.file_status（文件缺失标记，设计第六节第 5 步）
--   collect_task.needs_review（置顶字段缺失时“待人工核对”，R3）
--   collect_task.next_retry_at（退避重试时间点，第六节）

CREATE TABLE IF NOT EXISTS monitor_account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  home_url TEXT NOT NULL,
  account_id TEXT NOT NULL,
  remark TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  login_state_enc TEXT,
  login_state_status TEXT NOT NULL DEFAULT 'missing',
  login_state_updated_at INTEGER,
  health TEXT NOT NULL DEFAULT 'normal',
  fail_streak INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(platform, account_id)
);
CREATE INDEX IF NOT EXISTS idx_account_platform ON monitor_account(platform);
CREATE INDEX IF NOT EXISTS idx_account_status ON monitor_account(status);
CREATE INDEX IF NOT EXISTS idx_account_health ON monitor_account(health);

CREATE TABLE IF NOT EXISTS work (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  work_id TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES monitor_account(id),
  title TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',
  cover_url TEXT,
  video_url TEXT,
  origin_url TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  collected_at INTEGER NOT NULL,
  collected_finished_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  retention_days INTEGER NOT NULL,
  downloaded INTEGER NOT NULL DEFAULT 0,
  file_status TEXT NOT NULL DEFAULT 'ok',
  UNIQUE(platform, work_id)
);
CREATE INDEX IF NOT EXISTS idx_work_platform_published ON work(platform, published_at);
CREATE INDEX IF NOT EXISTS idx_work_account ON work(account_id);
CREATE INDEX IF NOT EXISTS idx_work_expires ON work(expires_at);
CREATE INDEX IF NOT EXISTS idx_work_downloaded ON work(downloaded);

CREATE TABLE IF NOT EXISTS collect_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES monitor_account(id),
  platform TEXT NOT NULL,
  collect_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  idempotency_key TEXT NOT NULL UNIQUE,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  trigger TEXT NOT NULL DEFAULT 'scheduled',
  started_at INTEGER,
  finished_at INTEGER,
  collected_count INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_date ON collect_task(collect_date);
CREATE INDEX IF NOT EXISTS idx_task_status ON collect_task(status);
CREATE INDEX IF NOT EXISTS idx_task_account ON collect_task(account_id);

CREATE TABLE IF NOT EXISTS work_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES work(id),
  likes INTEGER NOT NULL,
  collected_at INTEGER NOT NULL,
  task_id INTEGER REFERENCES collect_task(id)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_work ON work_snapshot(work_id, collected_at);

CREATE TABLE IF NOT EXISTS file_asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES work(id),
  kind TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(work_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_asset_work ON file_asset(work_id);
CREATE INDEX IF NOT EXISTS idx_asset_kind ON file_asset(kind);
CREATE INDEX IF NOT EXISTS idx_asset_expires ON file_asset(expires_at);

CREATE TABLE IF NOT EXISTS download_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES work(id),
  zip_asset_id INTEGER REFERENCES file_asset(id),
  downloaded_by TEXT NOT NULL DEFAULT '本人',
  downloaded_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_download_work ON download_record(work_id, downloaded_at);

CREATE TABLE IF NOT EXISTS operation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL DEFAULT '本人',
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oplog_created ON operation_log(created_at, action);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 默认配置（设计第四节 settings + 采集分片/配额/提醒阈值）
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('retention_days', '3', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('download_link_ttl_minutes', '30', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('collect_hour', '8', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('max_concurrent_zip', '3', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('collect_batch_size', '3', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('storage_quota_bytes', '8589934592', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('login_state_warn_days', '30', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  account_id INTEGER REFERENCES monitor_account(id),
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_type_account ON notifications(type, account_id);

CREATE TABLE IF NOT EXISTS cleanup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER,
  kind TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cleanup_created ON cleanup_log(created_at);
