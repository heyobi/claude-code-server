/* Web client for claude-code-server.
 *
 * It reads the session transcript rather than a relay, which is the whole
 * reason it exists: every turn is there, labelled with the model that produced
 * it, so switching backend mid conversation leaves no hole in what you see.
 */

const $ = (id) => document.getElementById(id);
const store = {
  get token() { try { return localStorage.getItem('ccs.token') || ''; } catch { return ''; } },
  set token(v) { try { localStorage.setItem('ccs.token', v); } catch {} },
  get session() { try { return localStorage.getItem('ccs.session') || ''; } catch { return ''; } },
  set session(v) { try { localStorage.setItem('ccs.session', v); } catch {} },
};

let TOKEN = store.token;
let session = store.session;
let offset = 0;
let stream = null;
let known = { sessions: [], profiles: [] };
let seen = new Set();

/* ------------------------------------------------------------------ api */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + TOKEN,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) { gate('Anahtar kabul edilmedi.'); throw new Error('401'); }
  if (!res.ok) throw new Error(await res.text());
  // An authenticating proxy in front of us answers an expired session with its
  // own login page, not with our JSON. Reloading hands the browser to it.
  const kind = res.headers.get('content-type') || '';
  if (!kind.includes('json')) { location.reload(); throw new Error('auth'); }
  return res.json();
}

const post = (path, body) =>
  api(path, { method: 'POST', body: JSON.stringify(body) });

/* ------------------------------------------------------------ rendering */

// Deliberately small: fenced blocks, inline code, bold. Anything cleverer
// starts fighting with the text the model actually wrote.
function render(text) {
  const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const blocks = text.split(/```/);
  return blocks.map((part, i) => {
    if (i % 2) return '<pre>' + escape(part.replace(/^[a-z]*\n/i, '')) + '</pre>';
    return escape(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }).join('');
}

function modelLabel(model) {
  if (!model) return '';
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function addTurn(turn) {
  if (turn.id && seen.has(turn.id)) return;
  if (turn.id) seen.add(turn.id);
  const wrap = document.createElement('div');
  wrap.className = 'turn ' + turn.role;
  const time = turn.ts ? new Date(turn.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const label = turn.role === 'assistant' ? modelLabel(turn.model) : '';
  wrap.innerHTML =
    '<div class="bubble">' + render(turn.text) + '</div>' +
    '<div class="meta">' + [label, time].filter(Boolean).join(' · ') + '</div>';
  $('stream').appendChild(wrap);
}

function note(text) {
  const el = document.createElement('div');
  el.className = 'note';
  el.textContent = text;
  $('stream').appendChild(el);
}

function toBottom(force) {
  const el = $('stream');
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 250;
  if (force || near) el.scrollTop = el.scrollHeight;
}

function setStatus(ready, profile) {
  const dot = document.querySelector('#sub .dot');
  dot.className = 'dot' + (ready === null ? ' off' : ready ? '' : ' busy');
  $('statusText').textContent =
    (profile && profile !== '-' ? profile + ' · ' : 'Claude · ') +
    (ready === null ? 'bağlanıyor…' : ready ? 'hazır' : 'yazıyor…');
  $('send').disabled = ready === false;
}

/* ----------------------------------------------------------- permissions */

let askEl = null;
function showAsk(prompt) {
  if (askEl) { askEl.remove(); askEl = null; }
  if (!prompt || !prompt.options) return;
  askEl = document.createElement('div');
  askEl.className = 'ask';
  askEl.innerHTML = '<h4>🔓 ' + prompt.question.replace(/[<>&]/g, '') + '</h4>';
  prompt.options.forEach((opt) => {
    const b = document.createElement('button');
    b.textContent = opt.key + '. ' + opt.label;
    b.onclick = () => {
      post('/api/permission', { session, key: opt.key }).catch(() => {});
      askEl.remove(); askEl = null;
    };
    askEl.appendChild(b);
  });
  $('stream').appendChild(askEl);
  toBottom(true);
}

/* ---------------------------------------------------------------- stream */

function listen() {
  if (stream) stream.close();
  const url = '/api/events?session=' + encodeURIComponent(session) +
              '&offset=' + offset + '&token=' + encodeURIComponent(TOKEN);
  stream = new EventSource(url);
  stream.addEventListener('turn', (e) => {
    const turn = JSON.parse(e.data);
    offset = turn.offset || offset;
    addTurn(turn);
    toBottom();
  });
  stream.addEventListener('status', (e) => {
    const s = JSON.parse(e.data);
    setStatus(s.ready, s.profile);
  });
  stream.addEventListener('permission', (e) => {
    const p = JSON.parse(e.data);
    showAsk(p && p.options ? p : null);
  });
  stream.addEventListener('reload', () => { stream.close(); openSession(session); });
  // EventSource reconnects by itself; nothing to do on error but say so.
  stream.onerror = () => setStatus(null, null);
}

/* ----------------------------------------------------------------- views */

async function refresh() {
  known = await api('/api/state');
  if (!known.sessions.length) { $('name').textContent = 'oturum yok'; return; }
  if (!known.sessions.some((s) => s.name === session)) {
    session = known.sessions[0].name;
  }
}

async function openSession(name) {
  session = name;
  store.session = name;
  seen = new Set();
  $('stream').innerHTML = '';
  $('name').textContent = name;
  setStatus(null, null);
  const data = await api('/api/history?session=' + encodeURIComponent(name));
  offset = data.offset;
  if (!data.turns.length) note('Bu oturum henüz konuşmadı.');
  data.turns.forEach(addTurn);
  setStatus(data.ready, data.profile);
  toBottom(true);
  listen();
}

/* ----------------------------------------------------------------- sheet */

function sheet(title, build) {
  const box = $('sheet');
  box.innerHTML = '<h3>' + title + '</h3>';
  build(box);
  $('veil').classList.add('open');
}
const closeSheet = () => $('veil').classList.remove('open');

function button(parent, label, sub, on, active) {
  const b = document.createElement('button');
  b.className = 'row' + (active ? ' on' : '');
  b.innerHTML = '<span class="grow">' + label +
                (sub ? '<small>' + sub + '</small>' : '') + '</span>' +
                (active ? '<span>✓</span>' : '');
  b.onclick = on;
  parent.appendChild(b);
  return b;
}

async function sessionSheet() {
  await refresh();
  sheet('Oturumlar', (box) => {
    known.sessions.forEach((s) => {
      button(box, s.name, (s.profile === '-' ? 'Claude' : s.profile) +
             (s.ready ? '' : ' · çalışıyor'),
        () => { closeSheet(); openSession(s.name); }, s.name === session);
    });
  });
}

async function menuSheet() {
  await refresh();
  sheet('Menü', (box) => {
    const grid = document.createElement('div');
    grid.className = 'grid';
    box.appendChild(grid);
    button(grid, '🧠 Model', null, () => modelSheet());
    button(grid, '🗂 Oturumlar', null, () => sessionSheet());
    button(grid, '➕ Yeni oturum', null, async () => {
      closeSheet();
      const r = await post('/api/session', { action: 'new' });
      if (r.session) openSession(r.session);
    });
    button(grid, '❌ Kapat', null, () => confirmSheet());
    pushState().then((state) => {
      button(grid, '🔔 Bildirim', state, async () => {
        closeSheet();
        try { await togglePush(); } catch (e) { note('Bildirim kurulamadi: ' + e); }
        toBottom(true);
      }, state === 'acik');
    });
  });
}

function confirmSheet() {
  sheet(session + ' kapatılsın mı?', (box) => {
    button(box, '✔ Evet, kapat', null, async () => {
      closeSheet();
      await post('/api/session', { action: 'close', session });
      await refresh();
      if (known.sessions.length) openSession(known.sessions[0].name);
    });
    button(box, '✖ Vazgeç', null, closeSheet);
  });
}

async function modelSheet() {
  await refresh();
  const current = (known.sessions.find((s) => s.name === session) || {}).profile || '-';
  sheet('Sağlayıcı', (box) => {
    known.profiles.forEach((p) => {
      button(box, p.label, p.models.length + ' model',
        () => pickModel(p), p.profile === current);
    });
  });
}

function pickModel(provider) {
  sheet(provider.label + ' — model', (box) => {
    provider.models.forEach((m) => {
      button(box, m || 'Varsayılan', null, async () => {
        closeSheet();
        note('Model değiştiriliyor, oturum yeniden başlıyor…');
        toBottom(true);
        await post('/api/profile', { session, profile: provider.profile, model: m });
      });
    });
    button(box, '◀ Geri', null, () => modelSheet());
  });
}

/* ------------------------------------------------------------ notifications */

function keyBytes(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Says why, not just whether. On iOS every one of these can be the answer,
// and they all look identical from the outside: nothing happens.
async function pushState() {
  try {
    if (!window.isSecureContext) return 'guvenli baglam yok';
    if (!('serviceWorker' in navigator)) return 'sw destegi yok';
    if (!('PushManager' in window)) return 'ana ekrana ekle';
    if (typeof Notification === 'undefined') return 'ana ekrana ekle';
    if (Notification.permission === 'denied') return 'engelli';
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return 'sw kayitli degil';
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'acik' : 'kapali';
  } catch (e) {
    return 'hata: ' + (e && e.name);
  }
}

async function togglePush() {
  if (!('PushManager' in window) || typeof Notification === 'undefined') {
    note('Bildirim bu baglamda yok. iOS: Paylas > Ana Ekrana Ekle, sonra uygulamadan ac.');
    return;
  }
  // Safari only honours a permission request inside the tap that caused it.
  // An await first — even one that resolves immediately — spends the gesture,
  // and the prompt then never appears and never errors either.
  const permission = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission;
  if (permission !== 'granted') {
    note('Izin verilmedi (' + permission + '). Ayarlar > Bildirimler.');
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await post('/api/push/unsubscribe', { endpoint: existing.endpoint });
    await existing.unsubscribe();
    note('Bildirimler kapatildi.');
    return;
  }
  const { key } = await api('/api/push/key');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(key),
  });
  await post('/api/push/subscribe', sub.toJSON());
  note('Bildirimler acildi.');
}

/* ------------------------------------------------------------------ boot */

function gate(message) {
  $('app').classList.add('hide');
  $('gate').classList.remove('hide');
  $('gateErr').textContent = message || '';
}

async function boot() {
  if (!TOKEN) return gate('');
  try {
    await refresh();
  } catch {
    return;                       // gate() already ran on 401
  }
  document.title = known.app || document.title;
  const brand = $('brand');
  if (brand && known.app) brand.textContent = known.app;
  $('gate').classList.add('hide');
  $('app').classList.remove('hide');
  const asked = new URLSearchParams(location.search).get('session');
  const wanted = known.sessions.some((s) => s.name === asked) ? asked : null;
  if (known.sessions.length) openSession(wanted || session || known.sessions[0].name);
}

$('tokenSave').onclick = () => {
  TOKEN = $('tokenInput').value.trim();
  store.token = TOKEN;
  boot();
};

$('btnSessions').onclick = sessionSheet;
$('btnMenu').onclick = menuSheet;
$('veil').onclick = (e) => { if (e.target === $('veil')) closeSheet(); };

const text = $('text');
text.addEventListener('input', () => {
  text.style.height = 'auto';
  text.style.height = Math.min(text.scrollHeight, 130) + 'px';
});
text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
});

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const body = text.value.trim();
  if (!body || !session) return;
  text.value = '';
  text.style.height = 'auto';
  try {
    await post('/api/message', { session, text: body });
  } catch {
    note('Gönderilemedi — oturum meşgul olabilir.');
  }
  toBottom(true);
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Tapping a notification while the app is already open should move it to
  // the session the notification came from, not just raise the window.
  navigator.serviceWorker.addEventListener('message', (event) => {
    const wanted = (event.data || {}).open;
    if (wanted && wanted !== session) openSession(wanted);
  });
}

boot();
