// Odyssey Portal web app. Plain modules, no build step.
// Everything that comes from Notion or a person is written as text, never as HTML.

const app = document.getElementById('app');
const state = { user: null, overview: null, client: null, editor: null, people: null, clientList: null, channels: undefined,
  sendBack: null, form: null, invite: null, busy: new Set(), entered: false };

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
          Object.assign(state, { user: null, overview: null, client: null, editor: null, people: null, clientList: null, invite: null, form: null });
          history.replaceState(null, '', '/');
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
      h('a', { class: 'client-name', href: `/client/${c.slug}`, title: 'See their portal', onclick: nav(`/client/${c.slug}`) }, c.name),
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
  const p = o.package;
  const range = p && (p.max && p.max !== p.size ? `${p.size} to ${p.max}` : `${p.size}`);
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

  return h('div', {},
    topbar(preview && h('span', { class: 'sync' }, h('i', { class: 'dot dot-wait' }), `What ${o.client.name} sees`)),
    page(
      h('div', { class: 'page-head' }, h('div', {},
        h('h1', { class: 'title' }, o.client.name),
        h('p', { class: 'sub' }, p ? `${p.delivered} of ${range} posted this period, ${plural(p.days_left, 'day')} left` : `${plural(o.in_production, 'video')} in production`))),
      h('section', { class: 'stats', 'aria-label': 'Your videos' },
        stat('Needs your approval', o.needs_approval.length, 'watch, then approve or ask for changes', true),
        stat('Being reworked', o.changes_requested.length, 'changes you asked for'),
        stat('Ready to post', o.ready.length, 'approved and waiting to go out'),
        stat('In production', o.in_production, 'scripting, filming or editing')),
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
      h('div', { class: 'page-head' }, h('div', {},
        h('h1', { class: 'title' }, 'People'),
        h('p', { class: 'sub' }, 'Founders see everything. Editors see their own queue. Clients see their own videos'))),
      panel('Add someone', 'They get a link and choose their own password', add),
      panel('Everyone with a login', null, h('div', { class: 'rows' }, users.map(personRow)))));
}

// ---------- admin: clients ----------

function clientsView() {
  const channels = state.channels;
  const num = (name, value, extra = {}) => h('input', { class: 'input input-sm', name, type: 'number', min: 0, value: value ?? '', ...extra });
  const row = (c) => h('form', { class: 'row client-form',
    onsubmit: (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const day = Number(f.day);
      send(() => api(`/admin/clients/${c.id}`, { method: 'PATCH', body: {
        package_size: f.package_size, package_max: f.package_max || f.package_size, count_multiplier: Number(f.count_multiplier) || 1,
        period_anchor: day >= 1 && day <= 31 ? `2026-01-${pad(day)}` : null,
        ...(channels ? { slack_channel_id: f.slack_channel_id || null } : {}),
      } }), `${c.name} saved`);
    } },
    h('div', {},
      h('div', { class: 'client-name' }, c.name),
      h('a', { class: 'link', href: `/client/${c.slug}`, onclick: nav(`/client/${c.slug}`) }, 'See their portal', icon('out'))),
    field('Package from', num('package_size', c.package_size)),
    field('to', num('package_max', c.package_max)),
    field('Counts as', num('count_multiplier', c.count_multiplier, { min: 0.5, max: 20, step: 0.5 })),
    field('Starts on day', num('day', c.period_anchor ? Number(c.period_anchor.slice(8, 10)) : '', { min: 1, max: 31, placeholder: '1' })),
    field('Slack channel', channels
      ? h('select', { class: 'input input-sm', name: 'slack_channel_id' },
        h('option', { value: '' }, 'Not linked'),
        channels.map((ch) => h('option', { value: ch.id, selected: ch.id === c.slack_channel_id }, `#${ch.name}${ch.member ? '' : ' (invite the bot first)'}`)))
      : h('input', { class: 'input input-sm', disabled: true, value: 'Slack is not connected' })),
    h('button', { class: 'btn', type: 'submit' }, 'Save'));

  const add = h('form', { class: 'form-grid',
    onsubmit: (e) => {
      e.preventDefault();
      send(() => api('/admin/clients', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }), 'Client added. Their board syncs within a minute');
    } },
    field('Client name', h('input', { class: 'input input-sm', name: 'name', autocomplete: 'off', required: true })),
    field('Link to their Notion board', h('input', { class: 'input input-sm', name: 'notion', type: 'url', autocomplete: 'off', required: true })),
    h('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus'), 'Add client'));

  return h('div', {}, topbar(),
    page(
      h('div', { class: 'page-head' }, h('div', {},
        h('h1', { class: 'title' }, 'Clients'),
        h('p', { class: 'sub' }, 'Package size, how posts are counted, and which Slack channel to watch'))),
      panel('Your clients', 'Posted videos count toward the package', h('div', { class: 'rows' }, state.clientList.map(row))),
      panel('Add a client', 'Share their board with the Odyssey Portal connection in Notion first', add)));
}

// ---------- flow ----------

function route() {
  return location.pathname.replace(/\/+$/, '') || '/';
}
function go(path) {
  history.pushState(null, '', path);
  Object.assign(state, { form: null, sendBack: null, invite: null });
  load().then(render);
}
function nav(path) {
  return (e) => {
    e.preventDefault();
    go(path);
  };
}
window.addEventListener('popstate', () => load().then(render));

// Fetch what the current screen needs.
async function load() {
  const u = state.user;
  if (!u) return;
  const r = route();
  try {
    if (u.role === 'admin') {
      const preview = /^\/client\/([\w-]+)$/.exec(r);
      if (preview) state.client = await api(`/client/overview?client=${encodeURIComponent(preview[1])}`);
      else if (r === '/people') {
        state.people = await api('/admin/users');
        state.clientList = (await api('/admin/clients')).clients;
      } else if (r === '/clients') {
        state.clientList = (await api('/admin/clients')).clients;
        if (state.channels === undefined) state.channels = await api('/admin/slack/channels').then((x) => x.channels, () => null);
      } else state.overview = await api('/admin/overview');
    } else if (u.role === 'client') state.client = await api('/client/overview');
    else state.editor = await api('/editor/overview');
  } catch (err) {
    if (err.status === 401) state.user = null;
    else toast(err.message);
  }
}
const refresh = load;

function render() {
  const invite = /^\/invite\/([\w-]+)/.exec(location.pathname);
  const u = state.user;
  const r = route();
  let bg = u ? u.background : '/bg/default.mp4';
  let view;
  if (!u) view = invite ? inviteView(invite[1]) : loginView();
  else if (u.role === 'admin') {
    if (r.startsWith('/client/') && state.client) {
      view = clientView(state.client, true);
      bg = state.client.client.background || bg;
    } else if (r === '/people' && state.people) view = peopleView();
    else if (r === '/clients' && state.clientList) view = clientsView();
    else if (r === '/' && state.overview) view = adminView(state.overview);
  } else if (u.role === 'client' && state.client) view = clientView(state.client);
  else if (u.role === 'editor' && state.editor) view = editorView(state.editor);
  setBackdrop(bg);
  app.replaceChildren(view || h('div', {}, topbar()));
}

async function start() {
  await load();
  render();
}

try {
  state.user = (await api('/me')).user;
} catch {
  state.user = null;
}
await start();

// Keep the numbers fresh without interrupting someone who is typing or filling in a form.
setInterval(async () => {
  if (!state.user || state.sendBack || state.form || state.busy.size || document.hidden || ['/people', '/clients'].includes(route())) return;
  await load();
  render();
}, 60_000);
