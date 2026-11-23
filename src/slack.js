import { nowIso, getSetting } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tsIso = (ts) => new Date(Number(ts) * 1000).toISOString();

export function createSlack({ token, fetchImpl = fetch }) {
  async function api(method, params = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetchImpl(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        await sleep((Number(res.headers.get('retry-after')) || 2) * 1000);
        continue;
      }
      const json = await res.json();
      if (!json.ok) throw new Error(`Slack ${method}: ${json.error}`);
      return json;
    }
    throw new Error(`Slack ${method}: rate limited`);
  }

  async function paged(method, params, key) {
    const out = [];
    let cursor = '';
    do {
      const r = await api(method, { limit: 200, ...params, ...(cursor ? { cursor } : {}) });
      out.push(...(r[key] || []));
      cursor = r.response_metadata?.next_cursor || '';
    } while (cursor);
    return out;
  }

  let people = null;
  let peopleAt = 0;
  // Who is on the Odyssey side. Guests and people from other workspaces count as clients.
  async function loadPeople() {
    if (people && Date.now() - peopleAt < 3_600_000) return people;
    const { team_id: teamId } = await api('auth.test');
    const members = await paged('users.list', {}, 'members');
    people = new Map(members.map((u) => [u.id, {
      name: u.profile?.display_name || u.real_name || u.name || 'Someone',
      bot: Boolean(u.is_bot) || u.id === 'USLACKBOT',
      team: !u.deleted && !u.is_bot && u.team_id === teamId && !u.is_restricted && !u.is_ultra_restricted && !u.is_stranger,
    }]));
    peopleAt = Date.now();
    return people;
  }

  // Is the client's latest message in this channel still unanswered by the team?
  async function checkChannel(channelId, teamOverride) {
    const users = await loadPeople();
    const isTeam = (id) => (teamOverride ? teamOverride.includes(id) : Boolean(users.get(id)?.team));
    const { messages = [] } = await api('conversations.history', { channel: channelId, limit: 60 });
    const human = messages.filter((m) => m.type === 'message' && m.user && !m.bot_id && !users.get(m.user)?.bot
      && (!m.subtype || ['file_share', 'thread_broadcast'].includes(m.subtype)));
    const latest = human[0];
    if (!latest || isTeam(latest.user) || (latest.reply_users || []).some(isTeam)) return { waiting: false };
    // Walk back to the first message of the unanswered run, so the age is how long they have really waited.
    let first = latest;
    for (const m of human.slice(1)) {
      if (isTeam(m.user) || (m.reply_users || []).some(isTeam)) break;
      first = m;
    }
    return { waiting: true, waiting_since: tsIso(first.ts), last_from: users.get(latest.user)?.name || 'Client', last_text: (latest.text || '').slice(0, 240) };
  }

  return {
    checkChannel,
    channels: async () => (await paged('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true }, 'channels'))
      .map((c) => ({ id: c.id, name: c.name, private: Boolean(c.is_private), member: Boolean(c.is_member) })),
    users: async () => [...(await loadPeople()).entries()].filter(([, u]) => !u.bot).map(([id, u]) => ({ id, name: u.name, team: u.team })),
  };
}

export async function refreshSlack(db, slack) {
  const teamOverride = getSetting(db, 'slack_team_user_ids');
  const clients = db.prepare("SELECT id, slack_channel_id FROM clients WHERE active = 1 AND slack_channel_id IS NOT NULL AND slack_channel_id != ''").all();
  const save = db.prepare(
    `INSERT INTO slack_status (client_id, channel_id, waiting, waiting_since, last_from, last_text, checked_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET channel_id = excluded.channel_id, waiting = excluded.waiting, waiting_since = excluded.waiting_since,
       last_from = excluded.last_from, last_text = excluded.last_text, checked_at = excluded.checked_at, error = excluded.error`,
  );
  for (const c of clients) {
    try {
      const r = await slack.checkChannel(c.slack_channel_id, Array.isArray(teamOverride) && teamOverride.length ? teamOverride : null);
      save.run(c.id, c.slack_channel_id, r.waiting ? 1 : 0, r.waiting_since ?? null, r.last_from ?? null, r.last_text ?? null, nowIso(), null);
    } catch (err) {
      // Keep the last known answer and record why the check failed.
      db.prepare(
        `INSERT INTO slack_status (client_id, channel_id, checked_at, error) VALUES (?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`,
      ).run(c.id, c.slack_channel_id, nowIso(), err.message);
    }
  }
  return clients.length;
}
