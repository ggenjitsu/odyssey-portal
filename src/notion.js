import { canonApproval } from './rules.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NotionError extends Error {
  constructor(status, code, message) {
    super(`Notion ${status}${code ? ` ${code}` : ''}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

export function createNotion({ token, version = '2025-09-03', fetchImpl = fetch, retryMs = 1000 }) {
  async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`https://api.notion.com/v1${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'notion-version': version, 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt >= 3) throw new NotionError(0, 'network', err.message);
        await sleep(retryMs * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 3) throw new NotionError(res.status, 'retry_exhausted', 'Notion is rate limiting or unavailable');
        await sleep((Number(res.headers.get('retry-after')) || 2 ** attempt) * retryMs);
        continue;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new NotionError(res.status, json.code, json.message || 'request failed');
      return json;
    }
  }

  return {
    dataSource: (id) => call('GET', `/data_sources/${id}`),
    database: (id) => call('GET', `/databases/${id}`),
    page: (id) => call('GET', `/pages/${id}`),
    updatePage: (id, properties) => call('PATCH', `/pages/${id}`, { properties }),
    createPage: (dataSourceId, properties) => call('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties }),
    comment: (pageId, text) =>
      call('POST', '/comments', { parent: { page_id: pageId }, rich_text: [{ text: { content: text.slice(0, 1900) } }] }),

    // Every row of a board. Throws if any page of results fails, so a partial pull is never applied.
    async queryAll(dataSourceId) {
      const pages = [];
      let cursor;
      do {
        const r = await call('POST', `/data_sources/${dataSourceId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        pages.push(...(r.results || []));
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      return pages;
    },

    // Boards the integration has been given access to.
    async listDataSources() {
      const out = [];
      let cursor;
      do {
        const r = await call('POST', '/search', {
          filter: { property: 'object', value: 'data_source' },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        out.push(...(r.results || []));
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      return out;
    },

    // Accepts a data source id or a database id/URL and returns the data source id.
    async resolveDataSourceId(idOrUrl) {
      const hex = String(idOrUrl).replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0];
      if (!hex) throw new NotionError(400, 'bad_id', 'That does not look like a Notion link or ID');
      const id = hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toLowerCase();
      try {
        await call('GET', `/data_sources/${id}`);
        return id;
      } catch (err) {
        if (err.status !== 404 && err.status !== 400) throw err;
      }
      const dbObj = await call('GET', `/databases/${id}`);
      const first = dbObj.data_sources?.[0]?.id;
      if (!first) throw new NotionError(404, 'no_data_source', 'That database has no data source');
      return first;
    },
  };
}

// Which board column feeds each portal field. First name that exists with an accepted type wins,
// so a board can rename "Person" to "Editor" and nothing breaks.
const CANDIDATES = {
  status: { names: ['Status', 'Stage'], types: ['status', 'select'] },
  approval: { names: ['Approval'], types: ['select', 'status'] },
  editor: { names: ['Editor', 'Person', 'Assignee'], types: ['people'] },
  priority: { names: ['Priority'], types: ['select'] },
  funnel: { names: ['Funnel'], types: ['select'] },
  posting: { names: ['Posting'], types: ['select'] },
  due_date: { names: ['Due Date', 'Due'], types: ['date'] },
  posted_date: { names: ['Posted Date'], types: ['date'] },
  posted_link: { names: ['Posted Video Link', 'Posted Link'], types: ['url'] },
  review_link: { names: ['Review Link', 'Frame Link', 'FreeFrame Link', 'Review'], types: ['url'] },
  script_url: { names: ['Script'], types: ['url'] },
  inspo_url: { names: ['Inspo'], types: ['url'] },
  delay_reason: { names: ['Delay Reason'], types: ['rich_text'] },
  files: { names: ['Edited Version'], types: ['files'] },
  // How many accounts a video went out on, for clients whose package counts each upload.
  weight: { names: ['Accounts Posted', 'Accounts', 'Post Count', 'Counts As'], types: ['number'] },
};

// Extra columns a creator campaign board carries (one row per creator, not per video).
const EXTRA = {
  chase: { names: ['Chase'], types: ['select'] },
  videos_posted: { names: ['Videos posted'], types: ['number'] },
  owner: { names: ['Owner'], types: ['rich_text'] },
  next_action: { names: ['Next action'], types: ['rich_text'] },
  blockers: { names: ['Blockers'], types: ['rich_text'] },
  last_activity: { names: ['Last activity'], types: ['date'] },
  last_activity_note: { names: ['Last activity note'], types: ['rich_text'] },
  handles: { names: ['Handles'], types: ['rich_text'] },
};

export function resolvePropMap(schemaProps = {}) {
  const entries = Object.entries(schemaProps);
  const map = {};
  const title = entries.find(([, p]) => p.type === 'title');
  if (title) map.title = { name: title[0], type: 'title' };
  for (const [key, cand] of Object.entries({ ...CANDIDATES, ...EXTRA })) {
    for (const want of cand.names) {
      const hit = entries.find(([name, p]) => name.trim().toLowerCase() === want.toLowerCase() && cand.types.includes(p.type));
      if (hit) {
        map[key] = { name: hit[0], type: hit[1].type };
        break;
      }
    }
  }
  if (map.approval) {
    const labels = {};
    for (const opt of schemaProps[map.approval.name][map.approval.type]?.options || []) {
      const canon = canonApproval(opt.name);
      if (canon && !labels[canon]) labels[canon] = opt.name;
    }
    map.approval.labels = labels;
  }
  if (map.status) map.status.options = (schemaProps[map.status.name][map.status.type]?.options || []).map((o) => o.name);
  return map;
}

const text = (arr) => (arr || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('').trim() || null;

function read(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title': return text(prop.title);
    case 'rich_text': return text(prop.rich_text);
    case 'status': return prop.status?.name ?? null;
    case 'select': return prop.select?.name ?? null;
    case 'url': return prop.url || null;
    case 'date': return prop.date?.start ?? null;
    case 'number': return prop.number ?? null;
    case 'people': return (prop.people || []).filter((p) => p?.id);
    case 'files': return prop.files || [];
    default: return null;
  }
}

// A "Posted links" list: one row per upload, with its link, day, account, platform and views.
const POST_COLS = {
  link: { names: ['Link', 'Post link', 'URL', 'Posted Video Link'], types: ['url'] },
  date: { names: ['Posted Date', 'Date', 'Posted'], types: ['date'] },
  platform: { names: ['Platform'], types: ['select', 'rich_text'] },
  account: { names: ['Account'], types: ['select', 'rich_text'] },
  views: { names: ['Views'], types: ['number'] },
  uploads: { names: ['Uploads', 'Videos', 'Posts'], types: ['number'] },
  checked: { names: ['Views checked'], types: ['date'] },
};

export function resolvePostMap(schemaProps = {}) {
  const entries = Object.entries(schemaProps);
  const map = {};
  const title = entries.find(([, p]) => p.type === 'title');
  if (title) map.title = { name: title[0], type: 'title' };
  for (const [key, cand] of Object.entries(POST_COLS)) {
    for (const want of cand.names) {
      const hit = entries.find(([name, p]) => name.trim().toLowerCase() === want.toLowerCase() && cand.types.includes(p.type));
      if (hit) {
        map[key] = { name: hit[0], type: hit[1].type };
        break;
      }
    }
  }
  return map;
}

// What a link alone says about where it was posted, for rows where nobody filled that in.
export function guessPost(url) {
  let u;
  try { u = new URL(url); } catch { return {}; }
  const host = u.hostname.replace(/^(www|m|vm)\./, '');
  const first = u.pathname.split('/').filter(Boolean)[0] || '';
  if (host === 'instagram.com') return { platform: 'Instagram', account: /^(reel|reels|p|tv)$/.test(first) || !first ? null : `@${first}` };
  if (host === 'tiktok.com') return { platform: 'TikTok', account: first.startsWith('@') ? first : null };
  if (host === 'youtube.com' || host === 'youtu.be') return { platform: 'YouTube', account: first.startsWith('@') ? first : null };
  return {};
}

// Notion properties for a posts-list row. Only the fields given are written, so an update can touch views alone.
export function buildPostProps(map, r, today) {
  const props = {};
  const text = (s) => [{ text: { content: String(s).slice(0, 200) } }];
  if (r.title != null && map.title) props[map.title.name] = { title: text(r.title) };
  if (r.url && map.link) props[map.link.name] = { url: r.url };
  if (r.date && map.date) props[map.date.name] = { date: { start: r.date } };
  for (const k of ['platform', 'account']) {
    if (r[k] && map[k]) props[map[k].name] = map[k].type === 'select' ? { select: { name: String(r[k]).replace(/,/g, ' ').slice(0, 90) } } : { rich_text: text(r[k]) };
  }
  if (r.views != null && map.views) props[map.views.name] = { number: Number(r.views) };
  if (r.uploads != null && map.uploads) props[map.uploads.name] = { number: Number(r.uploads) };
  if (r.views != null && map.checked && today) props[map.checked.name] = { date: { start: today } };
  return props;
}

export function normalizePost(page, map) {
  const get = (key) => (map[key] ? read(page.properties?.[map[key].name]) : null);
  const url = get('link');
  const guess = guessPost(url);
  const views = get('views');
  return {
    notion_page_id: page.id,
    url,
    title: get('title'),
    platform: get('platform') || guess.platform || null,
    account: get('account') || guess.account || null,
    posted_on: (get('date') || '').slice(0, 10) || null,
    views: views == null ? null : Math.round(views),
    uploads: Math.max(1, Math.round(get('uploads') ?? 1)),
    views_checked: (get('checked') || '').slice(0, 10) || null,
    notion_url: page.url || null,
  };
}

// A Notion page as the flat card the portal stores.
export function normalizePage(page, map) {
  const get = (key) => (map[key] ? read(page.properties?.[map[key].name]) : null);
  const people = [...(get('editor') || [])].sort((a, b) => a.id.localeCompare(b.id));
  const approvalRaw = get('approval');
  const extra = Object.fromEntries(Object.keys(EXTRA).map((k) => [k, get(k)]).filter(([, v]) => v != null && v !== ''));
  return {
    id: page.id,
    title: get('title') || 'Untitled',
    status: get('status'),
    approval: canonApproval(approvalRaw),
    approval_raw: approvalRaw,
    editor_ids: JSON.stringify(people.map((p) => p.id)),
    editor_names: people.map((p) => p.name || 'Unknown').join(', '),
    priority: get('priority'),
    funnel: get('funnel'),
    posting: get('posting'),
    due_date: get('due_date'),
    posted_date: get('posted_date'),
    posted_link: get('posted_link'),
    review_link: get('review_link'),
    script_url: get('script_url'),
    inspo_url: get('inspo_url'),
    delay_reason: get('delay_reason'),
    file_count: (get('files') || []).length,
    weight: get('weight'),
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    notion_url: page.url || null,
    created_at: page.created_time || null,
    last_edited_at: page.last_edited_time || null,
    people: people.map((p) => ({ id: p.id, name: p.name || null, email: p.person?.email || null, avatar_url: p.avatar_url || null })),
  };
}

// Fresh, short-lived links to the files attached to a card (Notion's file links expire after about an hour).
export function pageFiles(page, map) {
  if (!map.files) return [];
  return (read(page.properties?.[map.files.name]) || [])
    .map((f) => ({ name: f.name || 'file', url: f.file?.url || f.external?.url || null, expires_at: f.file?.expiry_time || null }))
    .filter((f) => f.url);
}

// Portal changes as a Notion properties payload, using this board's own column names and option labels.
export function buildProps(map, changes) {
  const out = {};
  const need = (key) => {
    if (!map[key]) throw new Error(`This board has no ${key.replace('_', ' ')} column`);
    return map[key];
  };
  if ('status' in changes) {
    const m = need('status');
    out[m.name] = { [m.type]: { name: changes.status } };
  }
  if ('approval' in changes) {
    const m = need('approval');
    const label = m.labels?.[changes.approval];
    if (!label) throw new Error(`This board has no "${changes.approval}" approval option`);
    out[m.name] = { [m.type]: { name: label } };
  }
  if ('posted_date' in changes) out[need('posted_date').name] = { date: changes.posted_date ? { start: changes.posted_date } : null };
  if ('posted_link' in changes && map.posted_link) out[map.posted_link.name] = { url: changes.posted_link || null };
  return out;
}
