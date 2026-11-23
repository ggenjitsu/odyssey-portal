// A small read-only MCP server, so an assistant such as Grok can ask the portal what is going on.
// It can only read. Nothing here writes to the portal, Notion, Slack or anywhere else.
import { adminOverview, clientBoard } from './metrics.js';
import { applyCardChange, syncPosts } from './sync.js';
import { resolvePostMap, buildPostProps, guessPost } from './notion.js';
import { STATUSES, needsReview } from './rules.js';
import { localDate } from './time.js';
import { nowIso } from './db.js';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CLIENT_ARG = { type: 'string', description: 'Client name or short name, for example "cino", "rayston", "raymond" or "noah"' };
const TOOLS = [
  {
    name: 'portal_overview',
    description: 'The Odyssey Digital agency portal at a glance: every client with views, videos posted, package progress, what needs review, what is ready to post and who is waiting. Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'client_report',
    description: "One client's numbers in detail: views, videos posted, package and invoice state, pipeline by stage, views per account and platform, top uploads and recent activity.",
    inputSchema: { type: 'object', properties: { client: CLIENT_ARG }, required: ['client'], additionalProperties: false },
  },
  {
    name: 'client_uploads',
    description: "A client's logged uploads with link, account, platform, date and views.",
    inputSchema: {
      type: 'object',
      properties: { client: CLIENT_ARG, sort: { type: 'string', enum: ['newest', 'most_viewed'], description: 'Order of the list, newest first by default' }, limit: { type: 'number', description: 'How many to return, 25 by default, 100 at most' } },
      required: ['client'], additionalProperties: false,
    },
  },
];

const VIDEO_ARG = { type: 'string', description: 'The video id, from list_videos' };
const NOTE_ARG = { type: 'string', description: 'What should change, in plain words. Needed when sending back or requesting changes' };
TOOLS.push({
  name: 'list_videos',
  description: "A client's videos with their ids, stage, approval, editor and due date. Use it to find the id that a change needs.",
  inputSchema: { type: 'object', properties: { client: CLIENT_ARG, stage: { type: 'string', description: 'Only this stage, for example "Review" or "Ready"' } }, required: ['client'], additionalProperties: false },
});
for (const t of TOOLS) t.annotations = { readOnlyHint: true };

// These change real things (Notion cards, the posted-links lists, client settings). Only a full-access key gets them.
const WRITE_TOOLS = [
  {
    name: 'review_video',
    description: 'Internal review of a video that is in Review: pass it on (to Ready, and to the client for approval where their board uses approvals), or send it back to the editor with a note. Changes the Notion card.',
    inputSchema: { type: 'object', properties: { video_id: VIDEO_ARG, decision: { type: 'string', enum: ['pass', 'send_back'] }, note: NOTE_ARG }, required: ['video_id', 'decision'], additionalProperties: false },
  },
  {
    name: 'client_decision',
    description: "Record the client's decision on a video: approve it, or request changes with a note (which moves it to Revisions). Changes the Notion card.",
    inputSchema: { type: 'object', properties: { video_id: VIDEO_ARG, decision: { type: 'string', enum: ['approve', 'request_changes'] }, note: NOTE_ARG }, required: ['video_id', 'decision'], additionalProperties: false },
  },
  {
    name: 'set_video_stage',
    description: 'Move a video to another stage on its Notion board.',
    inputSchema: { type: 'object', properties: { video_id: VIDEO_ARG, stage: { type: 'string', enum: STATUSES } }, required: ['video_id', 'stage'], additionalProperties: false },
  },
  {
    name: 'mark_video_posted',
    description: 'Mark a video as posted, with the day it went out and its link. Changes the Notion card.',
    inputSchema: { type: 'object', properties: { video_id: VIDEO_ARG, date: { type: 'string', description: 'YYYY-MM-DD, today if left out' }, link: { type: 'string', description: 'Link to the post' } }, required: ['video_id'], additionalProperties: false },
  },
  {
    name: 'update_client',
    description: "Change a client's package size, how many uploads one video counts as, or the date of the last invoice (the package count restarts from that day; use \"today\" when an invoice goes out).",
    inputSchema: {
      type: 'object',
      properties: { client: CLIENT_ARG, package_from: { type: 'number' }, package_to: { type: 'number' }, counts_as: { type: 'number' }, last_invoice_date: { type: 'string', description: 'YYYY-MM-DD, "today", or "clear"' } },
      required: ['client'], additionalProperties: false,
    },
  },
  {
    name: 'log_uploads',
    description: "Add uploads to a client's Posted links list in Notion, or update the views of ones already logged (matched by link). The portal counts views and videos posted from this list.",
    inputSchema: {
      type: 'object',
      properties: {
        client: CLIENT_ARG,
        uploads: {
          type: 'array', maxItems: 50,
          items: {
            type: 'object',
            properties: { link: { type: 'string' }, date: { type: 'string', description: 'Day it was posted, YYYY-MM-DD' }, views: { type: 'number' }, platform: { type: 'string' }, account: { type: 'string' }, title: { type: 'string' }, uploads: { type: 'number', description: 'Only for a row that stands for several uploads' } },
            required: ['link'], additionalProperties: false,
          },
        },
      },
      required: ['client', 'uploads'], additionalProperties: false,
    },
  },
  { name: 'sync_now', description: 'Pull the latest from Notion into the portal right now.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
for (const t of WRITE_TOOLS) t.annotations = { readOnlyHint: false };

const num = (n) => Number(n || 0).toLocaleString('en-GB');
const day = (d) => (d ? String(d).slice(0, 10) : 'no date');

function packageLine(c) {
  const p = c.package;
  const since = p.period_source === 'invoice' ? `since the invoice on ${day(p.period_start)}` : p.period_source === 'stripe' ? 'this billing period' : 'this calendar month';
  if (!p.size) return `${p.delivered} posted ${since}, no package set`;
  const range = p.max && p.max !== p.size ? `${p.size} to ${p.max}` : `${p.size}`;
  return `${p.delivered} of ${range} posted ${since}${p.delivered >= p.size ? ' (package done, invoice due)' : `, ${p.remaining} to go`}${p.days_left != null ? `, ${p.days_left} days left` : ''}`;
}

function clientLine(c) {
  const views = c.posts ? `${num(c.posts.views)} views on ${num(c.posts.total)} logged uploads; ` : '';
  if (c.kind === 'creators') {
    const k = c.creators;
    return `- ${c.name} (creator campaign): ${views}${k.total} creators on the tracker, ${k.posting} posting, ${k.ready} ready to post, ${k.chase_now} to chase now, ${k.nudge} to nudge; ${packageLine(c)}`;
  }
  const slack = !c.slack ? 'Slack not linked' : c.slack.waiting ? `client waiting on Slack since ${c.slack.waiting_since}` : 'Slack answered';
  return `- ${c.name}: ${views}${packageLine(c)}; ${c.in_production} in production, ${c.needs_review} need internal review, ${c.needs_approval} with the client, ${c.ready} ready to post, ${c.overdue} overdue; posted last 7 days ${c.delivered_7d}, last 30 days ${c.delivered_30d}; ${slack}`;
}

export function createMcp({ db, cfg, notion, jobs }) {
  const find = (q) => {
    const want = String(q || '').trim().toLowerCase();
    const all = db.prepare('SELECT * FROM clients WHERE active = 1 ORDER BY sort_order, name').all();
    return all.find((c) => c.slug === want || c.name.toLowerCase() === want)
      || all.find((c) => want && (c.slug.startsWith(want) || c.name.toLowerCase().includes(want) || want.includes(c.slug.split('-')[0])));
  };
  const unknown = () => `No client by that name. Clients: ${db.prepare('SELECT name FROM clients WHERE active = 1 ORDER BY sort_order, name').all().map((c) => c.name).join(', ')}`;

  const run = {
    portal_overview() {
      const o = adminOverview(db, cfg);
      const t = o.totals;
      return [
        `Odyssey Portal, read at ${o.generated_at} (dates in ${o.timezone}). Last sync from Notion: ${o.last_sync?.finished_at || 'never'}${o.last_sync && !o.last_sync.ok ? ' (had a problem)' : ''}.`,
        `Across all clients: ${t.needs_review} need internal review, ${t.needs_approval} with clients for approval, ${t.ready} ready to post, ${t.overdue} overdue, ${t.delivered_7d} posted in the last 7 days, ${t.delivered_30d} in the last 30.`,
        'Clients:', ...o.clients.map(clientLine),
        o.needs_review.length ? 'Waiting for internal review:' : 'Nothing is waiting for internal review.',
        ...o.needs_review.slice(0, 20).map((c) => `- ${c.title} (${c.client_name}${c.editor_names ? `, editor ${c.editor_names}` : ''})`),
        'Editors, finished in the last 7 days:', ...o.editors.map((e) => `- ${e.name}: ${e.done_7d} finished, ${e.queue} in queue`),
      ].join('\n');
    },
    client_report({ client }) {
      const row = find(client);
      if (!row) return unknown();
      const b = clientBoard(db, cfg, row);
      const c = b.client;
      const stages = Object.entries(c.by_status || {}).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`).join(', ');
      const groups = new Map();
      for (const p of b.posts) {
        const key = `${p.account || 'Unknown'} on ${p.platform || 'unknown platform'}`;
        const g = groups.get(key) || { uploads: 0, views: 0 };
        g.uploads += p.uploads || 1;
        g.views += p.views || 0;
        groups.set(key, g);
      }
      const top = [...b.posts].sort((a, z) => (z.views || 0) - (a.views || 0)).slice(0, 5);
      return [
        clientLine(c).slice(2),
        `By stage: ${stages || 'nothing on the board'}.`,
        ...(groups.size ? ['Views by account:', ...[...groups].sort((a, z) => z[1].views - a[1].views).map(([k, g]) => `- ${k}: ${num(g.views)} views on ${g.uploads} uploads`)] : ['No uploads are logged for this client yet.']),
        ...(top.length ? ['Most viewed:', ...top.map((p) => `- ${num(p.views)} views, ${p.platform || ''} ${p.account || ''}, ${day(p.posted_on)}: ${p.url}`)] : []),
        'Recent activity:', ...b.events.slice(0, 12).map((e) => `- ${e.at.slice(0, 16)} ${e.card_title}: ${e.field} ${e.from_value || ''} -> ${e.to_value || ''}`),
      ].join('\n');
    },
    client_uploads({ client, sort, limit }) {
      const row = find(client);
      if (!row) return unknown();
      const n = Math.min(100, Math.max(1, Math.round(Number(limit) || 25)));
      const rows = db.prepare(
        `SELECT url, title, platform, account, posted_on, views, uploads FROM posts WHERE client_id = ? ORDER BY ${sort === 'most_viewed' ? 'views DESC' : 'posted_on DESC, views DESC'} LIMIT ?`,
      ).all(row.id, n);
      if (!rows.length) return `No uploads are logged for ${row.name} yet.`;
      return [`${row.name}, ${rows.length} uploads (${sort === 'most_viewed' ? 'most viewed' : 'newest'} first):`,
        ...rows.map((p) => `- ${day(p.posted_on)} | ${p.platform || ''} | ${p.account || ''}${p.uploads > 1 ? ` (${p.uploads} uploads on this account)` : ''} | ${num(p.views)} views | ${p.url}`)].join('\n');
    },
  };

  const isUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || ''));
  const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const card = (id) => db.prepare('SELECT * FROM cards WHERE id = ? AND missing_since IS NULL').get(String(id || ''));
  const noCard = 'No video with that id. Use list_videos to find it.';
  const badNote = (note) => String(note || '').trim().length < 3 || String(note).length > 2000;
  // Every change goes to Notion first and is logged with who asked for it.
  async function change(c, changes, note, who) {
    if (!notion) return 'Notion is not connected, so nothing was changed.';
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(c.client_id);
    if (client.kind === 'creators') return 'This is a creator campaign. Its tracker is changed in Notion, not from here.';
    const updated = await applyCardChange(db, notion, { card: c, client, user: null, changes, note: [note, `via ${who}`].filter(Boolean).join(' · ') });
    return `Done. "${updated.title}" is now in ${updated.status}${updated.approval_raw ? `, approval: ${updated.approval_raw}` : ''}.`;
  }
  function feedback(c, note, who, lead) {
    db.prepare('INSERT INTO feedback (card_id, client_id, user_id, author, note, created_at) VALUES (?, ?, NULL, ?, ?, ?)').run(c.id, c.client_id, who, note, nowIso());
    notion.comment(c.id, `${lead} ${who}: ${note}`).catch(() => {});
  }

  Object.assign(run, {
    list_videos({ client, stage }) {
      const row = find(client);
      if (!row) return unknown();
      const want = String(stage || '').trim().toLowerCase();
      const rows = db.prepare("SELECT id, title, status, approval_raw, editor_names, due_date FROM cards WHERE client_id = ? AND missing_since IS NULL AND status IS NOT 'Archive' ORDER BY status, title").all(row.id)
        .filter((c) => !want || String(c.status || '').toLowerCase() === want).slice(0, 200);
      if (!rows.length) return `No videos${want ? ` in ${stage}` : ''} for ${row.name}.`;
      return [`${row.name}, ${rows.length} videos:`, ...rows.map((c) => `- ${c.id} | ${c.status || 'no stage'} | ${c.title}${c.approval_raw ? ` | approval: ${c.approval_raw}` : ''}${c.editor_names ? ` | editor ${c.editor_names}` : ''}${c.due_date ? ` | due ${day(c.due_date)}` : ''}`)].join('\n');
    },
  });
  const write = {
    async review_video({ video_id, decision, note }, who) {
      const c = card(video_id);
      if (!c) return noCard;
      if (!needsReview(c)) return `"${c.title}" is in ${c.status}, not in Review, so there is nothing to review.`;
      if (decision === 'pass') {
        const labels = JSON.parse(db.prepare('SELECT prop_map FROM clients WHERE id = ?').get(c.client_id).prop_map || '{}').approval?.labels || {};
        const askClient = labels.needs_client && ['needs_client', 'changes_requested'].includes(c.approval);
        return change(c, { status: 'Ready', ...(askClient ? { approval: 'needs_client' } : {}) }, null, who);
      }
      if (badNote(note)) return 'Say what should change, in a note of up to 2,000 characters. Nothing was changed.';
      const out = await change(c, { status: 'Revisions' }, note, who);
      if (out.startsWith('Done')) feedback(c, note, who, 'Sent back by');
      return out;
    },
    async client_decision({ video_id, decision, note }, who) {
      const c = card(video_id);
      if (!c) return noCard;
      if (decision === 'approve') return change(c, { approval: 'approved' }, null, who);
      if (badNote(note)) return 'Say what should change, in a note of up to 2,000 characters. Nothing was changed.';
      const out = await change(c, { approval: 'changes_requested', status: 'Revisions' }, note, who);
      if (out.startsWith('Done')) feedback(c, note, who, 'Changes requested by');
      return out;
    },
    async set_video_stage({ video_id, stage }, who) {
      const c = card(video_id);
      if (!c) return noCard;
      if (!STATUSES.includes(stage)) return `Unknown stage. Stages: ${STATUSES.join(', ')}.`;
      return change(c, { status: stage }, null, who);
    },
    async mark_video_posted({ video_id, date, link }, who) {
      const c = card(video_id);
      if (!c) return noCard;
      const on = date || localDate(cfg.tz);
      if (!isDay(on)) return 'Use a date like 2026-11-23. Nothing was changed.';
      if (link && !isUrl(link)) return 'That link does not look right. Nothing was changed.';
      return change(c, { status: 'Posted', posted_date: on, ...(link ? { posted_link: link } : {}) }, null, who);
    },
    async update_client(args) {
      const row = find(args.client);
      if (!row) return unknown();
      const set = {};
      const whole = (v) => Math.max(0, Math.floor(Number(v)));
      if (args.package_from != null) set.package_size = whole(args.package_from);
      if (args.package_to != null) set.package_max = whole(args.package_to);
      if (args.counts_as != null) set.count_multiplier = Number(args.counts_as);
      if (args.last_invoice_date != null) set.last_invoiced_at = args.last_invoice_date === 'today' ? localDate(cfg.tz) : args.last_invoice_date === 'clear' ? null : args.last_invoice_date;
      if (Object.values(set).some((v) => Number.isNaN(v))) return 'Those numbers do not look right. Nothing was changed.';
      if ('count_multiplier' in set && !(set.count_multiplier > 0 && set.count_multiplier <= 20)) return 'Counts-as must be between 0 and 20. Nothing was changed.';
      if (set.last_invoiced_at && !isDay(set.last_invoiced_at)) return 'Use a date like 2026-11-23, "today" or "clear". Nothing was changed.';
      const keys = Object.keys(set);
      if (!keys.length) return 'Nothing to change was given.';
      db.prepare(`UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), row.id);
      const now = adminOverview(db, cfg).clients.find((c) => c.slug === row.slug);
      return `Done. ${row.name}: ${packageLine(now)}.`;
    },
    async log_uploads({ client, uploads }) {
      const row = find(client);
      if (!row) return unknown();
      if (!notion) return 'Notion is not connected, so nothing was logged.';
      if (!row.posts_data_source_id) return `${row.name} has no Posted links list in Notion yet, so there is nowhere to log uploads. It needs creating first.`;
      const list = Array.isArray(uploads) ? uploads.slice(0, 50) : [];
      const bad = list.find((u) => !isUrl(u.link) || (u.date && !isDay(u.date)));
      if (!list.length || bad) return 'Each upload needs a full link, and dates like 2026-11-23. Nothing was logged.';
      const map = resolvePostMap((await notion.dataSource(row.posts_data_source_id)).properties);
      const today = localDate(cfg.tz);
      let added = 0;
      let updated = 0;
      for (const u of list) {
        const known = db.prepare("SELECT notion_page_id FROM posts WHERE client_id = ? AND RTRIM(url, '/') = RTRIM(?, '/')").get(row.id, u.link);
        const guess = guessPost(u.link);
        if (known) {
          await notion.updatePage(known.notion_page_id, buildPostProps(map, { date: u.date, views: u.views, uploads: u.uploads, platform: u.platform, account: u.account, title: u.title }, today));
          updated += 1;
        } else {
          await notion.createPage(row.posts_data_source_id, buildPostProps(map, {
            title: u.title || `${u.platform || guess.platform || 'Upload'}, ${u.date || today}`, url: u.link, date: u.date || today, views: u.views,
            uploads: u.uploads, platform: u.platform || guess.platform, account: u.account || guess.account,
          }, today));
          added += 1;
        }
      }
      await syncPosts(db, notion, row);
      const now = adminOverview(db, cfg).clients.find((c) => c.slug === row.slug);
      return `Done. ${added} added, ${updated} updated. ${row.name} now has ${num(now.posts?.views)} views on ${num(now.posts?.total)} logged uploads.`;
    },
    async sync_now() {
      if (!jobs) return 'Sync is not running in this process.';
      const r = await jobs.sync();
      return r?.ok === false ? 'The sync ran but at least one board had a problem.' : 'Synced with Notion.';
    },
  };

  // One JSON-RPC message in, one answer out (or nothing, for a notification).
  return async function handle(msg, key = { name: 'assistant', scope: 'read' }) {
    const full = key.scope === 'full';
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    if (msg.id === undefined) return null;
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return ok({
          protocolVersion: VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'odyssey-portal', version: '1.0.0' },
          instructions: `The Odyssey Digital agency portal. Call portal_overview first, then client_report, client_uploads or list_videos for one client.${full ? ' This key can also make changes: they go straight to the real Notion boards, so confirm with the person before changing anything they did not ask for.' : ' This key is read-only.'}`,
        });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: full ? [...TOOLS, ...WRITE_TOOLS] : TOOLS });
      case 'tools/call': {
        const name = msg.params?.name;
        const tool = run[name] || write[name];
        if (!tool) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } };
        if (write[name] && !full) return ok({ content: [{ type: 'text', text: 'This key can only read. Nothing was changed.' }], isError: true });
        try {
          return ok({ content: [{ type: 'text', text: await tool(msg.params.arguments || {}, key.name) }] });
        } catch {
          return ok({ content: [{ type: 'text', text: write[name] ? 'That could not be saved to Notion, so nothing was changed. Try again in a moment.' : 'The portal could not answer that just now.' }], isError: true });
        }
      }
      default: return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
    }
  };
}
