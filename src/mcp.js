// A small read-only MCP server, so an assistant such as Grok can ask the portal what is going on.
// It can only read. Nothing here writes to the portal, Notion, Slack or anywhere else.
import { adminOverview, clientBoard } from './metrics.js';

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

export function createMcp({ db, cfg }) {
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

  // One JSON-RPC message in, one answer out (or nothing, for a notification).
  return function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    if (msg.id === undefined) return null;
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return ok({
          protocolVersion: VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'odyssey-portal', version: '1.0.0' },
          instructions: 'Read-only view of the Odyssey Digital agency portal. Call portal_overview first, then client_report or client_uploads for one client.',
        });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const tool = run[msg.params?.name];
        if (!tool) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } };
        try {
          return ok({ content: [{ type: 'text', text: tool(msg.params.arguments || {}) }] });
        } catch {
          return ok({ content: [{ type: 'text', text: 'The portal could not answer that just now.' }], isError: true });
        }
      }
      default: return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
    }
  };
}
