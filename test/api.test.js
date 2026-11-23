import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { syncClient } from '../src/sync.js';
import { hashPassword } from '../src/auth.js';
import { schema, page, fakeNotion, freshDb, client, events, KUNAL, SARA } from './helpers.js';

const CFG = { tz: 'Europe/London', prod: false, baseUrl: 'https://portal.test' };
const PW = 'correct horse battery';

async function setup() {
  const boards = {
    cino: {
      schema: schema({ who: 'Elena' }),
      pages: [
        page('c1', { title: 'Cino review', status: 'Ready', approval: 'Needs Elena Approval', editors: [KUNAL], files: [{ name: 'cut.mp4', type: 'file', file: { url: 'https://files.test/cut.mp4', expiry_time: 'soon' } }] }),
        page('c2', { title: 'Cino in edit', status: 'Editing', editors: [KUNAL] }),
        page('c3', { title: 'Cino banked', status: 'Ready', approval: 'Approved' }),
      ],
    },
    noah: {
      schema: schema({ who: 'Noah', statusType: 'select' }),
      pages: [page('n1', { title: 'Noah review', status: 'Ready', approval: 'Needs Noah Approval', editors: [SARA], statusType: 'select' })],
    },
  };
  const { notion, state } = fakeNotion(boards);
  const db = freshDb([{ slug: 'cino', name: 'Cino', ds: 'cino' }, { slug: 'noah', name: 'Noah', ds: 'noah' }]);
  await syncClient(db, notion, client(db, 'cino'));
  await syncClient(db, notion, client(db, 'noah'));
  const hash = await hashPassword(PW);
  const add = db.prepare('INSERT INTO users (email, name, role, password_hash, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  add.run('boss@odyssey.test', 'Boss', 'admin', hash, null, 'x');
  add.run('elena@cino.test', 'Elena', 'client', hash, client(db, 'cino').id, 'x');
  add.run('kunal@odyssey.test', 'Kunal', 'editor', hash, null, 'x');
  const app = await buildServer({ db, cfg: CFG, notion });
  const login = async (email) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-portal': '1' }, payload: { email, password: PW } });
    assert.equal(res.statusCode, 200, res.body);
    return { ody_session: res.cookies.find((c) => c.name === 'ody_session').value };
  };
  const as = (cookies) => ({
    get: (url) => app.inject({ method: 'GET', url, cookies }),
    post: (url, payload = {}) => app.inject({ method: 'POST', url, cookies, headers: { 'x-portal': '1' }, payload }),
    patch: (url, payload = {}) => app.inject({ method: 'PATCH', url, cookies, headers: { 'x-portal': '1' }, payload }),
  });
  return { app, db, boards, state, login, as };
}

test('sign-in: wrong password, missing session and cross-site posts are refused', async () => {
  const { app, login, as } = await setup();
  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-portal': '1' }, payload: { email: 'boss@odyssey.test', password: 'nope' } });
  assert.equal(bad.statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/overview' })).statusCode, 401);
  const cookies = await login('boss@odyssey.test');
  assert.equal((await as(cookies).get('/api/me')).json().user.role, 'admin');
  const crossSite = await app.inject({ method: 'POST', url: '/api/admin/sync', cookies, headers: { origin: 'https://evil.test', host: 'portal.test' } });
  assert.equal(crossSite.statusCode, 403);
  const noHeader = await app.inject({ method: 'POST', url: '/api/admin/sync', cookies });
  assert.equal(noHeader.statusCode, 403);
});

test('a client sees only their own videos and cannot reach admin, editor or another client', async () => {
  const { login, as } = await setup();
  const elena = as(await login('elena@cino.test'));
  const view = (await elena.get('/api/client/overview')).json();
  assert.equal(view.client.name, 'Cino');
  assert.deepEqual(view.needs_approval.map((c) => c.title), ['Cino review']);
  assert.deepEqual(view.ready.map((c) => c.title), ['Cino banked']);
  assert.equal(view.in_production, 1);
  assert.ok(!JSON.stringify(view).includes('Noah'));
  assert.ok(!JSON.stringify(view).includes('Kunal'));
  assert.equal((await elena.get('/api/client/overview?client=noah')).json().client.name, 'Cino'); // the query is ignored for clients
  assert.equal((await elena.get('/api/admin/overview')).statusCode, 403);
  assert.equal((await elena.get('/api/admin/clients/noah/board')).statusCode, 403);
  assert.equal((await elena.get('/api/editor/overview')).statusCode, 403);
  assert.equal((await elena.post('/api/cards/n1/approve')).statusCode, 404); // another client's video
  assert.equal((await elena.post('/api/cards/c2/approve')).statusCode, 404); // her client's, but still in editing
  assert.equal((await elena.get('/api/cards/n1/media')).statusCode, 404);
});

test('a client can approve, request changes and mark posted, and Notion gets each change', async () => {
  const { db, boards, state, login, as } = await setup();
  const elena = as(await login('elena@cino.test'));

  const media = (await elena.get('/api/cards/c1/media')).json();
  assert.equal(media.files[0].url, 'https://files.test/cut.mp4');

  const short = await elena.post('/api/cards/c1/request-changes', { note: '' });
  assert.equal(short.statusCode, 400);
  const changes = await elena.post('/api/cards/c1/request-changes', { note: 'Tighten the first three seconds' });
  assert.equal(changes.statusCode, 200, changes.body);
  const c1 = boards.cino.pages[0].properties;
  assert.deepEqual([c1.Status.status.name, c1.Approval.select.name], ['Revisions', 'Changes Requested']);
  assert.equal(db.prepare("SELECT note FROM feedback WHERE card_id = 'c1'").get().note, 'Tighten the first three seconds');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(state.comments.length, 1);
  assert.equal((await elena.post('/api/cards/c1/approve')).statusCode, 409); // no longer waiting on her

  assert.equal((await elena.post('/api/cards/c3/mark-posted', { url: 'javascript:alert(1)' })).statusCode, 400);
  const posted = await elena.post('/api/cards/c3/mark-posted', { url: 'https://instagram.com/p/abc', date: '2026-11-23' });
  assert.equal(posted.statusCode, 200, posted.body);
  const c3 = boards.cino.pages[2].properties;
  assert.deepEqual([c3.Status.status.name, c3['Posted Date'].date.start, c3['Posted Video Link'].url], ['Posted', '2026-11-23', 'https://instagram.com/p/abc']);
  assert.equal((await elena.post('/api/cards/c3/mark-posted')).statusCode, 409); // already posted

  const log = events(db, "source = 'portal'");
  assert.deepEqual(log.map((e) => [e.card_id, e.field, e.to_value]), [
    ['c1', 'status', 'Revisions'], ['c1', 'approval', 'Changes Requested'], ['c3', 'status', 'Posted'],
  ]);
  assert.equal(log[0].note, 'Tighten the first three seconds');
});

test('an editor is linked by email, sees only their queue and can only move their own cards forward', async () => {
  const { boards, login, as } = await setup();
  const kunal = as(await login('kunal@odyssey.test'));
  assert.equal((await kunal.get('/api/me')).json().user.linked_to_notion, true);
  const view = (await kunal.get('/api/editor/overview')).json();
  assert.deepEqual(view.queue.map((c) => [c.title, c.client]), [['Cino in edit', 'Cino']]);
  assert.equal((await kunal.post('/api/cards/n1/status', { status: 'Review' })).statusCode, 404); // Sara's card
  assert.equal((await kunal.post('/api/cards/c2/status', { status: 'Posted' })).statusCode, 409);
  assert.equal((await kunal.post('/api/cards/c2/status', { status: 'Review' })).statusCode, 200);
  assert.equal((await kunal.get('/api/editor/overview')).json().counts.done_today, 1);
  assert.equal((await kunal.post('/api/cards/c2/review', { decision: 'pass' })).statusCode, 403); // review is for the team leads

  // The team reviews it: send it back once with a note, then pass it on to the client.
  const boss = as(await login('boss@odyssey.test'));
  assert.deepEqual((await boss.get('/api/admin/overview')).json().needs_review.map((c) => c.title), ['Cino in edit']);
  assert.equal((await boss.post('/api/cards/c2/review', { decision: 'changes', note: 'Captions drift at 0:12' })).statusCode, 200);
  assert.deepEqual((await kunal.get('/api/editor/overview')).json().queue[0].feedback.map((f) => f.note), ['Captions drift at 0:12']);
  assert.equal((await boss.post('/api/cards/c2/review', { decision: 'pass' })).statusCode, 409); // back with the editor, not in review
  await kunal.post('/api/cards/c2/status', { status: 'Review' });
  assert.equal((await boss.post('/api/cards/c2/review', { decision: 'pass', needs_client: true })).statusCode, 200);
  const c2 = boards.cino.pages[1].properties;
  assert.deepEqual([c2.Status.status.name, c2.Approval.select.name], ['Ready', 'Needs Elena Approval']);
  const elena = as(await login('elena@cino.test'));
  assert.deepEqual((await elena.get('/api/client/overview')).json().needs_approval.map((c) => c.title).sort(), ['Cino in edit', 'Cino review']);
  assert.equal((await kunal.get('/api/admin/users')).statusCode, 403);
  assert.equal((await kunal.get('/api/client/overview')).statusCode, 403);
});

test('admin: overview, invites, client settings and read-only API keys', async () => {
  const { app, db, login, as } = await setup();
  const boss = as(await login('boss@odyssey.test'));
  const overview = (await boss.get('/api/admin/overview')).json();
  assert.deepEqual(overview.clients.map((c) => [c.name, c.needs_approval]), [['Cino', 1], ['Noah', 1]]);

  const board = (await boss.get('/api/admin/clients/cino/board')).json();
  assert.deepEqual(board.cards.map((c) => [c.title, c.status]).sort(), [['Cino banked', 'Ready'], ['Cino in edit', 'Editing'], ['Cino review', 'Ready']]);
  assert.equal(board.daily.length, 30);
  assert.equal(board.client.name, 'Cino');
  assert.equal((await boss.get('/api/admin/clients/nobody/board')).statusCode, 404);

  const made = (await boss.post('/api/admin/users', { email: 'noah@noah.test', name: 'Noah', role: 'client', client_id: client(db, 'noah').id })).json();
  assert.match(made.invite_url, /^https:\/\/portal\.test\/invite\//);
  const token = made.invite_url.split('/').pop();
  const weak = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { 'x-portal': '1' }, payload: { token, password: 'short' } });
  assert.equal(weak.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { 'x-portal': '1' }, payload: { token, password: 'a much longer password' } });
  assert.equal(ok.json().user.client.name, 'Noah');
  const reuse = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { 'x-portal': '1' }, payload: { token, password: 'a much longer password' } });
  assert.equal(reuse.statusCode, 400);

  const patch = await boss.patch(`/api/admin/clients/${client(db, 'cino').id}`, { package_size: 20, period_anchor: '2026-11-01' });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal(client(db, 'cino').package_size, 20);

  const { key } = (await boss.post('/api/admin/api-keys', { name: 'Grok' })).json();
  const summary = await app.inject({ method: 'GET', url: '/api/v1/summary', headers: { authorization: `Bearer ${key}` } });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().clients.length, 2);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/summary', headers: { authorization: 'Bearer ody_wrong' } })).statusCode, 401);
  // A key cannot be used on the admin or action endpoints.
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/users', headers: { authorization: `Bearer ${key}` } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/cards/c1/approve', headers: { authorization: `Bearer ${key}` }, payload: {} })).statusCode, 401);
});

test('a switched-off login stops working straight away', async () => {
  const { db, login, as } = await setup();
  const boss = as(await login('boss@odyssey.test'));
  const elena = as(await login('elena@cino.test'));
  assert.equal((await elena.get('/api/me')).statusCode, 200);
  const id = db.prepare("SELECT id FROM users WHERE email = 'elena@cino.test'").get().id;
  assert.equal((await boss.patch(`/api/admin/users/${id}`, { active: false })).statusCode, 200);
  assert.equal((await elena.get('/api/me')).statusCode, 401);
  assert.equal((await elena.get('/api/client/overview')).statusCode, 401);
});

test('an assistant can read the portal over MCP with a key, and only with a key', async () => {
  const { app, login } = await setup();
  const boss = await login('boss@odyssey.test');
  const made = await app.inject({ method: 'POST', url: '/api/admin/api-keys', cookies: boss, headers: { 'x-portal': '1' }, payload: { name: 'Grok' } });
  const { key } = made.json();
  const rpc = (url, body, headers = {}) => app.inject({ method: 'POST', url, headers, payload: body });
  assert.equal((await rpc('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode, 401);
  assert.equal((await rpc('/mcp/ody_wrong', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode, 401);
  const init = (await rpc('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, { authorization: `Bearer ${key}` })).json();
  assert.deepEqual([init.result.protocolVersion, init.result.serverInfo.name], ['2025-03-26', 'odyssey-portal']);
  assert.equal((await rpc(`/mcp/${key}`, { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode, 202);
  const tools = (await rpc(`/mcp/${key}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools.map((t) => t.name);
  assert.deepEqual(tools, ['portal_overview', 'client_report', 'client_uploads']);
  const call = async (name, args) => (await rpc(`/mcp/${key}`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).json().result.content[0].text;
  assert.match(await call('portal_overview', {}), /Clients:\n- Cino: .*in production/);
  assert.match(await call('client_report', { client: 'Cino' }), /^Cino: .*By stage: /s);
  assert.match(await call('client_uploads', { client: 'nobody' }), /No client by that name\. Clients: Cino, Noah/);
  assert.equal((await app.inject({ method: 'GET', url: '/mcp' })).statusCode, 405);
});
