// Local preview only: fills a throwaway database with made-up boards and starts the portal on it.
//   node scripts/dev-seed.js        then open http://localhost:3222 (admin@local.test / local-preview-1)
// It never touches Notion or the live portal.
import { openDb, nowIso } from '../src/db.js';
import { syncClient, syncPosts } from '../src/sync.js';
import { hashPassword } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { schema, page, fakeNotion, KUNAL, SARA } from '../test/helpers.js';

const HAMZA = { object: 'user', id: 'u-hamza', name: 'Hamza', type: 'person', person: { email: 'hamza@local.test' } };
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const day = (daysAgo) => iso(daysAgo * 1440).slice(0, 10);
let n = 0;
const card = (prefix, title, o) => page(`${prefix}${++n}`, { title, ...o });

const cino = [
  ...['How we split rent on two salaries', 'The 70/30 groceries argument', 'Date night on forty pounds', 'Who pays when one of you earns double', 'Our joint account rules']
    .map((t, i) => card('c', t, { status: 'Posted', posted: day(i * 2 + 1), editors: [KUNAL] })),
  ...['Holiday fund, three ways', 'Splitting bills after a pay rise', 'The spreadsheet that ended the fights']
    .map((t) => card('c', t, { status: 'Ready', approval: 'Approved', editors: [SARA] })),
  card('c', 'Moving in together: the money talk', { status: 'Ready', approval: 'Needs Elena Approval', editors: [KUNAL] }),
  card('c', 'Should the higher earner pay more', { status: 'Editing', editors: [KUNAL], due: day(-2) }),
  card('c', 'Rent split when one works from home', { status: 'Editing', editors: [SARA], due: day(2) }),
  card('c', 'We tried 50/50 for a month', { status: 'Revisions', approval: 'Changes Requested', editors: [HAMZA] }),
  ...Array.from({ length: 9 }, (_, i) => card('c', `Couple split, take ${i + 1}`, { status: 'Ready to Edit', editors: i % 2 ? [HAMZA] : [] })),
  ...['Wedding costs, split fairly', 'Pets and who pays', 'Subscriptions audit'].map((t) => card('c', t, { status: 'Scripting' })),
  card('c', 'Bills on one income', { status: 'Idea' }),
];
const raymond = [
  ...['Three mistakes on a first rental', 'What the deposit really covers', 'Reading a floor plan in a minute'].map((t, i) => card('r', t, { status: 'Posted', posted: day(i * 3 + 2), editors: [SARA] })),
  card('r', 'Viewing checklist, the short one', { status: 'Ready', approval: 'Needs Raymond Approval', editors: [SARA] }),
  card('r', 'Leasehold in plain words', { status: 'Editing', editors: [SARA] }),
  ...Array.from({ length: 5 }, (_, i) => card('r', `Market update, week ${i + 44}`, { status: 'Ready to Edit' })),
  card('r', 'Mortgage in principle, explained', { status: 'Filming' }),
];
const noah = [
  card('n', 'Why hooks die at two seconds', { status: 'Editing', editors: [HAMZA], statusType: 'select' }),
  card('n', 'One message per video', { status: 'Ready to Edit', statusType: 'select' }),
  card('n', 'The edit that doubled watch time', { status: 'Scripting', statusType: 'select' }),
];

const opts = (names) => ({ options: names.map((name) => ({ name })) });
const text = (s) => ({ type: 'rich_text', rich_text: s ? [{ plain_text: s }] : [] });
const creator = (id, name, stage, chase, posted, next, owner = 'Genji', last = 2) => ({
  object: 'page', id, url: `https://notion.test/${id}`, created_time: iso(30 * 1440), last_edited_time: iso(60), in_trash: false,
  properties: {
    Creator: { type: 'title', title: [{ plain_text: name }] },
    Stage: { type: 'select', select: { name: stage } },
    Chase: { type: 'select', select: chase ? { name: chase } : null },
    'Videos posted': { type: 'number', number: posted },
    Owner: text(owner), 'Next action': text(next), Blockers: text(''),
    'Last activity': { type: 'date', date: { start: day(last) } },
  },
});
const rayston = [
  creator('y1', 'Maya Okafor', 'Posting', 'On track', 14, 'Send brief 4'),
  creator('y2', 'Tom Reyes', 'Posting', 'On track', 9, ''),
  creator('y3', 'Ines Duarte', 'Posting', 'Nudge', 6, 'Two days quiet, ask for the next upload', 'Ahmed', 4),
  creator('y4', 'Callum Hart', 'Ready to post', 'On track', 0, 'First video goes out Monday'),
  creator('y5', 'Priya Nair', 'Ready to post', 'Chase now', 0, 'Tracking link issued, no post yet', 'Ahmed', 6),
  creator('y6', 'Jonah Weiss', 'Warm-up', 'On track', 0, 'Day 3 of warm-up'),
  creator('y7', 'Sofia Lindqvist', 'Warm-up', 'Nudge', 0, 'Remind about daily scrolling', 'Genji', 3),
  creator('y8', 'Dev Malhotra', 'Onboarding', 'On track', 0, 'Waiting on SideShift connection'),
  creator('y9', 'Ella Brandt', 'Onboarding', 'Chase now', 0, 'Has not joined the WhatsApp community', 'Genji', 8),
  creator('y10', 'Marcus Lee', 'Joined – no activity', 'Chase now', 0, 'No reply since joining', 'Ahmed', 11),
  creator('y11', 'Hana Sato', 'Paused/Silent', 'Chase now', 3, 'Went quiet after video 3', 'Ahmed', 9),
];
const raystonSchema = {
  Creator: { name: 'Creator', type: 'title', title: {} },
  Stage: { name: 'Stage', type: 'select', select: opts(['Joined – no activity', 'Onboarding', 'Warm-up', 'Ready to post', 'Posting', 'Paused/Silent', 'Not in community']) },
  Chase: { name: 'Chase', type: 'select', select: opts(['Chase now', 'Nudge', 'On track']) },
  'Videos posted': { name: 'Videos posted', type: 'number', number: {} },
  Owner: { name: 'Owner', type: 'rich_text', rich_text: {} },
  'Next action': { name: 'Next action', type: 'rich_text', rich_text: {} },
  Blockers: { name: 'Blockers', type: 'rich_text', rich_text: {} },
  'Last activity': { name: 'Last activity', type: 'date', date: {} },
};
const bump = (id, by) => { rayston.find((p) => p.id === id).properties['Videos posted'].number += by; };

const postRow = (id, platform, account, d, views, link, title) => ({
  object: 'page', id, url: `https://notion.test/${id}`, created_time: iso(600), last_edited_time: iso(60), in_trash: false,
  properties: {
    Post: { type: 'title', title: [{ plain_text: title }] }, Link: { type: 'url', url: link },
    'Posted Date': { type: 'date', date: { start: day(d) } }, Platform: { type: 'select', select: { name: platform } },
    Account: { type: 'select', select: { name: account } }, Views: { type: 'number', number: views }, 'Views checked': { type: 'date', date: { start: day(0) } },
  },
});
const cinoPosts = [1, 1, 2, 3, 3, 4, 5].flatMap((d, i) => [
  postRow(`pi${i}`, 'Instagram', '@elena', d, [125, 1538, 3238, 1455, 136, 145, 155][i], `https://www.instagram.com/elena/reel/x${i}/`, `Reel ${i}`),
  postRow(`py${i}`, 'YouTube', '@elena', d, [3159, 8812, 1159, 20457, 1359, 1205, 25][i], `https://www.youtube.com/shorts/y${i}`, ['Should I go anyway?', 'Is this valid?', 'Is this okay?', 'Should they split?', 'What should I do?', 'Should women split the bill?', 'What would you do?'][i]),
  postRow(`pt${i}`, 'TikTok', i % 3 ? '@elena' : '@splitwithcino', d, 640 + i * 11, `https://www.tiktok.com/@elena/video/77${i}`, `TikTok ${i}`),
]);
const boards = {
  'cino-posts': { schema: { Post: { type: 'title' }, Link: { type: 'url' }, 'Posted Date': { type: 'date' }, Platform: { type: 'select' }, Account: { type: 'select' }, Views: { type: 'number' }, 'Views checked': { type: 'date' } }, pages: cinoPosts },
  rayston: { schema: raystonSchema, pages: rayston },
  cino: { schema: schema({ who: 'Elena' }), pages: cino },
  raymond: { schema: schema({ who: 'Raymond' }), pages: raymond },
  noah: { schema: schema({ who: 'Noah', statusType: 'select' }), pages: noah },
};
const { notion } = fakeNotion(boards, { pageSize: 100 });
const db = openDb(':memory:');
const add = db.prepare('INSERT INTO clients (slug, name, notion_data_source_id, package_size, package_max, count_multiplier, period_anchor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
add.run('cino', 'Cino', 'cino', 60, 90, 3, null, nowIso());
add.run('noah-eubanks', 'Noah Eubanks', 'noah', 30, 30, 1, null, nowIso());
add.run('raymond-ng', 'Raymond Ng', 'raymond', 30, 45, 1, null, nowIso());
add.run('rayston', 'Rayston', 'rayston', null, null, 1, null, nowIso());
db.prepare("UPDATE clients SET kind = 'creators' WHERE slug = 'rayston'").run();
['rayston', 'cino', 'raymond-ng', 'noah-eubanks'].forEach((s, i) => db.prepare('UPDATE clients SET sort_order = ? WHERE slug = ?').run(i + 1, s));
db.prepare("UPDATE clients SET last_invoiced_at = ? WHERE slug = 'raymond-ng'").run(day(9));
const clients = () => db.prepare('SELECT * FROM clients ORDER BY sort_order').all();
const move = (list, title, status, approval) => {
  const p = list.find((x) => x.properties['Content Name'].title[0].plain_text === title).properties;
  const s = p.Status;
  s[s.type] = { name: status };
  if (approval) p.Approval.select = { name: approval };
};

// Day one, then a few days of the team working.
for (const c of clients()) await syncClient(db, notion, c, iso(6 * 1440));
move(cino, 'Should the higher earner pay more', 'Review', 'Needs Elena Approval');
for (const c of clients()) await syncClient(db, notion, c, iso(54 * 60));
move(raymond, 'Leasehold in plain words', 'Review');
bump('y1', 2);
bump('y2', 1);
move(cino, 'Couple split, take 1', 'Editing');
for (const c of clients()) await syncClient(db, notion, c, iso(190));
move(cino, 'Rent split when one works from home', 'Review');
move(noah, 'Why hooks die at two seconds', 'Review');
move(cino, 'Holiday fund, three ways', 'Posted');
bump('y1', 1);
bump('y3', 2);
for (const c of clients()) await syncClient(db, notion, c, iso(35));
db.prepare("UPDATE clients SET posts_data_source_id = 'cino-posts' WHERE slug = 'cino'").run();
await syncPosts(db, notion, clients().find((c) => c.slug === 'cino'));
db.prepare('INSERT INTO sync_runs (started_at, finished_at, ok, cards, events, detail) VALUES (?, ?, 1, ?, 0, ?)')
  .run(iso(2), iso(2), cino.length + raymond.length + noah.length, JSON.stringify(clients().map((c) => ({ client: c.slug, ok: true }))));
const slack = db.prepare('INSERT INTO slack_status (client_id, channel_id, waiting, waiting_since, last_from, last_text, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
slack.run(1, 'C1', 1, iso(26 * 60 + 14), 'Elena', 'Can we get the rent one out before Friday?', iso(2));
slack.run(3, 'C3', 0, null, null, null, iso(2));
const pw = await hashPassword('local-preview-1');
const person = db.prepare('INSERT INTO users (email, name, role, password_hash, client_id, notion_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
person.run('admin@local.test', 'Ahmed', 'admin', pw, null, null, nowIso());
person.run('elena@local.test', 'Elena', 'client', pw, 1, null, nowIso());
person.run('kunal@local.test', 'Kunal', 'editor', pw, null, 'u-kunal', nowIso());
person.run('new.editor@local.test', 'Bilal', 'editor', null, null, null, nowIso());
db.prepare("INSERT INTO feedback (card_id, client_id, user_id, author, note, created_at) SELECT id, client_id, 2, 'Elena', 'Open on the receipt, not on us talking', ? FROM cards WHERE title = 'We tried 50/50 for a month'").run(nowIso());
db.prepare("UPDATE cards SET editor_ids = '[\"u-kunal\"]', editor_names = 'Kunal' WHERE title = 'We tried 50/50 for a month'").run();

const cfg = { tz: 'Europe/London', prod: false, baseUrl: 'http://localhost:3222' };
const app = await buildServer({ db, cfg, notion });
await app.listen({ port: 3222, host: '127.0.0.1' });
console.log('Preview on http://localhost:3222');
