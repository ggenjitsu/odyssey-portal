import { openDb, nowIso } from '../src/db.js';
import { createNotion } from '../src/notion.js';
import { STATUSES } from '../src/rules.js';

const opts = (names) => ({ options: names.map((name) => ({ name })) });

// A board shaped like the real ones. statusType 'select' mimics Noah's board.
export function schema({ who = 'Elena', statusType = 'status', editorName = 'Person' } = {}) {
  return {
    'Content Name': { name: 'Content Name', type: 'title', title: {} },
    Status: { name: 'Status', type: statusType, [statusType]: opts(STATUSES) },
    Approval: { name: 'Approval', type: 'select', select: opts(['Not Needed', `Needs ${who} Approval`, 'Approved', 'Changes Requested']) },
    [editorName]: { name: editorName, type: 'people', people: {} },
    'Due Date': { name: 'Due Date', type: 'date', date: {} },
    'Posted Date': { name: 'Posted Date', type: 'date', date: {} },
    'Posted Video Link': { name: 'Posted Video Link', type: 'url', url: {} },
    'Edited version': { name: 'Edited version', type: 'files', files: {} },
  };
}

export const KUNAL = { object: 'user', id: 'u-kunal', name: 'Kunal', type: 'person', person: { email: 'kunal@odyssey.test' } };
export const SARA = { object: 'user', id: 'u-sara', name: 'Sara', type: 'person', person: { email: 'sara@odyssey.test' } };

export function page(id, { title = id, status = 'Idea', approval = null, editors = [], posted = null, due = null, files = [],
  edited = '2026-11-20T10:00:00.000Z', statusType = 'status', editorName = 'Person' } = {}) {
  return {
    object: 'page', id, url: `https://notion.test/${id}`, created_time: '2026-11-01T09:00:00.000Z', last_edited_time: edited, in_trash: false,
    properties: {
      'Content Name': { type: 'title', title: [{ plain_text: title }] },
      Status: { type: statusType, [statusType]: status ? { name: status } : null },
      Approval: { type: 'select', select: approval ? { name: approval } : null },
      [editorName]: { type: 'people', people: editors },
      'Due Date': { type: 'date', date: due ? { start: due } : null },
      'Posted Date': { type: 'date', date: posted ? { start: posted } : null },
      'Posted Video Link': { type: 'url', url: null },
      'Edited version': { type: 'files', files },
    },
  };
}

// Stands in for api.notion.com. Boards are { [dataSourceId]: { schema, pages } }.
export function fakeNotion(boards, { pageSize = 2 } = {}) {
  const state = { boards, calls: [], failQueryAfter: null, failWrites: false, comments: [] };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const findPage = (id) => Object.values(boards).flatMap((b) => b.pages).find((p) => p.id === id);
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname.replace('/v1', '');
    const body = init.body ? JSON.parse(init.body) : {};
    state.calls.push(`${init.method} ${path}`);
    const ds = /^\/data_sources\/([^/]+)(\/query)?$/.exec(path);
    if (ds) {
      const board = boards[ds[1]];
      if (!board) return json({ code: 'object_not_found', message: 'not found' }, 404);
      if (!ds[2]) return json({ object: 'data_source', id: ds[1], properties: board.schema });
      const start = body.start_cursor ? Number(body.start_cursor) : 0;
      if (state.failQueryAfter !== null && start >= state.failQueryAfter) return json({ code: 'validation_error', message: 'boom' }, 400);
      const results = board.pages.slice(start, start + pageSize);
      const more = start + pageSize < board.pages.length;
      return json({ results, has_more: more, next_cursor: more ? String(start + pageSize) : null });
    }
    const pg = /^\/pages\/([^/]+)$/.exec(path);
    if (pg) {
      const p = findPage(pg[1]);
      if (!p) return json({ code: 'object_not_found', message: 'not found' }, 404);
      if (init.method === 'PATCH') {
        if (state.failWrites) return json({ code: 'validation_error', message: 'nope' }, 400);
        for (const [name, value] of Object.entries(body.properties)) p.properties[name] = { ...p.properties[name], ...value };
      }
      return json(p);
    }
    if (path === '/comments') {
      state.comments.push(body);
      return json({ object: 'comment' });
    }
    return json({ code: 'not_implemented', message: path }, 400);
  };
  return { notion: createNotion({ token: 'secret_test', fetchImpl, retryMs: 1 }), state };
}

export function freshDb(clients) {
  const db = openDb(':memory:');
  const insert = db.prepare('INSERT INTO clients (slug, name, notion_data_source_id, created_at) VALUES (?, ?, ?, ?)');
  for (const c of clients) insert.run(c.slug, c.name, c.ds, nowIso());
  return db;
}

export const client = (db, slug) => db.prepare('SELECT * FROM clients WHERE slug = ?').get(slug);
export const events = (db, where = "source != 'baseline'") => db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY id`).all();
