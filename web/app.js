// Odyssey Portal web app. Plain modules, no build step.
// Everything that comes from Notion or a person is written as text, never as HTML.

const app = document.getElementById('app');
const state = { user: null, overview: null, sendBack: null, busy: new Set(), entered: false };

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

function setBackdrop(url) {
  const el = document.getElementById('backdrop');
  const src = safeUrl(url) || (String(url || '').startsWith('/bg/') ? url : null);
  if (el.dataset.src === (src || '')) return;
  el.dataset.src = src || '';
  el.replaceChildren();
  if (!src) return;
  if (/\.(mp4|webm|mov)(\?|$)/i.test(src)) {
    // A still of the same name shows while the video loads.
    const v = h('video', { src, poster: src.replace(/\.\w+(\?.*)?$/, '.jpg'), autoplay: true, loop: true, playsinline: true, preload: 'auto' });
    v.muted = true;
    el.append(v);
  } else {
    el.append(h('img', { src, alt: '' }));
  }
}

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
      h('h1', {}, 'Every video, and who it is waiting on'),
      h('p', {}, 'The production portal for Odyssey Digital, its editors and its clients')),
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
      h('div', { class: 'spacer' }),
      right,
      h('span', { class: 'who' }, state.user.name || state.user.email),
      h('button', { class: 'btn btn-quiet', type: 'button', 'aria-label': 'Sign out', title: 'Sign out',
        onclick: async () => {
          await api('/auth/logout', { method: 'POST' }).catch(() => {});
          state.user = null;
          state.overview = null;
          render();
        } }, icon('leave'))));
}

function page(...sections) {
  const el = h('main', { class: state.entered ? 'page' : 'page enter' }, sections);
  state.entered = true;
  return el;
}

// ---------- admin ----------

const STAGES = ['Idea', 'Scripting', 'Filming', 'Ready to Edit', 'Editing', 'Revisions', 'Review', 'Ready'];
const slug = (s) => s.toLowerCase().replace(/\s+/g, '-');

function stat(label, figure, note, waiting) {
  return h('div', { class: `stat glass${waiting && figure > 0 ? ' is-waiting' : ''}` },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-figure' }, pad(figure)),
    h('div', { class: 'stat-note' }, note));
}

async function act(key, fn) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  render();
  try {
    await fn();
    state.sendBack = null;
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

function track(byStatus) {
  const live = STAGES.filter((s) => byStatus[s]);
  if (!live.length) return h('div', {}, h('div', { class: 'track is-empty' }), h('div', { class: 'legend' }, 'Nothing in production'));
  const bar = h('div', { class: 'track', role: 'img', 'aria-label': live.map((s) => `${sentence(s)} ${byStatus[s]}`).join(', ') });
  for (const s of live) {
    const seg = h('span', { class: `seg seg-${slug(s)}`, title: `${sentence(s)}: ${byStatus[s]}` });
    seg.style.flexGrow = String(byStatus[s]);
    bar.append(seg);
  }
  return h('div', {}, bar,
    h('div', { class: 'legend' }, live.map((s) =>
      h('span', { class: `legend-item${s === 'Review' ? ' is-accent' : ''}` }, h('i', { class: `seg seg-${slug(s)}` }), sentence(s), h('b', {}, byStatus[s])))));
}

function packageCell(p, countsAs) {
  if (!p.size) return h('div', { class: 'package' }, h('div', { class: 'small' }, 'No package set'));
  const range = p.max && p.max !== p.size ? `${p.size} to ${p.max}` : `${p.size}`;
  const pace = p.pace === 'behind' ? h('span', { class: 'pace-behind' }, `${p.expected - p.delivered} behind pace`)
    : p.pace === 'complete' ? h('span', { class: 'pace-ok' }, 'Package met')
    : h('span', { class: 'pace-ok' }, 'On pace');
  const fill = h('i');
  fill.style.width = `${Math.min(100, (p.delivered / p.size) * 100)}%`;
  return h('div', { class: 'package' },
    h('div', { class: 'package-line' }, h('strong', {}, p.delivered), ` of ${range} posted`),
    h('div', { class: 'bar' }, fill),
    h('div', { class: 'small' }, pace, `, ${plural(p.days_left, 'day')} left`, countsAs > 1 ? `, counts ×${countsAs}` : ''));
}

function clientRow(c) {
  const waiting = c.slack?.waiting;
  return h('div', { class: 'row client' },
    h('div', {},
      h('div', { class: 'client-name' }, c.name),
      h('div', { class: 'small' }, c.synced ? `${c.in_production} in production` : 'Not synced yet',
        c.overdue > 0 && h('span', { class: 'pace-behind' }, `, ${c.overdue} overdue`))),
    track(c.by_status),
    packageCell(c.package, c.counts_as),
    h('div', {},
      h('div', {}, h('strong', { class: 'client-name' }, c.ready), ' ready to post'),
      h('div', { class: 'small' }, !c.ready ? 'Nothing banked' : c.runway_days == null ? 'No posting pace yet' : `About ${plural(Math.max(1, Math.round(c.runway_days)), 'day')} banked`)),
    h('div', {},
      h('div', {}, c.needs_approval ? `${c.needs_approval} with the client` : 'Nothing with the client'),
      h('div', { class: 'small waiting' },
        c.slack ? h('i', { class: `dot ${waiting ? 'dot-wait' : 'dot-ok'}` }) : null,
        !c.slack ? 'Slack channel not linked'
          : c.slack.error ? 'Slack check failed'
          : waiting ? `${c.slack.last_from || 'Client'} waiting ${span(c.slack.waiting_since)}`
          : 'Slack answered')));
}

function eventRow(e, tz) {
  const today = new Date(e.at).toDateString() === new Date().toDateString();
  const what = e.field === 'status' ? [h('span', {}, `${sentence(e.from_value) || 'New'} to `), sentence(e.to_value)]
    : e.field === 'approval' ? [h('span', {}, 'Approval: '), e.to_value || 'cleared']
    : e.field === 'editor' ? [h('span', {}, 'Editor: '), e.to_value || 'unassigned']
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
  const total = o.clients.reduce((n, c) => n + c.total, 0);
  const sync = o.last_sync;
  const reviewers = o.reviewers.join(' or ');
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
          h('p', { class: 'sub' }, `${plural(total, 'video')} across ${plural(o.clients.length, 'client')}`, t.overdue ? `, ${t.overdue} overdue` : '')),
        h('button', { class: 'btn', type: 'button', disabled: syncing,
          onclick: () => act('sync', () => api('/admin/sync', { method: 'POST' })) }, icon('refresh'), syncing ? 'Syncing' : 'Sync now')),

      h('section', { class: 'stats', 'aria-label': 'Today' },
        stat('Needs review', t.needs_review, `from ${reviewers}`, true),
        stat('With clients', t.needs_approval, 'waiting for approval'),
        stat('Ready to post', t.ready, 'finished, not out yet'),
        stat('Posted', t.delivered_7d, `last 7 days, ${t.delivered_30d} in 30`)),

      h('div', { class: 'cols' },
        h('section', { class: 'panel glass' },
          h('div', { class: 'panel-head' }, h('h2', {}, `Needs review from ${reviewers}`), h('p', {}, 'Longest wait first')),
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
        h('div', { class: 'panel-head' }, h('h2', {}, 'Clients'), h('p', {}, 'Pipeline, package this period, and who is waiting')),
        h('div', { class: 'rows' }, o.clients.map(clientRow))),

      h('section', { class: 'panel glass' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Activity'), h('p', {}, 'Every change the portal has logged')),
        o.recent_events.length ? h('div', { class: 'rows' }, o.recent_events.map((e) => eventRow(e, tz)))
          : h('p', { class: 'empty' }, 'Changes show up here as cards move in Notion'))));
}

function soonView() {
  return h('div', {}, topbar(),
    page(h('div', { class: 'page-head' }, h('div', {},
      h('h1', { class: 'title' }, 'Almost ready'),
      h('p', { class: 'sub' }, 'Your view of the portal is being finished. Your login already works')))));
}

// ---------- flow ----------

function render() {
  const invite = /^\/invite\/([\w-]+)/.exec(location.pathname);
  setBackdrop(state.user ? state.user.background : '/bg/default.mp4');
  let view;
  if (!state.user) view = invite ? inviteView(invite[1]) : loginView();
  else if (state.user.role === 'admin') view = state.overview ? adminView(state.overview) : h('div', {}, topbar());
  else view = soonView();
  app.replaceChildren(view);
}

async function refresh() {
  if (state.user?.role !== 'admin') return;
  try {
    state.overview = await api('/admin/overview');
  } catch (err) {
    if (err.status === 401) state.user = null;
    else toast(err.message);
  }
}

async function start() {
  await refresh();
  render();
}

try {
  state.user = (await api('/me')).user;
} catch {
  state.user = null;
}
await start();

// Keep the numbers fresh without interrupting someone who is typing.
setInterval(async () => {
  if (!state.user || state.sendBack || state.busy.size || document.hidden) return;
  await refresh();
  render();
}, 60_000);
