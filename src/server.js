import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { nowIso, getSetting, setSetting } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, sessionUser, createInvite, acceptInvite, createApiKey, apiKeyValid,
  SESSION_DAYS, MIN_PASSWORD,
} from './auth.js';
import { adminOverview, clientOverview, editorOverview, recentEvents, lastSync } from './metrics.js';
import { applyCardChange } from './sync.js';
import { pageFiles } from './notion.js';
import { STATUSES, WORK, needsReview, needsApproval, readyToPost, clientVisible } from './rules.js';
import { localDate } from './time.js';

const COOKIE = 'ody_session';
const DUMMY_HASH = await hashPassword('not-a-real-password');
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || ''));
const ids = (s) => JSON.parse(s || '[]');

export async function buildServer({ db, cfg, notion = null, slack = null, stripe = null, jobs = null, logger = false }) {
  const app = Fastify({ trustProxy: true, bodyLimit: 64 * 1024, logger });
  await app.register(cookie);
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: cfg.prod, path: '/', maxAge: SESSION_DAYS * 86_400 };

  app.decorateRequest('user', null);
  app.decorateRequest('viaKey', false);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    if (bearer) {
      req.viaKey = apiKeyValid(db, bearer);
      return;
    }
    req.user = sessionUser(db, req.cookies[COOKIE]);
    // Cookie logins only accept changes that come from the portal's own pages.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      let same = req.headers['x-portal'] === '1';
      if (origin) {
        try {
          same = new URL(origin).host === req.headers.host;
        } catch {
          same = false;
        }
      }
      if (!same) return reply.code(403).send({ error: 'Cross-site request blocked' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on our side' });
  });

  const need = (...roles) => async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in to continue' });
    if (!roles.includes(req.user.role)) return reply.code(403).send({ error: 'You do not have access to this' });
  };
  const admin = { preHandler: need('admin') };

  const hits = new Map();
  function limited(key, max, windowMs) {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      return false;
    }
    return ++h.n > max;
  }

  // Editors are matched to their Notion account by email the first time it is needed.
  function linkEditor(user) {
    if (user.role !== 'editor' || user.notion_user_id) return user;
    const match = db.prepare('SELECT id FROM notion_users WHERE lower(email) = ?').get(user.email);
    if (!match) return user;
    db.prepare('UPDATE users SET notion_user_id = ? WHERE id = ?').run(match.id, user.id);
    return { ...user, notion_user_id: match.id };
  }

  const publicUser = (u) => {
    const client = u.client_id ? db.prepare('SELECT name, slug, bg_video FROM clients WHERE id = ?').get(u.client_id) : null;
    return { id: u.id, email: u.email, name: u.name, role: u.role, client, linked_to_notion: u.role === 'editor' ? Boolean(u.notion_user_id) : undefined };
  };

  // ---------- health and sign-in ----------

  // Public and safe to share: no names, no content, just whether the machinery is turning.
  app.get('/api/health', async () => {
    const run = lastSync(db);
    return {
      ok: true,
      last_sync_at: run?.finished_at || null,
      last_sync_ok: run ? run.ok : null,
      boards: run ? run.detail.length : 0,
      boards_ok: run ? run.detail.filter((r) => r.ok).length : 0,
      cards: run?.cards ?? 0,
      notion: Boolean(notion), slack: Boolean(slack), stripe: Boolean(stripe),
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (limited(`ip:${req.ip}`, 30, 600_000) || limited(`email:${email}`, 8, 600_000)) {
      return reply.code(429).send({ error: 'Too many attempts. Try again in a few minutes' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    const ok = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
    if (!user?.password_hash || !ok) return reply.code(401).send({ error: 'Wrong email or password' });
    reply.setCookie(COOKIE, createSession(db, user.id), cookieOpts);
    return { user: publicUser(linkEditor(user)) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(db, req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/accept-invite', async (req, reply) => {
    const password = String(req.body?.password || '');
    if (limited(`invite:${req.ip}`, 20, 600_000)) return reply.code(429).send({ error: 'Too many attempts. Try again in a few minutes' });
    if (password.length < MIN_PASSWORD) return reply.code(400).send({ error: `Use at least ${MIN_PASSWORD} characters` });
    const user = await acceptInvite(db, req.body?.token, password);
    if (!user) return reply.code(400).send({ error: 'This invite link has expired or was already used' });
    reply.setCookie(COOKIE, createSession(db, user.id), cookieOpts);
    return { user: publicUser(linkEditor(user)) };
  });

  app.get('/api/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in to continue' });
    return { user: publicUser(linkEditor(req.user)) };
  });

  // ---------- the three views ----------

  app.get('/api/admin/overview', admin, async () => adminOverview(db, cfg));

  app.get('/api/client/overview', { preHandler: need('client', 'admin') }, async (req, reply) => {
    // An admin can preview any client's portal with ?client=slug. A client only ever gets their own.
    const client = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM clients WHERE slug = ?').get(String(req.query.client || ''))
      : db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(req.user.client_id);
    if (!client) return reply.code(404).send({ error: 'Client not found' });
    return clientOverview(db, cfg, client);
  });

  app.get('/api/editor/overview', { preHandler: need('editor', 'admin') }, async (req, reply) => {
    if (req.user.role === 'editor') return editorOverview(db, cfg, linkEditor(req.user));
    const id = String(req.query.editor || '');
    if (!id) return reply.code(400).send({ error: 'Pass ?editor=<notion user id>' });
    return editorOverview(db, cfg, { notion_user_id: id });
  });

  // Read-only summary for other tools (an assistant, a spreadsheet). Needs an API key made by an admin.
  app.get('/api/v1/summary', async (req, reply) => {
    if (!req.viaKey) return reply.code(401).send({ error: 'A valid API key is required' });
    return adminOverview(db, cfg);
  });

  // ---------- card actions (these write to Notion) ----------

  function cardFor(req) {
    const card = db.prepare('SELECT * FROM cards WHERE id = ? AND missing_since IS NULL').get(String(req.params.id));
    if (!card) return null;
    const u = req.user;
    if (u.role === 'admin') return card;
    if (u.role === 'client') return u.client_id === card.client_id && clientVisible(card) ? card : null;
    if (u.role === 'editor') return u.notion_user_id && ids(card.editor_ids).includes(u.notion_user_id) ? card : null;
    return null;
  }

  async function change(req, reply, card, changes, note) {
    if (!notion) return reply.code(503).send({ error: 'Notion is not connected yet' });
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(card.client_id);
    try {
      const updated = await applyCardChange(db, notion, { card, client, user: req.user, changes, note });
      return { ok: true, card: { id: updated.id, status: updated.status, approval: updated.approval, posted_date: updated.posted_date, posted_link: updated.posted_link } };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: 'Could not save that to Notion. Try again in a moment' });
    }
  }

  const missing = (reply) => reply.code(404).send({ error: 'Video not found' });

  function saveFeedback(req, card, note, lead) {
    const author = req.user.name || req.user.email;
    db.prepare('INSERT INTO feedback (card_id, client_id, user_id, author, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(card.id, card.client_id, req.user.id, author, note, nowIso());
    // Also leave the note on the Notion card. The portal keeps its own copy, so a failure here loses nothing.
    notion.comment(card.id, `${lead} ${author}: ${note}`).catch((err) => req.log.warn(err));
  }
  const anyone = { preHandler: need('admin', 'client', 'editor') };

  app.post('/api/cards/:id/approve', { preHandler: need('admin', 'client') }, async (req, reply) => {
    const card = cardFor(req);
    if (!card) return missing(reply);
    if (req.user.role === 'client' && !needsApproval(card)) return reply.code(409).send({ error: 'This video is not waiting for approval' });
    return change(req, reply, card, { approval: 'approved' });
  });

  app.post('/api/cards/:id/request-changes', { preHandler: need('admin', 'client') }, async (req, reply) => {
    const card = cardFor(req);
    if (!card) return missing(reply);
    const note = String(req.body?.note || '').trim();
    if (note.length < 3 || note.length > 2000) return reply.code(400).send({ error: 'Say what should change, in up to 2,000 characters' });
    if (req.user.role === 'client' && !needsApproval(card)) return reply.code(409).send({ error: 'This video is not waiting for approval' });
    const result = await change(req, reply, card, { approval: 'changes_requested', status: 'Revisions' }, note);
    if (result?.ok) saveFeedback(req, card, note, 'Changes requested by');
    return result;
  });

  // The team's own review (Ahmed or Genji): pass an edit on, or send it back to the editor with a note.
  app.post('/api/cards/:id/review', admin, async (req, reply) => {
    const card = cardFor(req);
    if (!card) return missing(reply);
    if (!needsReview(card)) return reply.code(409).send({ error: 'This video is not in review' });
    const decision = String(req.body?.decision || '');
    if (decision === 'pass') {
      // Passing sends it to the client for approval when their board uses approvals, unless told otherwise.
      const labels = JSON.parse(db.prepare('SELECT prop_map FROM clients WHERE id = ?').get(card.client_id).prop_map || '{}').approval?.labels || {};
      const askClient = labels.needs_client && (req.body?.needs_client ?? ['needs_client', 'changes_requested'].includes(card.approval));
      return change(req, reply, card, { status: 'Ready', ...(askClient ? { approval: 'needs_client' } : {}) });
    }
    if (decision === 'changes') {
      const note = String(req.body?.note || '').trim();
      if (note.length < 3 || note.length > 2000) return reply.code(400).send({ error: 'Say what should change, in up to 2,000 characters' });
      const result = await change(req, reply, card, { status: 'Revisions' }, note);
      if (result?.ok) saveFeedback(req, card, note, 'Sent back by');
      return result;
    }
    return reply.code(400).send({ error: 'Decision must be pass or changes' });
  });

  app.post('/api/cards/:id/mark-posted', { preHandler: need('admin', 'client') }, async (req, reply) => {
    const card = cardFor(req);
    if (!card) return missing(reply);
    if (req.user.role === 'client' && !readyToPost(card)) return reply.code(409).send({ error: 'This video is not ready to post yet' });
    const url = String(req.body?.url || '').trim();
    const date = String(req.body?.date || localDate(cfg.tz));
    if (url && !isUrl(url)) return reply.code(400).send({ error: 'That link does not look right' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ error: 'Use a date like 2026-11-23' });
    return change(req, reply, card, { status: 'Posted', posted_date: date, ...(url ? { posted_link: url } : {}) });
  });

  app.post('/api/cards/:id/status', { preHandler: need('admin', 'editor') }, async (req, reply) => {
    const card = cardFor(req);
    if (!card) return missing(reply);
    const status = String(req.body?.status || '');
    if (!STATUSES.includes(status)) return reply.code(400).send({ error: 'Unknown status' });
    if (req.user.role === 'editor' && !(WORK.includes(card.status) && ['Editing', 'Review'].includes(status))) {
      return reply.code(409).send({ error: 'Editors can start a video or send it to review' });
    }
    return change(req, reply, card, { status });
  });

  // Fresh links to the files on the card, fetched at the moment someone presses play.
  app.get('/api/cards/:id/media', anyone, async (req, reply) => {
    const card = cardFor(req);
    if (!card) return missing(reply);
    if (!notion) return reply.code(503).send({ error: 'Notion is not connected yet' });
    const client = db.prepare('SELECT prop_map FROM clients WHERE id = ?').get(card.client_id);
    try {
      return { files: pageFiles(await notion.page(card.id), JSON.parse(client.prop_map || '{}')), review_link: card.review_link };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: 'Could not load the video from Notion' });
    }
  });

  app.get('/api/cards/:id/feedback', anyone, async (req, reply) => {
    const card = cardFor(req);
    if (!card) return missing(reply);
    return { feedback: db.prepare('SELECT author, note, created_at FROM feedback WHERE card_id = ? ORDER BY id DESC LIMIT 50').all(card.id) };
  });

  // ---------- admin: clients ----------

  const CLIENT_FIELDS = ['name', 'slug', 'slack_channel_id', 'stripe_customer_id', 'package_size', 'package_max', 'count_multiplier', 'period_anchor', 'bg_video', 'active'];

  function cleanClient(body) {
    const out = {};
    for (const k of CLIENT_FIELDS) {
      if (!(k in (body || {}))) continue;
      let v = body[k];
      if (k === 'active') v = v ? 1 : 0;
      else if (k === 'package_size' || k === 'package_max') v = v === null || v === '' ? null : Math.max(0, Math.floor(Number(v)));
      else if (k === 'count_multiplier') v = Number(v);
      else if (k === 'slug') v = slugify(v);
      else v = v === null || v === '' ? null : String(v).trim();
      if (k.startsWith('package_') && Number.isNaN(v)) throw Object.assign(new Error('Package size must be a number'), { statusCode: 400 });
      if (k === 'count_multiplier' && !(v > 0 && v <= 20)) throw Object.assign(new Error('Counts-as must be a number between 0 and 20'), { statusCode: 400 });
      if (k === 'period_anchor' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw Object.assign(new Error('Use a date like 2026-11-01'), { statusCode: 400 });
      if ((k === 'name' || k === 'slug') && !v) throw Object.assign(new Error(`A client needs a ${k}`), { statusCode: 400 });
      out[k] = v;
    }
    return out;
  }

  app.get('/api/admin/clients', admin, async () => ({
    clients: db.prepare(
      `SELECT id, slug, name, notion_data_source_id, notion_url, slack_channel_id, stripe_customer_id, package_size, package_max, count_multiplier, period_anchor,
              bg_video, active, baseline_at FROM clients ORDER BY name`,
    ).all(),
  }));

  app.post('/api/admin/clients', admin, async (req, reply) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'A client needs a name' });
    let dataSourceId = null;
    if (req.body?.notion) {
      if (!notion) return reply.code(503).send({ error: 'Notion is not connected yet' });
      try {
        dataSourceId = await notion.resolveDataSourceId(req.body.notion);
      } catch (err) {
        return reply.code(400).send({ error: `Could not open that board. Is it shared with the Odyssey Portal integration? (${err.message})` });
      }
    }
    try {
      const r = db.prepare('INSERT INTO clients (slug, name, notion_data_source_id, notion_url, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(slugify(req.body?.slug || name), name, dataSourceId, isUrl(req.body?.notion) ? req.body.notion : null, nowIso());
      jobs?.sync().catch(() => {});
      return { id: Number(r.lastInsertRowid) };
    } catch {
      return reply.code(409).send({ error: 'A client with that name or board already exists' });
    }
  });

  app.patch('/api/admin/clients/:id', admin, async (req, reply) => {
    const fields = cleanClient(req.body);
    const keys = Object.keys(fields);
    if (!keys.length) return reply.code(400).send({ error: 'Nothing to change' });
    try {
      const r = db.prepare(`UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), Number(req.params.id));
      if (!r.changes) return reply.code(404).send({ error: 'Client not found' });
    } catch {
      return reply.code(409).send({ error: 'That short name is already taken' });
    }
    if ('slack_channel_id' in fields) jobs?.slack().catch(() => {});
    if ('stripe_customer_id' in fields) jobs?.billing().catch(() => {});
    return { ok: true };
  });

  // Boards the integration can see that are not attached to a client yet.
  app.get('/api/admin/notion/boards', admin, async (req, reply) => {
    if (!notion) return reply.code(503).send({ error: 'Notion is not connected yet' });
    const attached = new Set(db.prepare('SELECT notion_data_source_id FROM clients').all().map((c) => c.notion_data_source_id));
    const all = await notion.listDataSources();
    return {
      boards: all
        .filter((d) => Object.values(d.properties || {}).some((p) => p.type === 'status' || (p.type === 'select' && p.name === 'Status')))
        .map((d) => ({ id: d.id, title: (d.title || []).map((t) => t.plain_text).join('') || 'Untitled', url: d.url || null, attached: attached.has(d.id) })),
    };
  });

  // ---------- admin: people ----------

  const inviteUrl = (token) => `${cfg.baseUrl}/invite/${token}`;

  app.get('/api/admin/users', admin, async () => ({
    users: db.prepare(
      `SELECT u.id, u.email, u.name, u.role, u.client_id, u.notion_user_id, u.active, u.created_at, c.name AS client_name,
              u.password_hash IS NOT NULL AS has_password
       FROM users u LEFT JOIN clients c ON c.id = u.client_id ORDER BY u.role, u.name`,
    ).all(),
    notion_people: db.prepare('SELECT id, name, email FROM notion_users ORDER BY name').all(),
  }));

  app.post('/api/admin/users', admin, async (req, reply) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || '');
    const clientId = role === 'client' ? Number(req.body?.client_id) : null;
    if (!/^\S+@\S+\.\S+$/.test(email)) return reply.code(400).send({ error: 'Enter a valid email' });
    if (!['admin', 'editor', 'client'].includes(role)) return reply.code(400).send({ error: 'Role must be admin, editor or client' });
    if (role === 'client' && !db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId)) return reply.code(400).send({ error: 'Pick which client this login belongs to' });
    try {
      const r = db.prepare('INSERT INTO users (email, name, role, client_id, notion_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(email, String(req.body?.name || '').trim(), role, clientId, req.body?.notion_user_id || null, nowIso());
      const id = Number(r.lastInsertRowid);
      return { id, invite_url: inviteUrl(createInvite(db, id)) };
    } catch {
      return reply.code(409).send({ error: 'Someone already has that email' });
    }
  });

  app.post('/api/admin/users/:id/invite', admin, async (req, reply) => {
    const user = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(Number(req.params.id));
    if (!user) return reply.code(404).send({ error: 'Person not found' });
    return { invite_url: inviteUrl(createInvite(db, user.id)) };
  });

  app.patch('/api/admin/users/:id', admin, async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const set = {};
    if ('name' in b) set.name = String(b.name).trim();
    if ('notion_user_id' in b) set.notion_user_id = b.notion_user_id || null;
    if ('active' in b) set.active = b.active ? 1 : 0;
    if (set.active === 0 && id === req.user.id) return reply.code(400).send({ error: 'You cannot switch off your own login' });
    const keys = Object.keys(set);
    if (!keys.length) return reply.code(400).send({ error: 'Nothing to change' });
    const r = db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), id);
    if (!r.changes) return reply.code(404).send({ error: 'Person not found' });
    if (set.active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { ok: true };
  });

  // ---------- admin: keys, settings, lookups, sync ----------

  app.get('/api/admin/api-keys', admin, async () => ({
    keys: db.prepare('SELECT id, name, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id DESC').all(),
  }));
  app.post('/api/admin/api-keys', admin, async (req, reply) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'Name the key so you know what uses it' });
    return { key: createApiKey(db, name), note: 'Shown once. Store it now' };
  });
  app.delete('/api/admin/api-keys/:id', admin, async (req) => {
    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), Number(req.params.id));
    return { ok: true };
  });

  const LISTS = { slack_team_user_ids: [], reviewer_names: ['Ahmed', 'Genji'] };
  app.get('/api/admin/settings', admin, async () => Object.fromEntries(Object.entries(LISTS).map(([k, d]) => [k, getSetting(db, k, d)])));
  app.patch('/api/admin/settings', admin, async (req, reply) => {
    const changes = Object.entries(req.body || {}).filter(([k]) => k in LISTS);
    if (!changes.length) return reply.code(400).send({ error: 'Nothing to change' });
    for (const [k, list] of changes) {
      if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) return reply.code(400).send({ error: `${k} must be a list of names or IDs` });
    }
    for (const [k, list] of changes) setSetting(db, k, list);
    return { ok: true };
  });

  const lookup = (service, label, fn) => async (req, reply) => {
    if (!service) return reply.code(503).send({ error: `${label} is not connected yet` });
    try {
      return await fn();
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: `${label} did not answer: ${err.message}` });
    }
  };
  app.get('/api/admin/slack/channels', admin, lookup(slack, 'Slack', async () => ({ channels: await slack.channels() })));
  app.get('/api/admin/slack/users', admin, lookup(slack, 'Slack', async () => ({ users: await slack.users() })));
  app.get('/api/admin/stripe/customers', admin, lookup(stripe, 'Stripe', async () => ({ customers: await stripe.customers() })));

  app.post('/api/admin/sync', admin, async (req, reply) => {
    if (!jobs) return reply.code(503).send({ error: 'Sync is not running in this process' });
    return jobs.sync();
  });
  app.get('/api/admin/sync-runs', admin, async () => ({
    runs: db.prepare('SELECT id, started_at, finished_at, ok, cards, events, detail FROM sync_runs ORDER BY id DESC LIMIT 50').all()
      .map((r) => ({ ...r, ok: Boolean(r.ok), detail: JSON.parse(r.detail || '[]') })),
  }));
  app.get('/api/admin/events', admin, async (req) => ({
    events: recentEvents(db, { clientId: Number(req.query.client_id) || null, limit: req.query.limit, before: Number(req.query.before) || null }),
  }));

  // ---------- the web app (built later into web/dist) ----------

  const dist = path.resolve('web/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
  } else {
    app.get('/', async () => ({ name: 'Odyssey Portal', status: 'The API is running. The web app has not been built yet' }));
  }

  return app;
}
