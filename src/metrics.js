import { WORK, EDITOR_DONE, DELIVERED_TO, AFTER_DELIVERY, FINISHED, IN_PRODUCTION, needsReview, needsApproval, changesRequested, readyToPost, wasPosted } from './rules.js';
import { getSetting } from './db.js';
import { DAY, startOfDay, startOfWeek, localDate, monthlyPeriod } from './time.js';

const ph = (a) => a.map(() => '?').join(', ');
const iso = (d) => new Date(d).toISOString();
const ids = (s) => JSON.parse(s || '[]');

// What counts toward the package inside the window: each video the first time it is posted,
// times the number of accounts it went out on (the card's own number if it has one, else the client's default).
export function deliveredCount(db, clientId, since, until = '9999') {
  const { n } = db.prepare(
    `SELECT COALESCE(SUM(w), 0) AS n FROM (
       SELECT DISTINCT e.card_id, COALESCE(c.weight, cl.count_multiplier, 1) AS w
       FROM events e JOIN cards c ON c.id = e.card_id JOIN clients cl ON cl.id = e.client_id
       WHERE e.client_id = ? AND e.at >= ? AND e.at < ? AND e.source != 'baseline' AND e.field IN ('status', 'created')
         AND e.to_value IN (${ph(DELIVERED_TO)}) AND (e.from_value IS NULL OR e.from_value NOT IN (${ph(AFTER_DELIVERY)}))
     )`,
  ).get(clientId, since, until, ...DELIVERED_TO, ...AFTER_DELIVERY);
  return Math.round(n * 10) / 10;
}

function postedCount(db, clientId, since) {
  return db.prepare(
    `SELECT COUNT(DISTINCT card_id) AS n FROM events
     WHERE client_id = ? AND at >= ? AND source != 'baseline' AND field IN ('status', 'created') AND to_value = 'Posted'`,
  ).get(clientId, since).n;
}

// The billing period a client is in: Stripe's if we have it, else their anchor day, else the calendar month.
export function billingPeriod(client, billing, now) {
  if (billing?.period_start && billing?.period_end && billing.period_end > iso(now)) {
    return { start: billing.period_start, end: billing.period_end, source: 'stripe' };
  }
  const day = client.period_anchor ? Number(client.period_anchor.slice(8, 10)) : 1;
  const { start, end } = monthlyPeriod(day || 1, new Date(now));
  return { start: iso(start), end: iso(end), source: client.period_anchor ? 'anchor' : 'calendar' };
}

export function packageProgress(db, client, billing, now) {
  const period = billingPeriod(client, billing, now);
  const delivered = deliveredCount(db, client.id, period.start, period.end);
  const out = { size: client.package_size ?? null, max: client.package_max ?? client.package_size ?? null, delivered, period_start: period.start, period_end: period.end, period_source: period.source };
  out.days_left = Math.max(0, Math.ceil((Date.parse(period.end) - now) / DAY));
  if (client.package_size) {
    const elapsed = Math.min(1, Math.max(0, (now - Date.parse(period.start)) / (Date.parse(period.end) - Date.parse(period.start))));
    out.expected = Math.round(client.package_size * elapsed);
    out.remaining = Math.max(0, client.package_size - delivered);
    out.remaining_to_max = Math.max(0, out.max - delivered);
    out.pace = delivered >= client.package_size ? 'complete' : delivered >= out.expected ? 'on_track' : 'behind';
  }
  return out;
}

function clientSummary(db, cfg, client, now) {
  const cards = db.prepare('SELECT * FROM cards WHERE client_id = ? AND missing_since IS NULL').all(client.id);
  const today = localDate(cfg.tz, new Date(now));
  const by_status = {};
  for (const c of cards) by_status[c.status || 'No status'] = (by_status[c.status || 'No status'] || 0) + 1;
  const billingRow = db.prepare('SELECT * FROM billing WHERE client_id = ?').get(client.id);
  const billing = billingRow ? { ...JSON.parse(billingRow.data), checked_at: billingRow.checked_at, error: billingRow.error } : null;
  const slack = db.prepare('SELECT waiting, waiting_since, last_from, last_text, checked_at, error FROM slack_status WHERE client_id = ?').get(client.id) || null;
  const ready = cards.filter(readyToPost).length;
  const posted30 = postedCount(db, client.id, iso(now - 30 * DAY));
  return {
    id: client.id,
    slug: client.slug,
    name: client.name,
    counts_as: client.count_multiplier,
    synced: Boolean(client.baseline_at),
    live_since: client.baseline_at,
    total: cards.length,
    by_status,
    in_production: cards.filter((c) => IN_PRODUCTION.includes(c.status)).length,
    needs_review: cards.filter(needsReview).length,
    needs_approval: cards.filter(needsApproval).length,
    changes_requested: cards.filter(changesRequested).length,
    ready,
    overdue: cards.filter((c) => c.due_date && c.due_date.slice(0, 10) < today && !FINISHED.includes(c.status)).length,
    delivered_7d: deliveredCount(db, client.id, iso(now - 7 * DAY)),
    delivered_30d: deliveredCount(db, client.id, iso(now - 30 * DAY)),
    posted_30d: posted30,
    // Days of finished videos in the bank at the pace they have been posting.
    runway_days: posted30 > 0 ? Math.round((ready / (posted30 / 30)) * 10) / 10 : null,
    package: packageProgress(db, client, billing, now),
    billing,
    slack: slack ? { ...slack, waiting: Boolean(slack.waiting) } : null,
  };
}

function editorDone(db, since) {
  const rows = db.prepare(
    `SELECT j.value AS editor_id, COUNT(DISTINCT e.card_id) AS n FROM events e, json_each(e.editor_ids) j
     WHERE e.at >= ? AND e.field = 'status' AND e.source IN ('sync', 'portal')
       AND e.to_value IN (${ph(EDITOR_DONE)}) AND e.from_value IN (${ph(WORK)})
     GROUP BY j.value`,
  ).all(since, ...EDITOR_DONE, ...WORK);
  return new Map(rows.map((r) => [r.editor_id, r.n]));
}

function editorSummaries(db, cfg, now) {
  const queue = new Map();
  const revisions = new Map();
  const cards = db.prepare(`SELECT status, editor_ids FROM cards WHERE missing_since IS NULL AND status IN (${ph(WORK)})`).all(...WORK);
  for (const c of cards) {
    for (const id of ids(c.editor_ids)) {
      queue.set(id, (queue.get(id) || 0) + 1);
      if (c.status === 'Revisions') revisions.set(id, (revisions.get(id) || 0) + 1);
    }
  }
  const today = editorDone(db, iso(startOfDay(cfg.tz, new Date(now))));
  const week = editorDone(db, iso(now - 7 * DAY));
  const month = editorDone(db, iso(now - 30 * DAY));
  const names = new Map(db.prepare('SELECT id, name, email FROM notion_users').all().map((u) => [u.id, u]));
  return [...new Set([...queue.keys(), ...month.keys()])]
    .map((id) => ({
      notion_user_id: id,
      name: names.get(id)?.name || 'Unknown',
      email: names.get(id)?.email || null,
      queue: queue.get(id) || 0,
      in_revisions: revisions.get(id) || 0,
      done_today: today.get(id) || 0,
      done_7d: week.get(id) || 0,
      done_30d: month.get(id) || 0,
    }))
    .sort((a, b) => b.done_7d - a.done_7d || b.queue - a.queue || a.name.localeCompare(b.name));
}

// Edits waiting on the team's own review before the client sees them, longest wait first.
function reviewQueue(db) {
  return db.prepare(
    `SELECT c.id, c.title, c.editor_names, c.due_date, c.priority, c.review_link, c.notion_url, c.file_count > 0 AS has_media,
            cl.name AS client_name, cl.slug AS client_slug,
            COALESCE((SELECT MAX(e.at) FROM events e WHERE e.card_id = c.id AND e.field IN ('status', 'created')
                        AND e.to_value = 'Review' AND e.source != 'baseline'), c.last_edited_at) AS since
     FROM cards c JOIN clients cl ON cl.id = c.client_id
     WHERE c.missing_since IS NULL AND cl.active = 1 AND c.status = 'Review' ORDER BY since`,
  ).all().map((c) => ({ ...c, has_media: Boolean(c.has_media) }));
}

export function recentEvents(db, { clientId = null, limit = 50, before = null } = {}) {
  const where = ["e.source IN ('sync', 'portal')"]; // what really happened since go-live, not the day-one estimates
  const args = [];
  if (clientId) {
    where.push('e.client_id = ?');
    args.push(clientId);
  }
  if (before) {
    where.push('e.id < ?');
    args.push(before);
  }
  return db.prepare(
    `SELECT e.id, e.card_id, e.card_title, e.field, e.from_value, e.to_value, e.editor_names, e.at, e.source, e.note,
            cl.name AS client_name, cl.slug AS client_slug, u.name AS actor_name
     FROM events e JOIN clients cl ON cl.id = e.client_id LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`,
  ).all(...args, Math.min(500, Math.max(1, Number(limit) || 50)));
}

export function lastSync(db) {
  const run = db.prepare('SELECT started_at, finished_at, ok, cards, events, detail FROM sync_runs ORDER BY id DESC LIMIT 1').get();
  return run ? { ...run, ok: Boolean(run.ok), detail: JSON.parse(run.detail || '[]') } : null;
}

export function adminOverview(db, cfg, now = Date.now()) {
  const clients = db.prepare('SELECT * FROM clients WHERE active = 1 ORDER BY name').all().map((c) => clientSummary(db, cfg, c, now));
  const sum = (k) => clients.reduce((n, c) => n + (c[k] || 0), 0);
  return {
    generated_at: iso(now),
    timezone: cfg.tz,
    last_sync: lastSync(db),
    totals: {
      delivered_7d: sum('delivered_7d'),
      delivered_30d: sum('delivered_30d'),
      in_production: sum('in_production'),
      needs_review: sum('needs_review'),
      needs_approval: sum('needs_approval'),
      ready: sum('ready'),
      overdue: sum('overdue'),
      slack_waiting: clients.filter((c) => c.slack?.waiting).length,
      behind_on_package: clients.filter((c) => c.package.pace === 'behind').length,
    },
    clients,
    reviewers: getSetting(db, 'reviewer_names', ['Ahmed', 'Genji']),
    needs_review: reviewQueue(db),
    editors: editorSummaries(db, cfg, now),
    recent_events: recentEvents(db, { limit: 40 }),
  };
}

const clientCard = (c) => ({
  id: c.id, title: c.title, status: c.status, approval: c.approval, due_date: c.due_date, posted_date: c.posted_date,
  posted_link: c.posted_link, review_link: c.review_link, has_media: c.file_count > 0, funnel: c.funnel, posting: c.posting,
});

const byDate = (key, dir = 1) => (a, b) => dir * String(a[key] || '9999').localeCompare(String(b[key] || '9999'));

// Everything a client login gets. Nothing about editors, priorities, delays, money or other clients.
export function clientOverview(db, cfg, client, now = Date.now()) {
  const cards = db.prepare('SELECT * FROM cards WHERE client_id = ? AND missing_since IS NULL').all(client.id);
  const billingRow = db.prepare('SELECT data FROM billing WHERE client_id = ?').get(client.id);
  const pkg = packageProgress(db, client, billingRow ? JSON.parse(billingRow.data) : null, now);
  return {
    client: { name: client.name, slug: client.slug, bg_video: client.bg_video },
    needs_approval: cards.filter(needsApproval).sort(byDate('due_date')).map(clientCard),
    changes_requested: cards.filter(changesRequested).sort(byDate('due_date')).map(clientCard),
    ready: cards.filter(readyToPost).sort(byDate('due_date')).map(clientCard),
    posted: cards.filter(wasPosted).sort(byDate('posted_date', -1)).slice(0, 60).map(clientCard),
    in_production: cards.filter((c) => IN_PRODUCTION.includes(c.status) && !needsApproval(c) && !changesRequested(c)).length,
    package: client.package_size ? { size: pkg.size, max: pkg.max, delivered: pkg.delivered, remaining: pkg.remaining, period_end: pkg.period_end, days_left: pkg.days_left } : null,
  };
}

const PRIORITY = { High: 0, Medium: 1, Low: 2 };

export function editorOverview(db, cfg, user, now = Date.now()) {
  const id = user.notion_user_id;
  const empty = { linked: false, queue: [], in_review: [], done_today: [], done_week: [], counts: { queue: 0, revisions: 0, done_today: 0, done_week: 0 } };
  if (!id) return empty;
  const mine = db.prepare(
    `SELECT c.*, cl.name AS client_name FROM cards c JOIN clients cl ON cl.id = c.client_id
     WHERE c.missing_since IS NULL AND cl.active = 1 AND EXISTS (SELECT 1 FROM json_each(c.editor_ids) WHERE value = ?)`,
  ).all(id);
  const notes = db.prepare('SELECT author, note, created_at FROM feedback WHERE card_id = ? ORDER BY id DESC LIMIT 3');
  const card = (c) => ({
    id: c.id, title: c.title, client: c.client_name, status: c.status, approval: c.approval, priority: c.priority, due_date: c.due_date,
    review_link: c.review_link, script_url: c.script_url, inspo_url: c.inspo_url, notion_url: c.notion_url, delay_reason: c.delay_reason,
    has_media: c.file_count > 0, feedback: c.status === 'Revisions' ? notes.all(c.id) : [],
  });
  const weekStart = iso(startOfWeek(cfg.tz, new Date(now)));
  const todayStart = iso(startOfDay(cfg.tz, new Date(now)));
  const done = db.prepare(
    `SELECT e.card_id, e.card_title AS title, e.from_value, e.to_value, e.at, cl.name AS client
     FROM events e JOIN clients cl ON cl.id = e.client_id
     WHERE e.at >= ? AND e.field = 'status' AND e.source IN ('sync', 'portal')
       AND e.to_value IN (${ph(EDITOR_DONE)}) AND e.from_value IN (${ph(WORK)})
       AND EXISTS (SELECT 1 FROM json_each(e.editor_ids) WHERE value = ?)
     ORDER BY e.at DESC`,
  ).all(weekStart, ...EDITOR_DONE, ...WORK, id);
  const seen = new Set();
  const doneWeek = done.filter((d) => !seen.has(d.card_id) && seen.add(d.card_id));
  const doneToday = doneWeek.filter((d) => d.at >= todayStart);
  const queue = mine.filter((c) => WORK.includes(c.status))
    .sort((a, b) => (PRIORITY[a.priority] ?? 3) - (PRIORITY[b.priority] ?? 3) || byDate('due_date')(a, b));
  return {
    linked: true,
    queue: queue.map(card),
    in_review: mine.filter((c) => c.status === 'Review').map(card),
    done_today: doneToday,
    done_week: doneWeek,
    counts: { queue: queue.length, revisions: queue.filter((c) => c.status === 'Revisions').length, done_today: doneToday.length, done_week: doneWeek.length },
  };
}
