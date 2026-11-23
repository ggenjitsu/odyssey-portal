import test from 'node:test';
import assert from 'node:assert/strict';
import { syncClient, applyCardChange } from '../src/sync.js';
import { deliveredCount, adminOverview, editorOverview, clientOverview } from '../src/metrics.js';
import { startOfDay, monthlyPeriod } from '../src/time.js';
import { schema, page, fakeNotion, freshDb, client, events, KUNAL, SARA } from './helpers.js';

const CFG = { tz: 'Europe/London' };
const T0 = '2026-11-23T09:00:00.000Z';
const T1 = '2026-11-23T09:05:00.000Z';
const T2 = '2026-11-23T09:10:00.000Z';

function setup() {
  const boards = {
    cino: {
      schema: schema({ who: 'Elena' }),
      pages: [
        page('c1', { title: 'Split bills', status: 'Editing', editors: [KUNAL] }),
        page('c2', { title: 'Old post', status: 'Posted', posted: '2026-11-18' }),
        page('c3', { title: 'Ancient post', status: 'Archive', posted: '2026-08-01' }),
        page('c4', { title: 'Banked', status: 'Ready', approval: 'Approved', edited: '2026-11-21T10:00:00.000Z' }),
        page('c5', { title: 'Idea', status: 'Idea' }),
      ],
    },
  };
  const { notion, state } = fakeNotion(boards);
  const db = freshDb([{ slug: 'cino', name: 'Cino', ds: 'cino' }]);
  return { db, notion, state, boards };
}

test('first pull records a baseline and estimates past deliveries without inventing activity', async () => {
  const { db, notion } = setup();
  const r = await syncClient(db, notion, client(db, 'cino'), T0);
  assert.equal(r.cards, 5);
  assert.equal(events(db, "source = 'baseline'").length, 5);
  const backfill = events(db, "source = 'backfill'");
  assert.deepEqual(backfill.map((e) => [e.card_id, e.to_value, e.at]), [
    ['c2', 'Posted', '2026-11-18T12:00:00.000Z'],
    ['c3', 'Posted', '2026-08-01T12:00:00.000Z'],
  ]);
  const c = client(db, 'cino');
  assert.ok(c.baseline_at);
  // Delivered means posted. In the last 30 days that is only c2: c4 is Ready (not out yet) and c3 is too old.
  assert.equal(deliveredCount(db, c.id, '2026-10-24T00:00:00.000Z'), 1);
  assert.equal(events(db, "source = 'sync'").length, 0);
});

test('a status change is logged once, with the editor who had the card', async () => {
  const { db, notion, boards } = setup();
  await syncClient(db, notion, client(db, 'cino'), T0);
  boards.cino.pages[0].properties.Status.status.name = 'Review';
  await syncClient(db, notion, client(db, 'cino'), T1);
  await syncClient(db, notion, client(db, 'cino'), T2); // nothing changed: must add nothing
  const log = events(db, "source = 'sync'");
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].card_id, log[0].from_value, log[0].to_value, log[0].editor_names, log[0].at], ['c1', 'Editing', 'Review', 'Kunal', T1]);
  assert.deepEqual(JSON.parse(log[0].editor_ids), ['u-kunal']);
});

test('a pull that fails part way changes nothing, and the next good pull catches up', async () => {
  const { db, notion, state, boards } = setup();
  await syncClient(db, notion, client(db, 'cino'), T0);
  const before = events(db, '1 = 1').length;
  boards.cino.pages[0].properties.Status.status.name = 'Review';
  boards.cino.pages[4].properties.Status.status.name = 'Scripting';
  state.failQueryAfter = 2; // first page of results succeeds, second fails
  await assert.rejects(syncClient(db, notion, client(db, 'cino'), T1));
  assert.equal(events(db, '1 = 1').length, before);
  assert.equal(db.prepare("SELECT status FROM cards WHERE id = 'c1'").get().status, 'Editing');
  state.failQueryAfter = null;
  await syncClient(db, notion, client(db, 'cino'), T2);
  assert.deepEqual(events(db, "source = 'sync'").map((e) => [e.card_id, e.to_value]), [['c1', 'Review'], ['c5', 'Scripting']]);
});

test('new, removed and restored cards are all logged', async () => {
  const { db, notion, boards } = setup();
  await syncClient(db, notion, client(db, 'cino'), T0);
  const gone = boards.cino.pages.pop();
  boards.cino.pages.push(page('c6', { title: 'Fresh', status: 'Scripting' }));
  await syncClient(db, notion, client(db, 'cino'), T1);
  boards.cino.pages.push(gone);
  await syncClient(db, notion, client(db, 'cino'), T2);
  assert.deepEqual(events(db, "source = 'sync'").map((e) => [e.card_id, e.field]), [['c6', 'created'], ['c5', 'removed'], ['c5', 'restored']]);
  assert.equal(db.prepare("SELECT missing_since FROM cards WHERE id = 'c5'").get().missing_since, null);
});

test('the change log refuses edits and deletes', async () => {
  const { db, notion } = setup();
  await syncClient(db, notion, client(db, 'cino'), T0);
  assert.throws(() => db.exec("UPDATE events SET to_value = 'x'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM events'), /append-only/);
});

test('boards that differ are read the same way: select Status, client-named approval, renamed Editor', async () => {
  const boards = {
    noah: {
      schema: schema({ who: 'Noah', statusType: 'select', editorName: 'Editor' }),
      pages: [page('n1', { status: 'Ready', approval: 'Needs Noah Approval', editors: [SARA], statusType: 'select', editorName: 'Editor' })],
    },
  };
  const { notion } = fakeNotion(boards);
  const db = freshDb([{ slug: 'noah', name: 'Noah', ds: 'noah' }]);
  await syncClient(db, notion, client(db, 'noah'), T0);
  const card = db.prepare("SELECT * FROM cards WHERE id = 'n1'").get();
  assert.deepEqual([card.status, card.approval, card.approval_raw, card.editor_names], ['Ready', 'needs_client', 'Needs Noah Approval', 'Sara']);
  const map = JSON.parse(client(db, 'noah').prop_map);
  assert.equal(map.status.type, 'select');
  assert.equal(map.approval.labels.needs_client, 'Needs Noah Approval');
});

test('a portal action writes to Notion in the board\'s own words and is never logged twice', async () => {
  const boards = {
    noah: {
      schema: schema({ who: 'Noah', statusType: 'select' }),
      pages: [page('n1', { status: 'Review', approval: 'Needs Noah Approval', editors: [SARA], statusType: 'select' })],
    },
  };
  const { notion, state } = fakeNotion(boards);
  const db = freshDb([{ slug: 'noah', name: 'Noah', ds: 'noah' }]);
  await syncClient(db, notion, client(db, 'noah'), T0);
  const card = db.prepare("SELECT * FROM cards WHERE id = 'n1'").get();
  await applyCardChange(db, notion, { card, client: client(db, 'noah'), user: { id: 7 }, changes: { approval: 'approved', status: 'Ready' } });
  const props = boards.noah.pages[0].properties;
  assert.equal(props.Status.select.name, 'Ready');
  assert.equal(props.Approval.select.name, 'Approved');
  await syncClient(db, notion, client(db, 'noah'), T1);
  const log = events(db);
  assert.deepEqual(log.map((e) => [e.field, e.to_value, e.source, e.actor_user_id]), [['status', 'Ready', 'portal', 7], ['approval', 'Approved', 'portal', 7]]);

  // If Notion refuses the write, nothing is stored locally.
  state.failWrites = true;
  await assert.rejects(applyCardChange(db, notion, { card, client: client(db, 'noah'), user: { id: 7 }, changes: { status: 'Posted' } }));
  assert.equal(db.prepare("SELECT status FROM cards WHERE id = 'n1'").get().status, 'Ready');
  assert.equal(events(db).length, 2);
});

test('overviews: review queue, delivery counts, editor output, package pace and what a client can see', async () => {
  const { db, notion, boards } = setup();
  await syncClient(db, notion, client(db, 'cino'), T0);
  db.prepare("UPDATE clients SET package_size = 60, package_max = 90, period_anchor = '2026-11-01' WHERE slug = 'cino'").run();
  boards.cino.pages[0].properties.Status.status.name = 'Review'; // Kunal hands c1 off for the team's review
  boards.cino.pages[0].properties.Approval.select = { name: 'Needs Elena Approval' };
  await syncClient(db, notion, client(db, 'cino'), T1);
  const now = Date.parse('2026-11-23T10:00:00.000Z');

  let admin = adminOverview(db, CFG, now);
  let cino = admin.clients[0];
  assert.deepEqual(admin.needs_review.map((c) => [c.title, c.editor_names, c.since]), [['Split bills', 'Kunal', T1]]);
  assert.deepEqual(admin.reviewers, ['Ahmed', 'Genji']);
  assert.deepEqual([cino.needs_review, cino.needs_approval, cino.ready, cino.delivered_30d], [1, 0, 1, 1]);
  assert.deepEqual([cino.package.size, cino.package.max, cino.package.delivered, cino.package.pace], [60, 90, 1, 'behind']);
  assert.equal(cino.package.period_start, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(admin.editors.map((e) => [e.name, e.done_today, e.queue]), [['Kunal', 1, 0]]);
  assert.equal(editorOverview(db, CFG, { notion_user_id: 'u-kunal' }, now).counts.done_today, 1);

  // While it is in the team's review the client sees nothing of it.
  let view = clientOverview(db, CFG, client(db, 'cino'), now);
  assert.deepEqual([view.needs_approval.length, view.in_production], [0, 1]);

  // The team passes it: now it is the client's turn.
  boards.cino.pages[0].properties.Status.status.name = 'Ready';
  await syncClient(db, notion, client(db, 'cino'), T2);
  view = clientOverview(db, CFG, client(db, 'cino'), now);
  assert.deepEqual(view.needs_approval.map((c) => c.title), ['Split bills']);
  assert.deepEqual(view.ready.map((c) => c.title), ['Banked']);
  assert.deepEqual(view.posted.map((c) => c.title), ['Old post', 'Ancient post']);
  assert.ok(!('editor_names' in view.needs_approval[0]) && !('priority' in view.needs_approval[0]));
  assert.equal(adminOverview(db, CFG, now).clients[0].delivered_30d, 1); // reaching Ready is not a delivery

  // One Cino video goes out on several accounts: the client default applies unless the card says otherwise.
  db.prepare("UPDATE clients SET count_multiplier = 3 WHERE slug = 'cino'").run();
  assert.equal(adminOverview(db, CFG, now).clients[0].delivered_30d, 3);
  db.prepare("UPDATE cards SET weight = 4 WHERE id = 'c2'").run();
  cino = adminOverview(db, CFG, now).clients[0];
  assert.deepEqual([cino.delivered_30d, cino.posted_30d, cino.package.delivered], [4, 1, 4]);
});

test('time helpers handle time zones and short months', () => {
  assert.equal(startOfDay('Europe/London', new Date('2026-07-10T15:00:00Z')).toISOString(), '2026-07-09T23:00:00.000Z'); // BST
  assert.equal(startOfDay('Asia/Karachi', new Date('2026-11-23T02:00:00Z')).toISOString(), '2026-11-22T19:00:00.000Z');
  const p = monthlyPeriod(31, new Date('2026-02-10T00:00:00Z'));
  assert.deepEqual([p.start.toISOString().slice(0, 10), p.end.toISOString().slice(0, 10)], ['2026-01-31', '2026-02-28']);
});
