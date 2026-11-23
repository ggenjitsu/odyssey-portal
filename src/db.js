import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Append a new string to add a migration. Never edit one that has shipped.
const MIGRATIONS = [
  `
  CREATE TABLE clients (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    notion_data_source_id TEXT UNIQUE,
    notion_url TEXT,
    prop_map TEXT,
    slack_channel_id TEXT,
    stripe_customer_id TEXT,
    package_size INTEGER,
    period_anchor TEXT,
    bg_video TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    baseline_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    title TEXT,
    status TEXT,
    approval TEXT,
    approval_raw TEXT,
    editor_ids TEXT NOT NULL DEFAULT '[]',
    editor_names TEXT NOT NULL DEFAULT '',
    priority TEXT,
    funnel TEXT,
    posting TEXT,
    due_date TEXT,
    posted_date TEXT,
    posted_link TEXT,
    review_link TEXT,
    script_url TEXT,
    inspo_url TEXT,
    delay_reason TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    notion_url TEXT,
    created_at TEXT,
    last_edited_at TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    missing_since TEXT
  );
  CREATE INDEX cards_client_status ON cards(client_id, status);

  -- The change log. Append-only: the triggers below refuse edits and deletes.
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL,
    client_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    card_title TEXT,
    editor_ids TEXT NOT NULL DEFAULT '[]',
    editor_names TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    source TEXT NOT NULL,
    actor_user_id INTEGER,
    note TEXT
  );
  CREATE INDEX events_client_at ON events(client_id, at);
  CREATE INDEX events_card ON events(card_id, at);
  CREATE INDEX events_at ON events(at);
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'client')),
    password_hash TEXT,
    client_id INTEGER REFERENCES clients(id),
    notion_user_id TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE feedback (
    id INTEGER PRIMARY KEY,
    card_id TEXT NOT NULL,
    client_id INTEGER NOT NULL,
    user_id INTEGER,
    author TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX feedback_card ON feedback(card_id, created_at);

  CREATE TABLE notion_users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    avatar_url TEXT
  );
  CREATE TABLE slack_status (
    client_id INTEGER PRIMARY KEY REFERENCES clients(id),
    channel_id TEXT,
    waiting INTEGER NOT NULL DEFAULT 0,
    waiting_since TEXT,
    last_from TEXT,
    last_text TEXT,
    checked_at TEXT,
    error TEXT
  );
  CREATE TABLE billing (
    client_id INTEGER PRIMARY KEY REFERENCES clients(id),
    data TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    error TEXT
  );
  CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    cards INTEGER NOT NULL DEFAULT 0,
    events INTEGER NOT NULL DEFAULT 0,
    detail TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const from = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = from; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

// Everything inside fn commits together or not at all. fn must be synchronous.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
