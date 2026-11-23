import { tx, nowIso } from './db.js';
import { resolvePropMap, normalizePage, buildProps } from './notion.js';

// One queue for everything that reads or writes Notion state, so a pull that started before a
// portal action can never land after it and log a change that did not happen.
function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => fn());
    tail = run.then(() => {}, () => {});
    return run;
  };
}
const locked = createMutex();

const CARD_COLS = [
  'title', 'status', 'approval', 'approval_raw', 'editor_ids', 'editor_names', 'priority', 'funnel', 'posting', 'due_date',
  'posted_date', 'posted_link', 'review_link', 'script_url', 'inspo_url', 'delay_reason', 'file_count', 'weight', 'notion_url',
  'created_at', 'last_edited_at',
];

const cardRow = (c) => Object.fromEntries(CARD_COLS.map((k) => [k, c[k] ?? (k === 'file_count' ? 0 : null)]));
const noon = (d) => (d.length === 10 ? `${d}T12:00:00.000Z` : new Date(d).toISOString());

function insertEvent(db, card, clientId, e) {
  db.prepare(
    `INSERT INTO events (card_id, client_id, field, from_value, to_value, card_title, editor_ids, editor_names, at, source, actor_user_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(card.id, clientId, e.field, e.from ?? null, e.to ?? null, card.title ?? null, card.editor_ids ?? '[]', card.editor_names ?? '',
    e.at, e.source, e.actor ?? null, e.note ?? null);
}

// Compare one complete pull with what is stored and write the differences. Runs inside a transaction:
// the cards and the change log move together or not at all.
export function applyPull(db, client, propMap, cards, now) {
  const baseline = !client.baseline_at;
  const existing = new Map(db.prepare('SELECT * FROM cards WHERE client_id = ?').all(client.id).map((c) => [c.id, c]));
  let events = 0;
  const ev = (card, e) => {
    insertEvent(db, card, client.id, { at: now, source: 'sync', ...e });
    events++;
  };

  const insert = db.prepare(
    `INSERT INTO cards (id, client_id, ${CARD_COLS.join(', ')}, first_seen_at, last_seen_at)
     VALUES (:id, :client_id, ${CARD_COLS.map((c) => `:${c}`).join(', ')}, :now, :now)`,
  );
  const update = db.prepare(
    `UPDATE cards SET ${CARD_COLS.map((c) => `${c} = :${c}`).join(', ')}, last_seen_at = :now, missing_since = NULL WHERE id = :id`,
  );
  const saveUser = db.prepare(
    `INSERT INTO notion_users (id, name, email, avatar_url) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, name), email = COALESCE(excluded.email, email), avatar_url = COALESCE(excluded.avatar_url, avatar_url)`,
  );

  for (const c of cards) {
    for (const p of c.people) saveUser.run(p.id, p.name, p.email, p.avatar_url);
    const old = existing.get(c.id);
    existing.delete(c.id);
    if (!old) {
      insert.run({ id: c.id, client_id: client.id, ...cardRow(c), now });
      if (!baseline) {
        ev(c, { field: 'created', to: c.status });
        continue;
      }
      // First ever pull of this board: record where each card stands, and estimate when posted
      // videos went out so the 7 and 30 day numbers are not empty on day one.
      ev(c, { field: 'status', to: c.status, source: 'baseline' });
      const when =
        c.posted_date && ['Posted', 'Archive'].includes(c.status) ? noon(c.posted_date)
        : c.status === 'Posted' ? c.last_edited_at
        : null;
      if (when) ev(c, { field: 'status', to: 'Posted', source: 'backfill', at: when, note: 'Estimated from Notion dates' });
      continue;
    }
    if (old.missing_since) ev(c, { field: 'restored', to: c.status });
    if (old.status !== c.status) ev(c, { field: 'status', from: old.status, to: c.status });
    if (old.approval_raw !== c.approval_raw) ev(c, { field: 'approval', from: old.approval_raw, to: c.approval_raw });
    if (old.editor_ids !== c.editor_ids) ev(c, { field: 'editor', from: old.editor_names || null, to: c.editor_names || null });
    update.run({ id: c.id, ...cardRow(c), now });
  }

  // Anything stored that the pull did not return was deleted or moved off the board.
  for (const old of existing.values()) {
    if (old.missing_since) continue;
    db.prepare('UPDATE cards SET missing_since = ? WHERE id = ?').run(now, old.id);
    ev(old, { field: 'removed', from: old.status });
  }

  db.prepare('UPDATE clients SET prop_map = ?, baseline_at = COALESCE(baseline_at, ?) WHERE id = ?').run(JSON.stringify(propMap), now, client.id);
  return { cards: cards.length, events };
}

export function syncClient(db, notion, client, now = nowIso()) {
  return locked(async () => {
    const schema = await notion.dataSource(client.notion_data_source_id);
    const propMap = resolvePropMap(schema.properties);
    if (!propMap.status) throw new Error('This board has no Status column');
    const pages = await notion.queryAll(client.notion_data_source_id);
    const cards = pages.filter((p) => !p.in_trash && !p.archived).map((p) => normalizePage(p, propMap));
    const fresh = db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
    return tx(db, () => applyPull(db, fresh, propMap, cards, now));
  });
}

export async function syncAll(db, notion) {
  const started = nowIso();
  const results = [];
  const clients = db.prepare('SELECT * FROM clients WHERE active = 1 AND notion_data_source_id IS NOT NULL ORDER BY id').all();
  for (const client of clients) {
    try {
      results.push({ client: client.slug, ok: true, ...(await syncClient(db, notion, client)) });
    } catch (err) {
      results.push({ client: client.slug, ok: false, error: err.message });
    }
  }
  const ok = results.every((r) => r.ok);
  const sum = (k) => results.reduce((n, r) => n + (r[k] || 0), 0);
  db.prepare('INSERT INTO sync_runs (started_at, finished_at, ok, cards, events, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(started, nowIso(), ok ? 1 : 0, sum('cards'), sum('events'), JSON.stringify(results));
  db.prepare('DELETE FROM sync_runs WHERE started_at < ?').run(new Date(Date.now() - 14 * 86_400_000).toISOString());
  return { ok, results };
}

// A change made in the portal: write it to Notion first, then record it locally with who did it.
// If Notion refuses, nothing is stored. The next pull sees no difference, so it is never logged twice.
export function applyCardChange(db, notion, { card, client, user, changes, note }) {
  return locked(async () => {
    const map = JSON.parse(client.prop_map || '{}');
    await notion.updatePage(card.id, buildProps(map, changes));
    const now = nowIso();
    return tx(db, () => {
      const cur = db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id);
      const set = {};
      const ev = (field, from, to) => insertEvent(db, cur, cur.client_id, { field, from, to, at: now, source: 'portal', actor: user?.id, note });
      if ('status' in changes && cur.status !== changes.status) {
        ev('status', cur.status, changes.status);
        set.status = changes.status;
      }
      if ('approval' in changes) {
        const raw = map.approval.labels[changes.approval];
        if (cur.approval_raw !== raw) {
          ev('approval', cur.approval_raw, raw);
          set.approval = changes.approval;
          set.approval_raw = raw;
        }
      }
      if ('posted_date' in changes) set.posted_date = changes.posted_date;
      if ('posted_link' in changes && map.posted_link) set.posted_link = changes.posted_link || null;
      const keys = Object.keys(set);
      if (keys.length) db.prepare(`UPDATE cards SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), card.id);
      return db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id);
    });
  });
}
