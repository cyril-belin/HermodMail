import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

export type DB = Database.Database

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

CREATE TABLE mail_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_tls TEXT NOT NULL DEFAULT 'tls',
  imap_user TEXT NOT NULL,
  imap_pass_enc TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_tls TEXT NOT NULL DEFAULT 'tls',
  smtp_user TEXT NOT NULL DEFAULT '',
  smtp_pass_enc TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_sync_at INTEGER
);
CREATE INDEX idx_mail_accounts_user ON mail_accounts(user_id);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  delimiter TEXT NOT NULL DEFAULT '/',
  special_use TEXT,
  uidvalidity INTEGER,
  highest_uid INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  UNIQUE(account_id, path)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid INTEGER NOT NULL,
  message_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  from_json TEXT NOT NULL DEFAULT '[]',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  date INTEGER,
  size INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  draft INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  body_text TEXT,
  body_html TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  fetched_full INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(folder_id, uid)
);
CREATE INDEX idx_messages_folder_date ON messages(folder_id, date DESC);
CREATE INDEX idx_messages_account ON messages(account_id);
CREATE INDEX idx_messages_msgid ON messages(message_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_row_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  content BLOB
);
CREATE INDEX idx_attachments_message ON attachments(message_row_id);

CREATE TABLE message_extras (
  message_row_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  summary TEXT,
  classification TEXT,
  draft_reply TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'none',
  base_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  api_key_enc TEXT NOT NULL DEFAULT '',
  system_hint TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
INSERT INTO ai_settings (id, provider, updated_at) VALUES (1, 'none', 0);

CREATE VIRTUAL TABLE message_fts USING fts5(
  subject, people, body,
  content='messages', content_rowid='rowid'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO message_fts(rowid, subject, people, body)
  VALUES (
    new.rowid,
    new.subject,
    new.from_json || ' ' || new.to_json || ' ' || new.cc_json,
    new.snippet || ' ' || COALESCE(new.body_text, '')
  );
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO message_fts(message_fts, rowid, subject, people, body)
  VALUES ('delete', old.rowid, old.subject, old.from_json || ' ' || old.to_json || ' ' || old.cc_json, old.snippet || ' ' || COALESCE(old.body_text, ''));
END;

CREATE TRIGGER messages_au AFTER UPDATE OF subject, from_json, to_json, cc_json, snippet, body_text ON messages BEGIN
  INSERT INTO message_fts(message_fts, rowid, subject, people, body)
  VALUES ('delete', old.rowid, old.subject, old.from_json || ' ' || old.to_json || ' ' || old.cc_json, old.snippet || ' ' || COALESCE(old.body_text, ''));
  INSERT INTO message_fts(rowid, subject, people, body)
  VALUES (
    new.rowid,
    new.subject,
    new.from_json || ' ' || new.to_json || ' ' || new.cc_json,
    new.snippet || ' ' || COALESCE(new.body_text, '')
  );
END;
`,
  },
]

const MIGRATION_V3 = {
  version: 3,
  name: 'contacts-and-app-meta',
  sql: `
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'auto',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, email)
);
CREATE INDEX idx_contacts_user_freq ON contacts(user_id, message_count DESC, last_message_at DESC);

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
}

const MIGRATION_V2 = {
  version: 2,
  name: 'reply-refs-and-user-settings',
  sql: `
ALTER TABLE messages ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN in_reply_to TEXT;
ALTER TABLE messages ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_interval_ms INTEGER NOT NULL DEFAULT 60000,
  updated_at INTEGER NOT NULL
);
`,
}

const MIGRATION_V4 = {
  version: 4,
  name: 'locale-and-translations',
  sql: `
ALTER TABLE user_settings ADD COLUMN locale TEXT NOT NULL DEFAULT '';
ALTER TABLE message_extras ADD COLUMN translation_json TEXT;
`,
}

export function openDatabase(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'hermodmail.sqlite')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

/** In-memory database with the same migrations — used by the test suite. */
export function openInMemoryDatabase(): DB {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (const m of ALL_MIGRATIONS) {
    if (m.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

const ALL_MIGRATIONS = [...MIGRATIONS, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4]
