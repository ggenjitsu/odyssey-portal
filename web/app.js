// Odyssey Portal web app. Plain modules, no build step.
// Everything that comes from Notion or a person is written as text, never as HTML.

const app = document.getElementById('app');
const state = { user: null, overview: null, client: null, board: null, editor: null, people: null, clientList: null, channels: undefined,
  sendBack: null, form: null, invite: null, settings: null, undo: null, busy: new Set(), entered: false };

// ---------- helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Line icons from lucide (ISC licence), one size and stroke everywhere.
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  back: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  out: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  leave: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  svg.innerHTML = ICONS[name];
  return svg;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'x-portal': '1' };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  // A different build means the portal was updated while this tab was open.
  const build = res.headers.get('x-build');
  if (build && !state.build) state.build = build;
  else if (build && build !== state.build) state.stale = true;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: res.status });
  return data;
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? u : null);
const pad = (n) => String(n).padStart(2, '0');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);

// How long something has been waiting, set like a timecode: 2d 06h, 3h 20m, 4m.
function span(iso) {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  const d = Math.floor(mins / 1440);
  const hr = Math.floor((mins % 1440) / 60);
  if (d) return `${d}d ${pad(hr)}h`;
  if (hr) return `${hr}h ${pad(mins % 60)}m`;
  return `${mins}m`;
}
function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}
const clock = (iso, tz) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));
const dayShort = (iso, tz) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: tz }).format(new Date(iso));

// ---------- the picture behind the glass ----------

const isVideo = (src) => /\.(mp4|webm|mov)(\?|$)/i.test(src);
const stillOf = (src) => (isVideo(src) ? src.replace(/\.\w+(\?.*)?$/, '.jpg') : src);
const bgSrc = (url) => safeUrl(url) || (String(url || '').startsWith('/bg/') ? url : null);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const footage = new Map(); // videos already buffering, by address
const warmed = new Set();

function videoFor(src) {
  if (!footage.has(src)) {
    const v = h('video', { src, loop: true, playsinline: true, preload: 'auto' });
    v.muted = true;
    footage.set(src, v);
  }
  return footage.get(src);
}

// Fetch a picture's still ahead of time, and on real intent start buffering its footage, so it is
// already there when the portal opens.
function warm(url, withFootage) {
  const src = bgSrc(url);
  if (!src) return;
  if (!warmed.has(src)) {
    warmed.add(src);
    new Image().src = stillOf(src);
  }
  if (withFootage && isVideo(src) && !reduced() && !navigator.connection?.saveData) videoFor(src);
}

// Each picture is a layer: its still shows first, the footage fades in over it once it plays, and
// the new layer fades in over the old one. Nothing ever cuts to black.
function setBackdrop(url) {
  const el = document.getElementById('backdrop');
  const src = bgSrc(url);
  if (el.dataset.src === (src || '')) return;
  el.dataset.src = src || '';
  const old = [...el.children];
  const retire = () => old.forEach((o) => {
    o.querySelector('video')?.pause();
    o.remove();
  });
  if (!src) return retire();
  const layer = h('div', { class: old.length ? 'layer' : 'layer is-first' });
  const still = h('img', { src: stillOf(src), alt: '', decoding: 'async' });
  layer.append(still);
  if (isVideo(src) && !reduced()) {
    const v = videoFor(src);
    const on = () => v.classList.add('is-on');
    if (v.readyState >= 3 && !v.paused) on();
    else v.addEventListener('playing', on, { once: true });
    layer.append(v);
    v.play().catch(() => {});
  }
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    layer.classList.add('is-on');
    setTimeout(retire, old.length ? 760 : 0);
  };
  if (still.complete && still.naturalWidth) show();
  else {
    still.addEventListener('load', show, { once: true });
    still.addEventListener('error', show, { once: true });
    setTimeout(show, 1200);
  }
  el.append(layer);
  try { localStorage.setItem('ody_bg', src); } catch { /* storage can be off */ }
}

// Client names and "Open portal" open that client's board. Their picture starts fading in on the click,
// before the data is back. A modified click still opens a new tab.
const portalLink = (c) => ({
  href: `/client/${c.slug}`,
  onclick: (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    if (c.background) setBackdrop(c.background);
    go(`/client/${c.slug}`);
  },
  onpointerenter: () => warm(c.background, true),
  onfocus: () => warm(c.background, true),
});

// ---------- sign in ----------

function entry({ heading, fields, button, note, onSubmit }) {
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, button);
  const form = h('form', { class: 'entry-form glass', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(form)));
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
      }
    } },
    h('h2', {}, heading),
    fields.map((f) => h('div', { class: 'field' },
      h('label', { for: f.name }, f.label),
      h('input', { class: 'input', id: f.name, name: f.name, type: f.type, autocomplete: f.autocomplete, required: true, autofocus: f.autofocus }))),
    error, submit,
    note && h('p', { class: 'note' }, note));
  return h('div', { class: 'entry' },
    h('div', { class: 'entry-copy' },
      h('div', { class: 'wordmark' }, 'Odyssey', h('span', {}, 'Portal')),
      h('h1', {}, 'Everything in one place')),
    form);
}

function loginView() {
  return entry({
    heading: 'Sign in',
    button: 'Sign in',
    note: 'Lost your password? Ask your Odyssey contact for a new link',
    fields: [
      { name: 'email', label: 'Email', type: 'email', autocomplete: 'username', autofocus: true },
      { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' },
    ],
    onSubmit: async (body) => {
      state.user = (await api('/auth/login', { method: 'POST', body })).user;
      await start();
    },
  });
}

function inviteView(token) {
  return entry({
    heading: 'Choose a password',
    button: 'Save and sign in',
    note: 'Use at least 10 characters',
    fields: [{ name: 'password', label: 'Password', type: 'password', autocomplete: 'new-password', autofocus: true }],
    onSubmit: async ({ password }) => {
      state.user = (await api('/auth/accept-invite', { method: 'POST', body: { token, password } })).user;
      history.replaceState(null, '', '/');
      await start();
    },
  });
}

// ---------- shell ----------

function topbar(right) {
  return h('div', { class: 'topbar-wrap' },
    h('header', { class: 'topbar glass' },
      h('div', { class: 'wordmark' }, 'Odyssey', h('span', {}, 'Portal')),
      state.user.role === 'admin' && h('nav', { class: 'nav', 'aria-label': 'Sections' },
        [['/', 'Overview'], ['/clients', 'Clients'], ['/people', 'People']].map(([path, label]) =>
          h('a', { href: path, 'aria-current': route() === path ? 'page' : null, onclick: nav(path) }, label))),
      h('div', { class: 'spacer' }),
      right,
      h('span', { class: 'who' }, state.user.name || state.user.email),
      h('button', { class: 'btn btn-quiet', type: 'button', 'aria-label': 'Sign out', title: 'Sign out',
        onclick: async () => {
          await api('/auth/logout', { method: 'POST' }).catch(() => {});
          try { localStorage.removeItem('ody_bg'); } catch { /* storage can be off */ }
          Object.assign(state, { user: null, overview: null, client: null, board: null, editor: null, people: null, clientList: null, invite: null, form: null });
          history.replaceState(null, '', '/');
          render();
        } }, icon('leave'))));
}

function page(...sections) {
  const entering = !state.entered;
  const el = h('main', { class: entering ? 'page enter' : 'page' }, sections);
  state.entered = true;
  if (entering) {
    // Each block rises a beat after the one before it.
    [...el.querySelectorAll('.page-head, .glass')].forEach((node, i) => node.style.setProperty('--n', Math.min(i, 12)));
  }
  return el;
}

// ---------- admin ----------

const STAGES = ['Idea', 'Scripting', 'Filming', 'Ready to Edit', 'Editing', 'Revisions', 'Review', 'Ready'];
const slug = (s) => s.toLowerCase().replace(/\s+/g, '-');

const num = (n) => Number(n || 0).toLocaleString('en-GB');

function stat(label, figure, note, waiting) {
  return h('div', { class: `stat glass${waiting && figure > 0 ? ' is-waiting' : ''}` },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-figure' }, figure >= 100 ? num(figure) : pad(figure)),
    h('div', { class: 'stat-note' }, note));
}

// The two numbers that matter most lead every client page: views, and how much went out.
function headline(o) {
  const p = o.package || {};
  // A creator campaign's list holds every upload ever tracked; a video client's is counted per period.
  const posted = stat('Videos posted', o.kind === 'creators' && o.posts ? o.posts.total : p.delivered ?? 0, '');
  return o.posts
    ? [stat('Views', o.posts.views, o.kind === 'creators' ? `on ${plural(o.posts.total, 'upload')}, from SideShift` : `on ${plural(o.posts.total, 'upload')}, ${dateUtc(o.posts.first)} to ${dateUtc(o.posts.last)}`), posted]
    : [posted, stat('Last 30 days', o.delivered_30d ?? 0, 'videos posted')];
}

// Every upload with its views, from the client's "Posted links" list in Notion.
function postsPanel(posts) {
  if (!posts?.length) return null;
  const byViews = state.postSort === 'views';
  const rows = [...posts].sort((a, z) => (byViews ? 0 : String(z.posted_on).localeCompare(String(a.posted_on))) || (z.views || 0) - (a.views || 0));
  const accounts = [...new Set(posts.map((p) => p.account || 'Other'))];
  const platforms = [...new Set(posts.map((p) => p.platform || 'Other'))];
  const views = (list) => list.reduce((n, p) => n + (p.views || 0), 0);
  const checked = posts.map((p) => p.views_checked).filter(Boolean).sort().pop();
  const uploads = (list) => list.reduce((n, p) => n + (p.uploads || 1), 0);
  const tally = (list) => h('div', { class: 'tally' }, h('b', {}, num(views(list))), h('small', {}, plural(uploads(list), 'upload')));
  const table = h('div', { class: 'tallies' },
    h('span', {}), platforms.map((pl) => h('span', { class: 'th' }, pl)), h('span', { class: 'th' }, 'All'),
    accounts.map((a) => {
      const mine = posts.filter((p) => (p.account || 'Other') === a);
      return [h('i', { class: 'rule' }), h('span', { class: 'acct' }, a), platforms.map((pl) => tally(mine.filter((p) => (p.platform || 'Other') === pl))), tally(mine)];
    }));
  table.style.gridTemplateColumns = `minmax(0, 1.4fr) repeat(${platforms.length + 1}, minmax(0, 1fr))`;
  const sortBy = (key, label) => h('button', { class: 'btn btn-quiet btn-sm', type: 'button', 'aria-pressed': String((state.postSort || 'date') === key),
    onclick: () => { state.postSort = key; render(); } }, label);
  const row = (p) => h('a', { class: 'row post', href: safeUrl(p.url), target: '_blank', rel: 'noopener' },
    h('time', {}, p.posted_on ? dateUtc(p.posted_on) : ''),
    h('span', { class: 'post-where' }, p.platform || ''),
    h('span', { class: 'post-acct' }, p.account || '', p.title && !/^(reel|tiktok)\b/i.test(p.title) && h('small', {}, p.uploads > 1 ? `@${p.title.replace(/^@/, '')}, ${p.uploads} uploads` : p.title)),
    h('b', { class: 'post-views' }, num(p.views)),
    h('span', { class: 'link' }, 'Open', icon('out')));
  return h('section', { class: 'panel glass' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Views'), h('p', {}, `${num(views(posts))} views on ${plural(uploads(posts), 'upload')}${checked ? `, counted ${dateUtc(checked)}` : ''}`)),
    table,
    h('div', { class: 'panel-head' }, h('h2', {}, posts.some((p) => p.uploads > 1) ? 'Every account' : 'Every upload'), h('div', { class: 'actions' }, sortBy('date', 'Newest'), sortBy('views', 'Most viewed'))),
    h('div', { class: 'rows post-list' }, rows.map(row)));
}

async function act(key, fn) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  render();
  try {
    await fn();
    state.sendBack = null;
    state.form = null;
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy.delete(key);
    render();
  }
}

function reviewRow(c) {
  const open = state.sendBack?.id === c.id;
  const busy = state.busy.has(c.id);
  const review = safeUrl(c.review_link);
  const notion = safeUrl(c.notion_url);
  const row = h('div', { class: 'row review' },
    h('div', {},
      h('div', { class: 'review-title', title: c.title }, c.title),
      h('div', { class: 'meta' },
        h('span', {}, c.client_name),
        h('span', {}, c.editor_names || 'No editor set'),
        c.since && h('span', { class: 'age', title: 'Time in review' }, span(c.since)),
        review && h('a', { class: 'link', href: review, target: '_blank', rel: 'noopener' }, 'Watch', icon('out')),
        notion && h('a', { class: 'link', href: notion, target: '_blank', rel: 'noopener' }, 'Notion', icon('out')))),
    !open && h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => { state.sendBack = { id: c.id, note: '' }; render(); } }, icon('back'), 'Send back'),
      h('button', { class: 'btn btn-primary', type: 'button', disabled: busy,
        onclick: () => act(c.id, () => api(`/cards/${c.id}/review`, { method: 'POST', body: { decision: 'pass' } })) }, icon('check'), 'Pass')));
  if (open) {
    const note = h('textarea', { class: 'input', placeholder: 'What should change', 'aria-label': 'What should change',
      oninput: (e) => { state.sendBack.note = e.target.value; } });
    note.value = state.sendBack.note;
    row.append(h('div', { class: 'sendback' }, note,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { state.sendBack = null; render(); } }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'button', disabled: busy,
          onclick: () => act(c.id, () => api(`/cards/${c.id}/review`, { method: 'POST', body: { decision: 'changes', note: state.sendBack.note } })) }, 'Send to editor'))));
    queueMicrotask(() => note.focus());
  }
  return row;
}

const stageSeg = (s) => `seg-${slug(s)}`;
const creatorSeg = (s) => (/^posting/i.test(s) ? 'seg-ready' : /ready/i.test(s) ? 'seg-near' : /warm/i.test(s) ? 'seg-editing'
  : /onboard/i.test(s) ? 'seg-ready-to-edit' : /paused|silent/i.test(s) ? 'seg-review' : 'seg-idle');

function track(byStatus, stages = STAGES, seg = stageSeg, hot = (s) => s === 'Review', empty = 'Nothing in production') {
  const live = stages.filter((s) => byStatus[s]);
  if (!live.length) return h('div', {}, h('div', { class: 'track is-empty' }), h('div', { class: 'legend' }, empty));
  const bar = h('div', { class: 'track', role: 'img', 'aria-label': live.map((s) => `${sentence(s)} ${byStatus[s]}`).join(', ') });
  for (const s of live) {
    const part = h('span', { class: `seg ${seg(s)}`, title: `${sentence(s)}: ${byStatus[s]}` });
    part.style.flexGrow = String(byStatus[s]);
    bar.append(part);
  }
  return h('div', {}, bar,
    h('div', { class: 'legend' }, live.map((s) =>
      h('span', { class: `legend-item${hot(s) ? ' is-accent' : ''}` }, h('i', { class: `seg ${seg(s)}` }), sentence(s), h('b', {}, byStatus[s])))));
}

const rangeOf = (p) => (p.max && p.max !== p.size ? `${p.size} to ${p.max}` : `${p.size}`);
const dateUtc = (d) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(d));
// What the count runs from: the last invoice once one is marked, the calendar month until then.
const periodWords = (p) => (p.period_source === 'invoice' ? `since the ${dateUtc(p.period_start)} invoice`
  : p.period_source === 'stripe' ? `this billing period, ${plural(p.days_left, 'day')} left`
  : `this month, ${plural(p.days_left, 'day')} left`);

function packageCell(c) {
  const p = c.package;
  if (!p.size) return h('div', { class: 'package' },
    h('div', { class: 'package-line' }, h('strong', {}, p.delivered), ' posted'),
    h('div', { class: 'small' }, `${periodWords(p)}, no package set`));
  const done = p.delivered >= p.size;
  const fill = h('i');
  fill.style.width = `${Math.min(100, (p.delivered / p.size) * 100)}%`;
  return h('div', { class: `package${done ? ' is-done' : ''}` },
    h('div', { class: 'package-line' }, h('strong', {}, p.delivered), ` of ${rangeOf(p)} posted`),
    h('div', { class: 'bar' }, fill),
    h('div', { class: 'small' }, done ? h('span', { class: 'pace-due' }, 'Package done, send the invoice') : `${p.remaining} to go ${periodWords(p)}`));
}

function clientRow(c) {
  const waiting = c.slack?.waiting;
  const name = h('a', { class: 'client-name', title: `Open ${c.name}'s portal`, ...portalLink(c) }, c.name);
  const slackLine = h('div', { class: 'small waiting' },
    c.slack ? h('i', { class: `dot ${waiting ? 'dot-wait' : 'dot-ok'}` }) : null,
    !c.slack ? 'Slack channel not linked'
      : c.slack.error ? 'Slack check failed'
      : waiting ? `${c.slack.last_from || 'Client'} waiting ${span(c.slack.waiting_since)}`
      : 'Slack answered');
  if (c.kind === 'creators') {
    const k = c.creators;
    return h('div', { class: 'row client' },
      h('div', {}, name, h('div', { class: 'small' }, c.synced ? `${plural(k.total, 'creator')}, ${plural(c.posts?.total ?? k.videos_total, 'video')} so far` : 'Not synced yet')),
      track(c.by_status, c.stages?.length ? c.stages : Object.keys(c.by_status), creatorSeg, (s) => /paused|silent/i.test(s), 'No creators on the tracker yet'),
      packageCell(c),
      h('div', {},
        h('div', {}, h('strong', { class: 'client-name' }, k.posting), ' posting'),
        h('div', { class: 'small' }, `${k.ready} ready to post`)),
      h('div', {},
        h('div', {}, k.chase_now ? `${k.chase_now} to chase now` : 'Nobody to chase'),
        slackLine));
  }
  return h('div', { class: 'row client' },
    h('div', {}, name,
      h('div', { class: 'small' }, c.synced ? `${c.in_production} in production` : 'Not synced yet',
        c.overdue > 0 && h('span', { class: 'pace-behind' }, `, ${c.overdue} overdue`))),
    track(c.by_status),
    packageCell(c),
    h('div', {},
      h('div', {}, h('strong', { class: 'client-name' }, c.ready), ' ready to post'),
      h('div', { class: 'small' }, !c.ready ? 'Nothing banked' : c.runway_days == null ? 'No posting pace yet' : `About ${plural(Math.max(1, Math.round(c.runway_days)), 'day')} banked`)),
    h('div', {},
      h('div', {}, c.needs_approval ? `${c.needs_approval} with the client` : 'Nothing with the client'),
      slackLine));
}

function eventRow(e, tz) {
  const today = new Date(e.at).toDateString() === new Date().toDateString();
  const what = e.field === 'status' ? [h('span', {}, `${sentence(e.from_value) || 'New'} to `), sentence(e.to_value)]
    : e.field === 'approval' ? [h('span', {}, 'Approval: '), e.to_value || 'cleared']
    : e.field === 'editor' ? [h('span', {}, 'Editor: '), e.to_value || 'unassigned']
    : e.field === 'videos' ? [h('span', {}, 'Videos posted: '), `${e.from_value} to ${e.to_value}`]
    : e.field === 'chase' ? [h('span', {}, 'Chase: '), e.to_value || 'cleared']
    : e.field === 'created' ? [h('span', {}, 'New card in '), sentence(e.to_value) || 'the board']
    : e.field === 'removed' ? ['Removed from the board']
    : ['Back on the board'];
  return h('div', { class: 'row event' },
    h('time', { datetime: e.at }, today ? clock(e.at, tz) : dayShort(e.at, tz)),
    h('span', { class: 'where' }, e.client_name),
    h('span', { class: 'what', title: e.card_title }, `${e.card_title} `, h('span', {}, ' · '), what),
    h('span', { class: 'by' }, e.actor_name || e.editor_names || ''));
}

function adminView(o) {
  const t = o.totals;
  const tz = o.timezone;
  const [weekday, ...rest] = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(new Date()).replace(',', '').split(' ');
  const videos = o.clients.filter((c) => c.kind !== 'creators').reduce((n, c) => n + c.total, 0);
  const creators = o.clients.reduce((n, c) => n + (c.creators?.total || 0), 0);
  o.clients.forEach((c) => warm(c.background));
  const sync = o.last_sync;
  const maxDone = Math.max(1, ...o.editors.map((e) => e.done_7d));
  const syncing = state.busy.has('sync');

  return h('div', {},
    topbar(h('span', { class: 'sync', title: sync ? `Last pull from Notion: ${clock(sync.finished_at, tz)}` : '' },
      h('i', { class: `dot ${!sync ? '' : sync.ok ? 'dot-ok' : 'dot-bad'}` }),
      !sync ? 'Waiting for the first sync' : sync.ok ? `Synced ${ago(sync.finished_at)}` : 'Last sync had a problem')),
    page(
      h('div', { class: 'page-head' },
        h('div', {},
          h('h1', { class: 'title' }, `${weekday} `, h('span', {}, rest.join(' '))),
          h('p', { class: 'sub' }, `${plural(videos, 'video')}${creators ? ` and ${plural(creators, 'creator')}` : ''} across ${plural(o.clients.length, 'client')}`, t.overdue ? `, ${t.overdue} overdue` : '')),
        h('button', { class: 'btn', type: 'button', disabled: syncing,
          onclick: () => act('sync', () => api('/admin/sync', { method: 'POST' })) }, icon('refresh'), syncing ? 'Syncing' : 'Sync now')),

      h('section', { class: 'stats', 'aria-label': 'Today' },
        stat('Needs your review', t.needs_review, 'before the client sees it', true),
        stat('With clients', t.needs_approval, 'waiting for approval'),
        stat('Ready to post', t.ready, 'finished, not out yet'),
        stat('Posted', t.delivered_7d, `last 7 days, ${t.delivered_30d} in 30`)),

      h('div', { class: 'cols' },
        h('section', { class: 'panel glass' },
          h('div', { class: 'panel-head' }, h('h2', {}, 'Needs review from you'), h('p', {}, 'Longest wait first')),
          o.needs_review.length ? h('div', { class: 'rows' }, o.needs_review.map(reviewRow)) : h('p', { class: 'empty' }, 'Nothing is waiting on you')),
        h('section', { class: 'panel glass' },
          h('div', { class: 'panel-head' }, h('h2', {}, 'Editors'), h('p', {}, 'Finished, last 7 days')),
          o.editors.length ? h('div', { class: 'rows' }, o.editors.map((e) => {
            const fill = h('i');
            fill.style.width = `${(e.done_7d / maxDone) * 100}%`;
            return h('div', { class: 'row editor' },
              h('div', { class: 'editor-name' }, e.name, h('small', {}, `${e.queue} in queue${e.in_revisions ? `, ${e.in_revisions} in revisions` : ''}${e.done_today ? `, ${e.done_today} today` : ''}`)),
              h('div', { class: 'bar' }, fill),
              h('div', { class: 'figure' }, e.done_7d));
          })) : h('p', { class: 'empty' }, 'No editor is set on any card yet'))),

      h('section', { class: 'panel glass' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Clients'), h('p', {}, 'Pipeline, package, and who is waiting')),
        h('div', { class: 'rows' }, o.clients.map(clientRow))),

      h('section', { class: 'panel glass' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Activity'), h('p', {}, 'Every change the portal has logged')),
        o.recent_events.length ? h('div', { class: 'rows' }, o.recent_events.map((e) => eventRow(e, tz)))
          : h('p', { class: 'empty' }, 'Changes show up here as cards move in Notion'))));
}

// ---------- pieces the client and editor views share ----------

const panel = (title, hint, body) =>
  h('section', { class: 'panel glass' }, h('div', { class: 'panel-head' }, h('h2', {}, title), hint && h('p', {}, hint)), body);
const list = (items, row, empty) => (items.length ? h('div', { class: 'rows' }, items.map(row)) : h('p', { class: 'empty' }, empty));
const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
const dateShort = (d) => (d ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(d)) : '');
const todayIso = () => new Date().toLocaleDateString('en-CA');
const closeForm = () => { state.form = null; render(); };

function showPlayer(title, url) {
  const dlg = h('dialog', { class: 'player glass' },
    h('div', { class: 'panel-head' }, h('h2', {}, title), h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dlg.close() }, 'Close')),
    h('video', { src: url, controls: true, autoplay: true, playsinline: true }));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// Opens the review link if the card has one, else plays the file attached to the card in Notion.
async function watch(c) {
  const link = safeUrl(c.review_link);
  if (link) return void window.open(link, '_blank', 'noopener');
  try {
    const { files } = await api(`/cards/${c.id}/media`);
    const file = files.find((f) => safeUrl(f.url));
    if (file) showPlayer(c.title, file.url);
    else toast('No video is attached to this card yet');
  } catch (err) {
    toast(err.message);
  }
}
const watchButton = (c) => (safeUrl(c.review_link) || c.has_media) && h('button', { class: 'btn', type: 'button', onclick: () => watch(c) }, icon('play'), 'Watch');

function videoRow(c, meta, actions, form, extra) {
  return h('div', { class: 'row review' },
    h('div', {}, h('div', { class: 'review-title', title: c.title }, c.title), h('div', { class: 'meta' }, meta), extra),
    !form && h('div', { class: 'actions' }, actions),
    form);
}

// ---------- client ----------

function clientView(o, preview) {
  const p = o.package || {};
  const isOpen = (c, kind) => state.form?.id === c.id && state.form.kind === kind;
  const open = (c, kind) => { state.form = { id: c.id, kind, note: '', url: '', date: todayIso() }; render(); };

  const approvalRow = (c) => {
    const busy = state.busy.has(c.id);
    let form = null;
    if (isOpen(c, 'changes')) {
      const note = h('textarea', { class: 'input', placeholder: 'What should change', 'aria-label': 'What should change', oninput: (e) => { state.form.note = e.target.value; } });
      note.value = state.form.note;
      queueMicrotask(() => note.focus());
      form = h('div', { class: 'sendback' }, note, h('div', { class: 'actions' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: closeForm }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'button', disabled: busy,
          onclick: () => act(c.id, () => api(`/cards/${c.id}/request-changes`, { method: 'POST', body: { note: state.form.note } })) }, 'Send to Odyssey')));
    }
    return videoRow(c, [c.due_date && h('span', {}, `Due ${dateShort(c.due_date)}`)], [
      watchButton(c),
      h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => open(c, 'changes') }, 'Request changes'),
      h('button', { class: 'btn btn-primary', type: 'button', disabled: busy, onclick: () => act(c.id, () => api(`/cards/${c.id}/approve`, { method: 'POST' })) }, icon('check'), 'Approve'),
    ], form);
  };

  const readyRow = (c) => {
    const busy = state.busy.has(c.id);
    let form = null;
    if (isOpen(c, 'posted')) {
      const url = h('input', { class: 'input input-sm', type: 'url', placeholder: 'Link to the post, if you have it', 'aria-label': 'Link to the post', oninput: (e) => { state.form.url = e.target.value; } });
      const date = h('input', { class: 'input input-sm', type: 'date', 'aria-label': 'Date posted', oninput: (e) => { state.form.date = e.target.value; } });
      url.value = state.form.url;
      date.value = state.form.date;
      form = h('div', { class: 'sendback' }, h('div', { class: 'posted-fields' }, url, date), h('div', { class: 'actions' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: closeForm }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'button', disabled: busy,
          onclick: () => act(c.id, () => api(`/cards/${c.id}/mark-posted`, { method: 'POST', body: { url: state.form.url.trim(), date: state.form.date } })) }, 'Mark as posted')));
    }
    return videoRow(c, [c.posting && h('span', {}, sentence(c.posting))], [
      watchButton(c),
      h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => open(c, 'posted') }, 'Mark as posted'),
    ], form);
  };

  const postedRow = (c) => videoRow(c, [
    c.posted_date && h('span', {}, dateShort(c.posted_date)),
    safeUrl(c.posted_link) && h('a', { class: 'link', href: c.posted_link, target: '_blank', rel: 'noopener' }, 'View post', icon('out')),
  ], [watchButton(c)]);

  // A creator campaign's client sees the results: views, videos out, and each creator's numbers.
  if (o.kind === 'creators') {
    return h('div', {},
      topbar(preview && h('span', { class: 'sync' }, h('i', { class: 'dot dot-wait' }), `What ${o.client.name} sees`)),
      page(
        h('div', { class: 'page-head' }, h('div', {},
          h('h1', { class: 'title' }, o.client.name),
          h('p', { class: 'sub' }, `${plural(o.creators.posting, 'creator')} posting`))),
        h('section', { class: 'stats', 'aria-label': 'Your campaign' },
          headline(o),
          stat('Creators posting', o.creators.posting, 'live right now'),
          stat('Creators', o.creators.total, 'in the campaign')),
        postsPanel(o.post_list) || h('p', { class: 'empty' }, 'Numbers show up here once the first videos are out')));
  }

  return h('div', {},
    topbar(preview && h('span', { class: 'sync' }, h('i', { class: 'dot dot-wait' }), `What ${o.client.name} sees`)),
    page(
      h('div', { class: 'page-head' }, h('div', {},
        h('h1', { class: 'title' }, o.client.name),
        h('p', { class: 'sub' }, `${plural(o.in_production, 'video')} in production`, o.changes_requested.length ? `, ${o.changes_requested.length} being reworked` : ''))),
      h('section', { class: 'stats', 'aria-label': 'Your videos' },
        headline(o),
        stat('Needs your approval', o.needs_approval.length, 'watch, then approve or ask for changes', true),
        stat('Ready to post', o.ready.length, 'approved and waiting to go out')),
      postsPanel(o.post_list),
      panel('Needs your approval', null, list(o.needs_approval, approvalRow, 'Nothing needs you right now')),
      h('div', { class: 'cols' },
        panel('Ready to post', 'Tell us when one goes out', list(o.ready, readyRow, 'Nothing is waiting to go out')),
        panel('Being reworked', null, list(o.changes_requested, (c) => videoRow(c, [h('span', {}, 'With the editor')], []), 'No changes in progress'))),
      panel('Posted', 'Most recent first', list(o.posted, postedRow, 'Nothing posted yet'))));
}

// ---------- editor ----------

function editorView(o) {
  const today = todayIso();
  const links = (c) => [['Script', c.script_url], ['Inspo', c.inspo_url], ['Notion', c.notion_url]]
    .filter(([, u]) => safeUrl(u))
    .map(([label, u]) => h('a', { class: 'link', href: u, target: '_blank', rel: 'noopener' }, label, icon('out')));
  const meta = (c) => [
    h('span', {}, c.client),
    h('span', {}, sentence(c.status)),
    c.priority && h('span', {}, `${c.priority} priority`),
    c.due_date && h('span', { class: c.due_date.slice(0, 10) < today ? 'pace-behind' : '' }, `Due ${dateShort(c.due_date)}`),
    links(c),
  ];
  const queueRow = (c) => {
    const busy = state.busy.has(c.id);
    const [to, label, primary] = c.status === 'Editing' ? ['Review', 'Send to review', true] : ['Editing', 'Start editing', false];
    return videoRow(c, meta(c), [
      watchButton(c),
      h('button', { class: primary ? 'btn btn-primary' : 'btn', type: 'button', disabled: busy,
        onclick: () => act(c.id, () => api(`/cards/${c.id}/status`, { method: 'POST', body: { status: to } })) }, label),
    ], null, c.feedback.map((f) => h('p', { class: 'quote' }, `${f.author}: ${f.note}`)));
  };
  const doneRow = (d) => h('div', { class: 'row event' },
    h('time', { datetime: d.at }, dateShort(d.at)), h('span', { class: 'where' }, d.client),
    h('span', { class: 'what', title: d.title }, d.title), h('span', { class: 'by' }, sentence(d.to_value)));

  return h('div', {}, topbar(),
    page(
      h('div', { class: 'page-head' }, h('div', {},
        h('h1', { class: 'title' }, 'Your queue'),
        h('p', { class: 'sub' }, o.linked ? `${plural(o.counts.queue, 'video')} to edit, ${o.counts.done_today} finished today`
          : 'Your login is not matched to your name in Notion yet. Ask Odyssey to link it'))),
      h('section', { class: 'stats', 'aria-label': 'Your work' },
        stat('In your queue', o.counts.queue, 'ready to edit, editing or in revisions'),
        stat('In revisions', o.counts.revisions, 'sent back with notes', true),
        stat('Finished today', o.counts.done_today, 'handed off for review'),
        stat('Finished this week', o.counts.done_week, 'since Monday')),
      panel('Queue', 'Highest priority first', list(o.queue, queueRow, 'Your queue is clear')),
      h('div', { class: 'cols' },
        panel('Finished this week', null, list(o.done_week, doneRow, 'Nothing handed off yet this week')),
        panel('In review', 'With Odyssey', list(o.in_review, (c) => videoRow(c, [h('span', {}, c.client)], []), 'Nothing in review')))));
}

// ---------- admin: people ----------

const ROLE = { admin: 'Founder', editor: 'Editor', client: 'Client' };

// Saves without redrawing first, so a failed save does not wipe what was typed.
async function send(fn, done) {
  try {
    await fn();
    await refresh();
    render();
    if (done) toast(done);
  } catch (err) {
    toast(err.message);
  }
}

function linkBox(url, who) {
  const input = h('input', { class: 'input input-sm', readonly: true, value: url, 'aria-label': 'Invite link', onfocus: (e) => e.target.select() });
  return h('div', { class: 'linkbox' },
    h('p', { class: 'small' }, `Send this link to ${who}. It works once, for 7 days, and lets them choose their own password`),
    h('div', { class: 'linkbox-row' }, input,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast('Link copied');
        } catch {
          input.select();
        }
      } }, icon('copy'), 'Copy')));
}

function copyRow(label, value) {
  const input = h('input', { class: 'input input-sm', readonly: true, value, 'aria-label': label, onfocus: (e) => e.target.select() });
  return h('div', {}, h('p', { class: 'small' }, label),
    h('div', { class: 'linkbox-row' }, input, h('button', { class: 'btn', type: 'button', onclick: async () => {
      try {
        await navigator.clipboard.writeText(value);
        toast('Copied');
      } catch {
        input.select();
      }
    } }, icon('copy'), 'Copy')));
}

function peopleView() {
  const { users, notion_people: people } = state.people;
  const clients = state.clientList || [];
  const personRow = (u) => {
    const who = u.name || u.email;
    const match = u.role === 'editor' && h('select', { class: 'input input-sm', 'aria-label': `Notion name for ${who}`,
      onchange: (e) => send(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { notion_user_id: e.target.value || null } }), 'Saved') },
      h('option', { value: '' }, 'Not matched to Notion'),
      people.map((p) => h('option', { value: p.id, selected: p.id === u.notion_user_id }, p.name || p.email || 'Unnamed')));
    return h('div', { class: 'row person' },
      h('div', {}, h('div', { class: 'client-name' }, who), h('div', { class: 'small' }, u.email)),
      h('div', {},
        h('div', {}, u.role === 'client' ? `Client, ${u.client_name || 'no client set'}` : ROLE[u.role]),
        h('div', { class: 'small' }, !u.active ? 'Switched off' : u.has_password ? 'Active' : 'Has not signed in yet')),
      h('div', {}, match),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', title: 'Makes a fresh sign-in link, for a first sign-in or a forgotten password',
          onclick: () => send(async () => { state.invite = { id: u.id, who, url: (await api(`/admin/users/${u.id}/invite`, { method: 'POST' })).invite_url }; }) }, 'New link'),
        u.id !== state.user.id && h('button', { class: 'btn btn-quiet', type: 'button',
          onclick: () => send(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } })) }, u.active ? 'Switch off' : 'Switch on')),
      state.invite?.id === u.id && linkBox(state.invite.url, state.invite.who));
  };

  const add = h('form', { class: 'form-grid',
    onsubmit: (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      if (body.role === 'client') body.client_id = Number(body.client_id);
      else delete body.client_id;
      send(async () => {
        const made = await api('/admin/users', { method: 'POST', body });
        state.invite = { id: made.id, who: body.name || body.email, url: made.invite_url };
      });
    } },
    field('Name', h('input', { class: 'input input-sm', name: 'name', autocomplete: 'off', required: true })),
    field('Email', h('input', { class: 'input input-sm', name: 'email', type: 'email', autocomplete: 'off', required: true })),
    field('Role', h('select', { class: 'input input-sm', name: 'role' },
      h('option', { value: 'client' }, 'Client'), h('option', { value: 'editor' }, 'Editor'), h('option', { value: 'admin' }, 'Founder'))),
    field('Client, for client logins', h('select', { class: 'input input-sm', name: 'client_id' }, clients.map((c) => h('option', { value: c.id }, c.name)))),
    h('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus'), 'Add and get link'));

  return h('div', {}, topbar(),
    page(
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { class: 'title' }, 'People'))),
      panel('Add someone', 'They get a link and choose their own password', add),
      panel('Everyone with a login', null, h('div', { class: 'rows' }, users.map(personRow))),
      panel('Assistants', 'Read-only access for Grok or another assistant', h('div', {},
        h('form', { class: 'form-grid',
          onsubmit: (e) => {
            e.preventDefault();
            const name = new FormData(e.target).get('name');
            send(async () => { state.newKey = (await api('/admin/api-keys', { method: 'POST', body: { name } })).key; }, 'Key made. Copy it now, it is shown once');
          } },
          field('What will use it', h('input', { class: 'input input-sm', name: 'name', placeholder: 'Grok', autocomplete: 'off', required: true })),
          h('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus'), 'Make a key')),
        state.newKey && h('div', { class: 'linkbox keybox' },
          copyRow('Server address', `${location.origin}/mcp`),
          copyRow('Key, sent as the header Authorization: Bearer <key>', state.newKey),
          copyRow('Or one address with the key inside, for assistants that only take a URL', `${location.origin}/mcp/${state.newKey}`),
          h('p', { class: 'small' }, 'This is the only time the key is shown. Anyone with it can read the portal, so share it with the assistant only')),
        h('div', { class: 'rows' }, (state.keys || []).map((k) => h('div', { class: 'row person' },
          h('div', { class: 'client-name' }, k.name),
          h('div', { class: 'small' }, k.revoked_at ? 'Switched off' : k.last_used_at ? `Last used ${ago(k.last_used_at)}` : 'Not used yet'),
          h('div', {}),
          h('div', { class: 'actions' }, !k.revoked_at && h('button', { class: 'btn btn-quiet', type: 'button',
            onclick: () => send(() => api(`/admin/api-keys/${k.id}`, { method: 'DELETE' }), `${k.name} switched off`) }, 'Switch off')))))))));
}

// ---------- admin: clients ----------

function clientsView() {
  const channels = state.channels;
  const sums = new Map((state.overview?.clients || []).map((c) => [c.slug, c]));
  const num = (name, value, extra = {}) => h('input', { class: 'input input-sm', name, type: 'number', min: 0, value: value ?? '', ...extra });
  const mini = (label, value, note) => h('div', { class: 'mini' }, h('span', {}, label), h('b', {}, value), note && h('small', {}, note));

  const card = (c) => {
    const s = sums.get(c.slug) || { slug: c.slug, name: c.name, kind: c.kind, package: {} };
    const p = s.package || {};
    const creators = c.kind === 'creators';
    const what = creators ? 'creator videos' : 'videos';
    const done = Boolean(p.size) && p.delivered >= p.size;
    const channel = channels?.find((ch) => ch.id === c.slack_channel_id);
    const fill = h('i');
    fill.style.width = `${p.size ? Math.min(100, (p.delivered / p.size) * 100) : 0}%`;
    const save = (body, after, said) => send(async () => {
      await api(`/admin/clients/${c.id}`, { method: 'PATCH', body });
      after?.();
    }, said);

    const settings = state.settings === c.id && h('form', { class: 'bill-form',
      onsubmit: (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        save({
          package_size: f.package_size, package_max: f.package_max || f.package_size, count_multiplier: Number(f.count_multiplier) || 1,
          last_invoiced_at: f.last_invoiced_at || null,
          ...(channels ? { slack_channel_id: f.slack_channel_id || null } : {}),
        }, () => { state.settings = null; }, `${c.name} saved`);
      } },
      field('Package from', num('package_size', c.package_size)),
      field('to', num('package_max', c.package_max)),
      field('Each post counts as', num('count_multiplier', c.count_multiplier, { min: 0.5, max: 20, step: 0.5 })),
      field('Last invoice', h('input', { class: 'input input-sm', name: 'last_invoiced_at', type: 'date', max: todayIso(), value: c.last_invoiced_at || '' })),
      field('Slack channel', channels
        ? h('select', { class: 'input input-sm', name: 'slack_channel_id' },
          h('option', { value: '' }, 'Not linked'),
          channels.map((ch) => h('option', { value: ch.id, selected: ch.id === c.slack_channel_id }, `#${ch.name}${ch.member ? '' : ' (invite the bot first)'}`)))
        : h('input', { class: 'input input-sm', disabled: true, value: 'Slack is not connected' })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { state.settings = null; render(); } }, 'Close')));

    return h('section', { class: `bill glass${done ? ' is-done' : ''}` },
      h('div', { class: 'bill-head' },
        h('a', { class: 'bill-name', ...portalLink(s) }, c.name),
        h('a', { class: 'link link-go', ...portalLink(s) }, 'Open portal')),
      h('div', { class: 'bill-count' },
        h('b', {}, p.delivered ?? 0),
        h('span', {}, p.size ? `of ${rangeOf(p)} ${what} posted` : `${what} posted`)),
      h('div', { class: 'bar meter' }, fill),
      h('div', { class: 'bill-line' },
        h('span', { class: 'bill-status' }, !p.size ? 'No package set' : done ? 'Package done. Send the invoice' : `${p.remaining} to go`),
        h('span', { class: 'small' }, p.period_source === 'invoice'
          ? `Last invoice ${dateUtc(p.period_start)} (${p.days_since ? `${p.days_since}d ago` : 'today'})`
          : p.period_source === 'stripe' ? `Stripe period, ${plural(p.days_left, 'day')} left`
          : `No invoice marked yet, counting this month (${plural(p.days_left ?? 0, 'day')} left)`)),
      h('div', { class: 'minis' },
        mini('Last 7 days', s.delivered_7d ?? 0),
        mini('Last 30 days', s.delivered_30d ?? 0),
        creators ? mini('Posting now', s.creators?.posting ?? 0, `of ${plural(s.creators?.total ?? 0, 'creator')}`) : mini('In review', s.needs_review ?? 0),
        creators ? mini('To chase', s.creators?.chase_now ?? 0)
          : mini('Banked', s.ready ?? 0, s.ready && s.runway_days != null ? `about ${plural(Math.max(1, Math.round(s.runway_days)), 'day')}` : null)),
      h('div', { class: 'bill-foot' },
        h('span', { class: 'small' }, channel ? `Watching #${channel.name}` : c.slack_channel_id ? 'Slack channel linked' : 'Slack channel not linked',
          s.posts ? `, counted from ${plural(s.posts.total, 'logged upload')}` : !creators && c.count_multiplier > 1 ? `, each video counts as ${c.count_multiplier}` : ''),
        h('div', { class: 'actions' },
          state.undo?.id === c.id && h('button', { class: 'btn btn-quiet', type: 'button',
            onclick: () => save({ last_invoiced_at: state.undo.prev }, () => { state.undo = null; }, 'Put back') }, 'Undo'),
          h('button', { class: 'btn', type: 'button',
            onclick: () => {
              const prev = c.last_invoiced_at || null;
              save({ last_invoiced_at: todayIso() }, () => { state.undo = { id: c.id, prev }; }, `${c.name} marked as invoiced. The count starts again from today`);
            } }, icon('check'), 'Mark invoiced today'),
          h('button', { class: 'btn btn-quiet', type: 'button', 'aria-expanded': String(state.settings === c.id),
            onclick: () => { state.settings = state.settings === c.id ? null : c.id; render(); } }, 'Settings'))),
      settings);
  };

  return h('div', {}, topbar(),
    page(
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { class: 'title' }, 'Clients'))),
      h('div', { class: 'bills' }, state.clientList.map(card))));
}

// ---------- admin: one client's tracking board ----------

const TINTS = { cino: '#8fd694', 'raymond-ng': '#a78bfa', rayston: '#f0a8b8', 'noah-eubanks': '#ffb38a', default: '#b79cf2' };

function postedChart(daily) {
  const max = Math.max(1, ...daily.map((d) => d.posted));
  const total = daily.reduce((n, d) => n + d.posted, 0);
  return h('div', {},
    h('div', { class: 'chart', role: 'img', 'aria-label': `Videos posted per day over the last 30 days, ${total} in total` },
      daily.map((d, i) => {
        const bar = h('i', { class: d.posted ? '' : 'is-zero', title: `${dateShort(d.date)}: ${d.posted} posted` });
        bar.style.height = d.posted ? `${Math.max(8, (d.posted / max) * 100)}%` : '2px';
        const col = h('div', { class: `chart-col${i === daily.length - 1 ? ' is-today' : ''}` }, bar);
        col.style.setProperty('--i', i);
        return col;
      })),
    h('div', { class: 'chart-axis small' }, h('span', {}, dateShort(daily[0].date)), h('span', {}, dateShort(daily[14].date)), h('span', {}, 'Today')));
}

const fact = (label, value) => h('div', { class: 'fact' }, h('span', {}, label), h('b', {}, value));

function packagePanel(c) {
  const p = c.package;
  const range = p.size ? rangeOf(p) : null;
  const done = range && p.delivered >= p.size;
  const videos = c.kind !== 'creators';
  return panel('Package',
    p.period_source === 'stripe' ? 'Period from Stripe' : p.period_source === 'invoice' ? `Counting since the ${dateUtc(p.period_start)} invoice` : 'Counting this month, no invoice marked yet',
    h('div', { class: 'facts' },
      fact('Posted', range ? `${p.delivered} of ${range}` : p.delivered),
      range ? fact(done ? 'Package' : 'Still to post', done ? 'Done, send the invoice' : p.remaining) : fact('Package', 'Not set'),
      range && p.expected != null && fact('Should be at by today', p.expected),
      p.days_left != null ? fact('Days left', p.days_left) : fact('Days since the invoice', p.days_since),
      c.posts && fact('Uploads logged', `${c.posts.total}, ${dateUtc(c.posts.first)} to ${dateUtc(c.posts.last)}`),
      videos && fact(c.posts ? 'A video counts as, on days not logged' : 'Each post counts as', c.counts_as),
      videos && fact('Finished and banked', c.ready),
      videos && fact('Runway', !c.ready ? 'Nothing banked' : c.runway_days == null ? 'No posting pace yet' : `About ${plural(Math.max(1, Math.round(c.runway_days)), 'day')}`)));
}

// A creator campaign: one row per creator, moving through stages, counted by their videos-posted number.
function creatorsBoard(b) {
  const c = b.client;
  const k = c.creators;
  const stages = c.stages?.length ? c.stages : [...new Set(b.cards.map((x) => x.status).filter(Boolean))];
  const link = (card, cls, kids) => {
    const url = safeUrl(card.notion_url);
    return h(url ? 'a' : 'div', { class: cls, href: url, target: url && '_blank', rel: url && 'noopener', title: card.title }, kids);
  };
  const tile = (card) => {
    const x = card.extra || {};
    const chase = x.chase && x.chase !== 'On track' ? x.chase.toLowerCase() : null;
    return link(card, `tile${x.chase === 'Chase now' ? ' is-chase' : ''}`, [
      h('span', { class: 'tile-title' }, card.title),
      h('small', {}, [`${x.videos_posted || 0} posted`, chase, x.owner].filter(Boolean).join(' · '))]);
  };
  const column = (stage) => {
    const items = b.cards.filter((x) => x.status === stage);
    return h('div', { class: 'col' },
      h('div', { class: 'col-head' }, h('span', {}, sentence(stage)), h('b', {}, items.length)),
      h('div', { class: 'col-cards' }, items.map(tile)));
  };
  const rank = { 'Chase now': 0, Nudge: 1 };
  const toChase = b.cards.filter((x) => x.extra?.chase in rank)
    .sort((a, z) => rank[a.extra.chase] - rank[z.extra.chase] || String(a.extra.last_activity || '').localeCompare(String(z.extra.last_activity || '')));
  const chaseRow = (card) => {
    const x = card.extra;
    return link(card, 'row chase', [
      h('div', {},
        h('div', { class: 'client-name' }, card.title),
        h('div', { class: 'small' }, [sentence(card.status), `${x.videos_posted || 0} posted`, x.owner].filter(Boolean).join(' · '))),
      h('div', {},
        h('div', { class: x.chase === 'Chase now' ? 'chase-now' : '' }, x.chase),
        h('div', { class: 'small' }, x.last_activity ? `Last active ${dateShort(x.last_activity)}` : 'No activity logged')),
      h('div', { class: 'chase-note' }, x.next_action || x.blockers || x.last_activity_note || '')]);
  };

  return h('div', {}, topbar(),
    page(
      h('div', { class: 'page-head' },
        h('div', {},
          h('h1', { class: 'title' }, c.name),
          h('p', { class: 'sub' }, `${plural(k.total, 'creator')} on the tracker, ${k.posting} posting`)),
        h('a', { class: 'btn', href: `/client/${c.slug}/preview`, onclick: nav(`/client/${c.slug}/preview`) }, 'See what they see', icon('out'))),

      h('section', { class: 'stats', 'aria-label': c.name },
        c.posts ? headline(c) : [stat('Videos posted', k.videos_total, `${c.delivered_7d} in the last 7 days`), stat('Ready to post', k.ready, 'set up, not posting yet')],
        stat('Posting', k.posting, `creators live, ${k.ready} more ready to post`),
        stat('Chase now', k.chase_now, k.nudge ? `${k.nudge} more to nudge` : 'nobody else to nudge', true)),

      postsPanel(b.posts),

      panel('Creators', 'Every creator, by stage. Click one to open it in Notion',
        h('div', { class: 'board' }, stages.map(column))),

      h('div', { class: 'cols' },
        panel('Videos posted per day', 'Last 30 days, from the creators\' counts going up', postedChart(b.daily)),
        packagePanel(c)),

      panel('To chase', 'Chase now first, then nudges, longest quiet first', list(toChase, chaseRow, 'Nobody needs chasing')),
      panel('Activity', `Every change logged for ${c.name}`, list(b.events, (e) => eventRow(e, b.timezone), 'Changes show up here as the tracker moves in Notion'))));
}

function boardView(b) {
  const c = b.client;
  if (c.kind === 'creators') return creatorsBoard(b);
  const today = todayIso();
  const tile = (card) => {
    const overdue = card.due_date && card.due_date.slice(0, 10) < today;
    const bits = [card.editor_names || 'No editor', card.due_date && `due ${dateShort(card.due_date)}`, card.in_stage_since && `here ${span(card.in_stage_since)}`].filter(Boolean);
    const url = safeUrl(card.notion_url);
    return h(url ? 'a' : 'div', { class: `tile${overdue ? ' is-late' : ''}`, href: url, target: url && '_blank', rel: url && 'noopener', title: card.title },
      h('span', { class: 'tile-title' }, card.title), h('small', {}, bits.join(' · ')));
  };
  const column = (stage) => {
    const items = b.cards.filter((x) => x.status === stage);
    return h('div', { class: `col${stage === 'Review' && items.length ? ' is-waiting' : ''}` },
      h('div', { class: 'col-head' }, h('span', {}, sentence(stage)), h('b', {}, items.length)),
      h('div', { class: 'col-cards' }, items.map(tile)));
  };
  const postedRow = (card) => videoRow(card, [
    card.posted_date && h('span', {}, dateShort(card.posted_date)),
    card.editor_names && h('span', {}, card.editor_names),
    card.counts_as > 1 && h('span', {}, `counts as ${card.counts_as}`),
    safeUrl(card.posted_link) && h('a', { class: 'link', href: card.posted_link, target: '_blank', rel: 'noopener' }, 'View post', icon('out')),
    safeUrl(card.notion_url) && h('a', { class: 'link', href: card.notion_url, target: '_blank', rel: 'noopener' }, 'Notion', icon('out')),
  ], [watchButton(card)]);

  return h('div', {}, topbar(),
    page(
      h('div', { class: 'page-head' },
        h('div', {},
          h('h1', { class: 'title' }, c.name),
          h('p', { class: 'sub' }, `${c.in_production} in production`, c.overdue ? `, ${c.overdue} overdue` : '')),
        h('a', { class: 'btn', href: `/client/${c.slug}/preview`, onclick: nav(`/client/${c.slug}/preview`) }, 'See what they see', icon('out'))),

      h('section', { class: 'stats', 'aria-label': c.name },
        headline(c),
        stat('Needs your review', c.needs_review, 'before the client sees it', true),
        stat('Ready to post', c.ready, c.needs_approval ? `${c.needs_approval} more with the client` : 'finished, not out yet')),

      h('div', { class: 'cols' },
        panel('Posted per day', 'Last 30 days', postedChart(b.daily)),
        packagePanel(c)),

      postsPanel(b.posts),

      panel('Pipeline', 'Every video in production, by stage. Click one to open it in Notion',
        h('div', { class: 'board' }, STAGES.map(column))),

      panel('Posted', 'Most recent first', list(b.posted, postedRow, 'Nothing posted yet')),
      panel('Activity', `Every change logged for ${c.name}`, list(b.events, (e) => eventRow(e, b.timezone), 'Changes show up here as cards move in Notion'))));
}

// ---------- flow ----------

function route() {
  return location.pathname.replace(/\/+$/, '') || '/';
}
// Changing page: what is on screen fades out while the next page's data loads, then the new page fades in.
let leaving = false;
async function go(path) {
  if (state.stale) return location.assign(path); // the portal was updated: load the new version on the way
  history.pushState(null, '', path);
  Object.assign(state, { form: null, sendBack: null, invite: null, settings: null, undo: null, newKey: null, entered: false });
  const fresh = state.user?.role === 'admin' && path.startsWith('/client/');
  if (fresh) Object.assign(state, { board: null, client: null });
  leaving = true;
  const loaded = load();
  if (!reduced()) {
    app.classList.add('is-leaving');
    await wait(140);
    app.classList.remove('is-leaving');
  }
  window.scrollTo(0, 0);
  if (fresh) render(); // the page's outline straight away, its numbers the moment they land
  await loaded;
  leaving = false;
  render();
}
function nav(path) {
  return (e) => {
    e.preventDefault();
    go(path);
  };
}
window.addEventListener('popstate', () => {
  state.entered = false;
  load().then(render);
});

// Fetch what the current screen needs.
async function load() {
  const u = state.user;
  if (!u) return;
  const r = route();
  try {
    if (u.role === 'admin') {
      const preview = /^\/client\/([\w-]+)\/preview$/.exec(r);
      const board = /^\/client\/([\w-]+)$/.exec(r);
      if (preview) state.client = await api(`/client/overview?client=${encodeURIComponent(preview[1])}`);
      else if (board) state.board = await api(`/admin/clients/${encodeURIComponent(board[1])}/board`);
      else if (r === '/people') {
        state.people = await api('/admin/users');
        state.clientList = (await api('/admin/clients')).clients;
        state.keys = (await api('/admin/api-keys')).keys;
      } else if (r === '/clients') {
        // The cards need both the settings rows and the counted numbers.
        [state.clientList, state.overview] = await Promise.all([api('/admin/clients').then((x) => x.clients), api('/admin/overview')]);
        if (state.channels === undefined) state.channels = await api('/admin/slack/channels').then((x) => x.channels, () => null);
      } else state.overview = await api('/admin/overview');
    } else if (u.role === 'client') state.client = await api('/client/overview');
    else state.editor = await api('/editor/overview');
    state.offline = false;
    tries = 0;
  } catch (err) {
    if (err.status === 401) state.user = null;
    else if (down(err)) retrySoon();
    else toast(err.message);
  }
}
const refresh = load;

// The portal restarts for about half a minute when it is updated. Instead of a blank page, keep trying
// quietly and say what is happening.
function down(err) { return err.status === undefined || err.status >= 502; }
let tries = 0;
let retryTimer;
function retrySoon() {
  state.offline = true;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    await load();
    render();
  }, Math.min(1500 * 2 ** tries++, 8000));
}

// What shows while a page's numbers are on their way: the shape of the page, not an empty screen.
function loadingView() {
  return h('div', {}, topbar(),
    h('main', { class: 'page skeleton' },
      h('p', { class: 'sub' }, state.offline ? 'The portal is restarting. Back in a moment' : ''),
      h('div', { class: 'stats' }, [0, 1, 2, 3].map(() => h('div', { class: 'stat glass sk' }))),
      h('div', { class: 'panel glass sk sk-tall' })));
}

function render() {
  const invite = /^\/invite\/([\w-]+)/.exec(location.pathname);
  const u = state.user;
  const r = route();
  let bg = u ? u.background : '/bg/default.mp4';
  let view;
  if (!u) view = invite ? inviteView(invite[1]) : loginView();
  else if (u.role === 'admin') {
    if (/^\/client\/[\w-]+\/preview$/.test(r) && state.client) {
      view = clientView(state.client, true);
      bg = state.client.client.background || bg;
    } else if (/^\/client\/[\w-]+$/.test(r) && state.board) {
      view = boardView(state.board);
      bg = state.board.background || bg;
    } else if (r === '/people' && state.people) view = peopleView();
    else if (r === '/clients' && state.clientList) view = clientsView();
    else if (r === '/' && state.overview) view = adminView(state.overview);
  } else if (u.role === 'client' && state.client) view = clientView(state.client);
  else if (u.role === 'editor' && state.editor) view = editorView(state.editor);
  // Charts pick up a colour from the client's own picture.
  const who = /^\/client\/([\w-]+)/.exec(r)?.[1] || (u?.role === 'client' && state.client?.client.slug) || '';
  document.documentElement.style.setProperty('--tint', TINTS[who] || TINTS.default);
  setBackdrop(bg);
  app.replaceChildren(view || (u ? loadingView() : h('div', {})));
}

async function start() {
  if (state.user) render();
  await load();
  render();
}

// Show the last picture straight away, before the first answer from the server.
try { setBackdrop(localStorage.getItem('ody_bg') || '/bg/default.mp4'); } catch { setBackdrop('/bg/default.mp4'); }
// If the portal is mid-restart when the page opens, wait for it instead of showing the sign-in screen.
for (;;) {
  try {
    state.user = (await api('/me')).user;
    break;
  } catch (err) {
    if (!down(err)) {
      state.user = null;
      break;
    }
    app.replaceChildren(h('div', { class: 'boot' }, 'The portal is restarting. Back in a moment'));
    await wait(2000);
  }
}
await start();

// Keep the numbers fresh without interrupting someone who is typing or filling in a form, and pick up a
// new version of the portal by itself once one is out.
async function tick() {
  if (!state.user || leaving || document.hidden) return;
  const typing = state.sendBack || state.form || state.settings || state.busy.size;
  if (state.stale && !typing) return location.reload();
  if (typing) return;
  if (['/people', '/clients'].includes(route())) return void api('/health').catch(() => {});
  await load();
  render();
}
setInterval(tick, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.user) api('/health').then(tick, () => {});
});
