import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { nowIso } from './db.js';

const scrypt = promisify(crypto.scrypt);
const DAY = 86_400_000;
export const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const later = (days) => new Date(Date.now() + days * DAY).toISOString();

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltHex, keyHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

// Only hashes of tokens are stored, so a copy of the database cannot be used to sign in.
export function createSession(db, userId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, nowIso(), later(SESSION_DAYS));
  return token;
}

export function sessionUser(db, token) {
  if (!token) return null;
  return db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
  ).get(sha256(token), nowIso()) || null;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function createInvite(db, userId) {
  const token = newToken();
  db.prepare('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, later(7));
  return token;
}

export async function acceptInvite(db, token, password) {
  const invite = db.prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(sha256(String(token || '')), nowIso());
  if (!invite) return null;
  const hash = await hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, invite.user_id);
  db.prepare('UPDATE invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(nowIso(), invite.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(invite.user_id);
  return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(invite.user_id) || null;
}

export function createApiKey(db, name, scope = 'read') {
  const key = `ody_${newToken()}`;
  db.prepare('INSERT INTO api_keys (name, key_hash, created_at, scope) VALUES (?, ?, ?, ?)').run(name, sha256(key), nowIso(), scope === 'full' ? 'full' : 'read');
  return key;
}

// Who a key belongs to and what it may do, or null for a key that is unknown or switched off.
export function apiKeyInfo(db, key) {
  const row = db.prepare('SELECT id, name, scope FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha256(String(key || '')));
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return row;
}

export function apiKeyValid(db, key) {
  const row = db.prepare('SELECT id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha256(key));
  if (!row) return false;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return true;
}
