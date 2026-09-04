/* Web client for claude-code-server.
 *
 * It reads the session transcript rather than a relay, which is the whole
 * reason it exists: every turn is there, labelled with the model that produced
 * it, so switching backend mid conversation leaves no hole in what you see.
 */

// Shown in the menu. When the phone is running something other than what the
// server has, that is worth being able to see rather than deduce.
const BUILD = 'v21';

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

// Enough markdown to read an answer by: fences, headings, lists, tables of the
// simple kind, and the inline marks. Deliberately not a full parser — the text
// is prose from a model, not a document, and a parser that tries too hard
// mangles the code in it.
function esc(text) {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function inline(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
             '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
             '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}

function render(text) {
  const out = [];
  const blocks = String(text).split(/```/);
  blocks.forEach((part, i) => {
    if (i % 2) {
      const nl = part.indexOf('\n');
      const lang = nl > 0 ? part.slice(0, nl).trim() : '';
      const code = nl > 0 ? part.slice(nl + 1) : part;
      out.push('<div class="code">' + (lang ? '<span class="lang">' + esc(lang) + '</span>' : '')
               + '<pre>' + esc(code.replace(/\n$/, '')) + '</pre></div>');
      return;
    }
    let list = null;
    let table = null;
    const flush = () => {
      if (list) { out.push('</' + list + '>'); list = null; }
      if (table) { out.push('</tbody></table></div>'); table = null; }
    };
    const lines = part.split('\n');
    lines.forEach((line, index) => {
      // A table is a run of pipe rows; the second is the alignment rule and is
      // not content. Detecting it needs the line after, so it happens here
      // rather than in the per-line branches below.
      const cells = line.trim().match(/^\|(.+)\|$/);
      if (cells) {
        const parts = cells[1].split('|').map((c) => c.trim());
        if (/^[\s|:-]+$/.test(line)) return;          // the rule
        if (!table) {
          if (list) flush();
          const next = (lines[index + 1] || '').trim();
          const isHead = /^\|[\s|:-]+\|$/.test(next);
          out.push('<div class="tablewrap"><table>');
          if (isHead) {
            out.push('<thead><tr>' +
              parts.map((c) => '<th>' + inline(c) + '</th>').join('') +
              '</tr></thead>');
          }
          out.push('<tbody>');
          table = true;
          if (isHead) return;
        }
        out.push('<tr>' + parts.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>');
        return;
      }
      if (table) flush();
      const head = line.match(/^(#{1,4})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const number = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const quote = line.match(/^>\s?(.*)$/);
      if (head) { flush(); out.push('<h' + (head[1].length + 2) + '>' + inline(head[2])
                                    + '</h' + (head[1].length + 2) + '>'); return; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); out.push('<hr>'); return; }
      if (bullet) {
        if (list !== 'ul') { flush(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + inline(bullet[1]) + '</li>'); return;
      }
      if (number) {
        if (list !== 'ol') { flush(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + inline(number[1]) + '</li>'); return;
      }
      flush();
      if (quote) { out.push('<blockquote>' + inline(quote[1]) + '</blockquote>'); return; }
      if (line.trim()) out.push('<p>' + inline(line) + '</p>');
    });
    flush();
  });
  return out.join('');
}

function modelLabel(model) {
  if (!model) return '';
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function addTurn(turn) {
  if (turn.id && seen.has(turn.id)) return;
  if (turn.id) seen.add(turn.id);
  if (turn.role === 'tool') return addTool(turn);
  if (turn.role === 'result') return addResult(turn);
  // Anything a person or the model says ends the run of tools before it.
  runEl = null;
  const wrap = document.createElement('div');
  wrap.className = 'turn ' + turn.role;
  const time = turn.ts ? new Date(turn.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const label = turn.role === 'assistant' ? modelLabel(turn.model) : '';
  wrap.innerHTML =
    '<div class="bubble">' + render(turn.text) + '</div>' +
    '<div class="meta">' + [label, time].filter(Boolean).join(' · ') + '</div>';
  const shots = pictures(turn.text);
  if (shots) wrap.insertBefore(shots, wrap.firstElementChild);
  const bar = attachments(turn.text);
  if (bar) wrap.insertBefore(bar, wrap.lastElementChild);
  $('stream').appendChild(wrap);
}

let liveEl = null;

// The answer as it is being written. Replaced by the real turn when that lands,
// so this never becomes the record of anything — it is a window, not a log.
function showLive(text, status) {
  if (!text && !status) {
    if (liveEl) { liveEl.remove(); liveEl = null; }
    return;
  }
  if (!liveEl) {
    liveEl = document.createElement('div');
    liveEl.className = 'turn assistant live';
    liveEl.innerHTML = '<div class="bubble"></div><div class="meta"></div>';
    $('stream').appendChild(liveEl);
  }
  liveEl.querySelector('.bubble').innerHTML =
    render(text) + '<span class="caret"></span>';
  liveEl.querySelector('.meta').textContent = status || 'yazıyor…';
  toBottom();
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
    showLive('', '');
    addTurn(turn);
    toBottom();
  });
  stream.addEventListener('partial', (e) => {
    const live = JSON.parse(e.data);
    showLive(live.text || '', live.status || '');
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
  liveEl = null;
  runEl = null;
  tools.clear();
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
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'shead';
  const shut = document.createElement('button');
  shut.className = 'icon';
  shut.textContent = '✕';
  shut.onclick = closeSheet;
  const name = document.createElement('h3');
  name.textContent = title;
  const pad = document.createElement('span');
  pad.className = 'spacer';
  head.append(shut, name, pad);
  box.appendChild(head);
  build(box);
  $('veil').classList.add('open');
}

// Rows added to one of these share a surface; rows added straight to the sheet
// stand alone.
function group(parent) {
  const box = document.createElement('div');
  box.className = 'group';
  parent.appendChild(box);
  return box;
}
const closeSheet = () => $('veil').classList.remove('open');

function button(parent, label, sub, on, active) {
  const b = document.createElement('button');
  const solo = parent.id === 'sheet' ? ' solo' : '';
  b.className = 'row' + solo + (active ? ' on' : '');
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
    const list = group(box);
    known.sessions.forEach((s) => {
      button(list, s.name, (s.profile === '-' ? 'Claude' : s.profile) +
             (s.ready ? '' : ' · çalışıyor'),
        () => { closeSheet(); openSession(s.name); }, s.name === session);
    });
  });
}

/* ----------------------------------------------------------------- menu */

// A popover, not a sheet. A sheet is for choosing among many things; this is a
// short list of actions and it belongs next to the button that opened it.
function menuSheet() {
  const pop = $('pop');
  pop.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'group';
  pop.appendChild(list);
  const add = (label, on, sub) => button(list, label, sub || null, () => {
    closePop();
    on();
  });
  add('🧠 Model', () => modelSheet());
  add('🗂 Oturumlar', () => sessionSheet());
  add('⚡ Görevler', () => tasksSheet());
  add('📁 Dosyalar', () => filesSheet(''));
  add('➕ Yeni oturum', async () => {
    const r = await post('/api/session', { action: 'new' });
    if (r.session) openSession(r.session);
  });
  add('✏️ Yeniden adlandır', () => renameSheet());
  // Placed now so it keeps its position; the state arrives a moment later.
  const bell = add('🔔 Bildirim', () => togglePush(), 'bakılıyor…');
  pushState().then((state) => {
    const sub = bell.querySelector('small');
    if (sub) sub.textContent = state;
  }).catch(() => {});
  add('❌ Kapat', () => confirmSheet());
  $('popveil').classList.add('open');
}

const closePop = () => $('popveil').classList.remove('open');

async function menuSheetOld() {
  await refresh();
  sheet('Menü · ' + BUILD, (box) => {
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
    button(grid, '📁 Dosyalar', null, () => filesSheet(''));
    button(grid, '⚡ Görevler', null, () => tasksSheet());
    button(grid, '✏️ Yeniden adlandır', null, () => renameSheet());
    button(grid, '❌ Kapat', null, () => confirmSheet());
    // Rendered now, labelled later. Behind a promise it went missing entirely
    // the one time the state check threw, which is exactly when you need it.
    const bell = button(grid, '🔔 Bildirim', 'bakiliyor…', async () => {
      closeSheet();
      try { await togglePush(); } catch (e) { note('Bildirim kurulamadi: ' + e); }
      toBottom(true);
    });
    pushState().then((state) => {
      const sub = bell.querySelector('small');
      if (sub) sub.textContent = state;
      if (state === 'acik') bell.classList.add('on');
    }).catch(() => {});
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

// A list of model ids tells you nothing about which to pick. These are the
// distinctions that actually matter when choosing one.
const FAMILY = [
  [/opus/i,        'Karmaşık işler'],
  [/fable/i,       'En zor işler'],
  [/sonnet/i,      'Günlük işler için verimli'],
  [/haiku/i,       'Hızlı cevaplar'],
  [/gpt-oss/i,     'Açık ağırlıklı, farklı bir bakış'],
  [/pro/i,         'Karmaşık işler, daha yavaş'],
  [/flash-lite/i,  'En hızlı, en ucuz'],
  [/flash/i,       'Dengeli — çoğu iş için'],
];
const EFFORT = { high: 'yüksek çaba', medium: 'orta çaba', low: 'düşük çaba' };

function modelNote(id) {
  if (!id) return 'Sunucudaki ayar ne diyorsa';
  const hit = FAMILY.find(([re]) => re.test(id));
  const tail = (id.match(/-(high|medium|low)$/) || [])[1];
  return [hit && hit[1], tail && EFFORT[tail]].filter(Boolean).join(' · ') || id;
}

// "gemini-3.8-flash-medium" reads better as "Gemini 3.8 Flash".
function modelTitle(id) {
  if (!id) return 'Varsayılan';
  const parts = id
    .replace(/-(high|medium|low)$/, '')
    .replace(/-(\d{8}|latest|preview)$/g, '')
    // "opus-4-6" is one version number wearing a hyphen, not two words.
    .replace(/(\d)-(\d)/g, '$1.$2')
    .split('-');
  return parts
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

async function modelSheet() {
  await refresh();
  const current = (known.sessions.find((s) => s.name === session) || {}).profile || '-';
  const model = (known.sessions.find((s) => s.name === session) || {}).model || '';
  sheet('Model', (box) => {
    const list = group(box);
    known.profiles.forEach((p) => {
      button(list, p.label,
        p.profile === current ? 'Şu an kullanılıyor' : p.models.length + ' model',
        () => pickModel(p), p.profile === current);
    });
    const note = document.createElement('div');
    note.className = 'sublabel';
    note.textContent = 'Seçim oturumu yeniden başlatır, konuşma korunur';
    box.appendChild(note);
  });
}

function pickModel(provider) {
  sheet(provider.label, (box) => {
    const list = group(box);
    provider.models.forEach((m) => {
      button(list, modelTitle(m), modelNote(m), async () => {
        closeSheet();
        note('Model değiştiriliyor, oturum yeniden başlıyor…');
        toBottom(true);
        await post('/api/profile', { session, profile: provider.profile, model: m });
      });
    });
    button(box, '◀ Geri', null, () => modelSheet());
  });
}

/* ------------------------------------------------------------ attachments */

let tray = [];   // { path, kind, name } waiting to be sent

function paintTray() {
  const box = $('tray');
  box.innerHTML = '';
  box.classList.toggle('on', tray.length > 0);
  tray.forEach((item, index) => {
    const cell = document.createElement('div');
    cell.className = 'att' + (item.path ? '' : ' busy');
    cell.innerHTML = item.kind === 'image' && item.path
      ? '<img alt="">'
      : '<span class="name">' + (ICON[item.kind] || '📄') + ' ' + esc(item.name) + '</span>';
    const shot = cell.querySelector('img');
    if (shot) feed(shot, item.path, () => {
      cell.innerHTML = '<span class="name">🖼 ' + esc(item.name) + '</span>';
    });
    const drop = document.createElement('button');
    drop.className = 'drop';
    drop.type = 'button';
    drop.textContent = '✕';
    drop.onclick = () => { tray.splice(index, 1); paintTray(); };
    cell.appendChild(drop);
    box.appendChild(cell);
  });
}

async function takeFiles(files) {
  for (const file of files) {
    const item = { name: file.name, kind: kindOf(file.name), path: '' };
    tray.push(item);
    paintTray();
    try {
      const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN },
        body: file,
      });
      const info = await res.json();
      if (!info.path) throw new Error(info.error || 'upload');
      item.path = info.path;
      item.kind = info.kind || item.kind;
    } catch (e) {
      tray = tray.filter((x) => x !== item);
      note('Yüklenemedi: ' + file.name);
    }
    paintTray();
  }
}

/* ---------------------------------------------------------------- tools */

// What a call was actually about, in a few words. The first argument is almost
// always the answer; these are the ones where it is not.
const TOOL_ARG = {
  Bash: (i) => i.command,
  Read: (i) => i.file_path, Write: (i) => i.file_path, Edit: (i) => i.file_path,
  NotebookEdit: (i) => i.notebook_path,
  Grep: (i) => i.pattern, Glob: (i) => i.pattern,
  WebFetch: (i) => i.url, WebSearch: (i) => i.query,
  Task: (i) => i.description, Skill: (i) => i.skill,
};
const TOOL_ICON = {
  Bash: '❯_', Read: '📖', Write: '✏️', Edit: '✏️', Grep: '🔎', Glob: '🔎',
  WebFetch: '🌐', WebSearch: '🌐', Task: '🧩', Artifact: '🖼',
};

const tools = new Map();      // call id -> { name, input, output, error }
let runEl = null;             // the run currently being appended to

function toolBrief(name, input) {
  const pick = TOOL_ARG[name];
  const value = pick ? pick(input || {}) : Object.values(input || {})[0];
  return value == null ? '' : String(value).replace(/\s+/g, ' ').slice(0, 80);
}

// Consecutive calls collapse into one line. A turn that runs twenty of them
// should not push the answer off the screen.
function addTool(turn) {
  tools.set(turn.id, { name: turn.name, input: turn.input, output: '', error: false });
  if (!runEl) {
    // Captured, not looked up: runEl is reassigned on the next message, and a
    // handler that reads it later opens whatever run happens to be current.
    const el = document.createElement('button');
    el.className = 'toolrun glassy';
    el.dataset.ids = '';
    el.onclick = () => toolSheet(el.dataset.ids.split(',').filter(Boolean));
    $('stream').appendChild(el);
    runEl = el;
  }
  runEl.dataset.ids += (runEl.dataset.ids ? ',' : '') + turn.id;
  paintRun(runEl);
  toBottom();
}

function paintRun(el) {
  const ids = el.dataset.ids.split(',').filter(Boolean);
  const rows = ids.map((i) => tools.get(i)).filter(Boolean);
  const failed = rows.some((r) => r.error);
  const head = rows.length === 1
    ? (TOOL_ICON[rows[0].name] || '🔧') + ' ' + rows[0].name
    : '🔧 ' + rows.length + ' araç';
  const tail = rows.length === 1
    ? toolBrief(rows[0].name, rows[0].input)
    : [...new Set(rows.map((r) => r.name))].slice(0, 3).join(', ');
  el.innerHTML =
    '<span class="tname">' + esc(head) + (failed ? ' ⚠' : '') + '</span>' +
    '<span class="targ">' + esc(tail) + '</span>' +
    '<span class="tmore">›</span>';
}

function addResult(turn) {
  const row = tools.get(turn.for);
  if (!row) return;
  row.output = turn.text || '';
  row.error = !!turn.error;
  if (runEl && runEl.dataset.ids.split(',').includes(turn.for)) paintRun(runEl);
}

function toolSheet(ids) {
  sheet(ids.length === 1 ? tools.get(ids[0]).name : ids.length + ' araç', (box) => {
    ids.forEach((id) => {
      const row = tools.get(id);
      if (!row) return;
      const card = document.createElement('div');
      card.className = 'group toolcard';
      const arg = toolBrief(row.name, row.input);
      card.innerHTML =
        '<div class="thead">' + esc((TOOL_ICON[row.name] || '🔧') + ' ' + row.name) +
        (row.error ? ' <span class="terr">hata</span>' : '') + '</div>' +
        (arg ? '<div class="code"><pre>' + esc(fullArg(row)) + '</pre></div>' : '') +
        (row.output
          ? '<div class="tlabel">Çıktı</div><div class="code"><pre>' +
            esc(row.output.slice(0, 4000)) + '</pre></div>'
          : '<div class="tlabel">Çıktı yok</div>');
      box.appendChild(card);
    });
  });
}

function fullArg(row) {
  const pick = TOOL_ARG[row.name];
  if (pick) {
    const value = pick(row.input || {});
    if (value != null) return String(value);
  }
  return JSON.stringify(row.input || {}, null, 2);
}

/* ---------------------------------------------------------------- tasks */

// Sessions are the jobs. A busy one is running; the spinner already knows how
// long and how many tokens, so that is what the row says.
async function tasksSheet() {
  await refresh();
  const busy = known.sessions.filter((s) => !s.ready);
  const idle = known.sessions.filter((s) => s.ready);
  sheet('Görevler', (box) => {
    const running = document.createElement('div');
    running.className = 'sublabel';
    running.textContent = busy.length ? 'Çalışıyor' : 'Çalışan yok';
    box.appendChild(running);
    if (busy.length) {
      const list = group(box);
      busy.forEach((s) => {
        const row = button(list, '⚡ ' + s.name,
          [s.profile === '-' ? 'Claude' : s.profile, s.status].filter(Boolean).join(' · '),
          () => { closeSheet(); openSession(s.name); });
        const stop = document.createElement('span');
        stop.className = 'stop';
        stop.textContent = '■';
        stop.onclick = async (e) => {
          e.stopPropagation();
          await post('/api/session', { action: 'interrupt', session: s.name });
          tasksSheet();
        };
        row.appendChild(stop);
      });
    }
    const done = document.createElement('div');
    done.className = 'sublabel';
    done.textContent = 'Hazır ' + idle.length;
    box.appendChild(done);
    const list = group(box);
    idle.forEach((s) => {
      button(list, s.name, s.profile === '-' ? 'Claude' : s.profile,
        () => { closeSheet(); openSession(s.name); }, s.name === session);
    });
  });
}

async function renameSheet() {
  const wanted = prompt('Yeni ad', session);
  if (!wanted) return;
  closeSheet();
  const r = await post('/api/session', { action: 'rename', session, name: wanted });
  if (r.session) openSession(r.session);
}

/* --------------------------------------------------------------------- files */

// A path in an answer is usually something you want to look at. These are the
// extensions where that is true; anything else stays plain text.
const FILEISH = new RegExp(
  '(?:^|[\\s(`"\'>])(/?(?:[\\w.-]+/)*[\\w.-]+\\.' +
  '(?:png|jpe?g|gif|webp|svg|avif|mp3|wav|ogg|m4a|flac|mp4|webm|mov|pdf|html?' +
  '|md|csv|json|txt|log|py|js|ts|sh|ya?ml))(?=$|[\\s)`"\'.,:;])', 'gi');
const ARTIFACT = /https:\/\/claude\.ai\/code\/artifact\/[\w-]+/gi;

// An <img> or an <audio> cannot carry an Authorization header, so the token
// rides in the query the way it already does for the event stream.
function fileUrl(path, raw) {
  return '/api/file?path=' + encodeURIComponent(path) +
    (raw ? '&raw=1' : '') + '&token=' + encodeURIComponent(TOKEN);
}

// An <img src> cannot send a header, cannot report why it failed, and puts the
// token in a URL. Fetching gives all three back: the header goes, the blob is
// local, and a response that is not media says so instead of drawing a broken
// icon.
const blobs = new Map();

async function mediaUrl(path) {
  if (blobs.has(path)) return blobs.get(path);
  const res = await fetch('/api/file?path=' + encodeURIComponent(path),
                          { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  if (/^text\/html/.test(type)) throw new Error('oturum düşmüş, sayfayı yenile');
  const url = URL.createObjectURL(await res.blob());
  blobs.set(path, url);
  return url;
}

// Fills an element once the bytes are here, and puts the reason in its place
// if they never arrive.
function feed(el, path, onFail) {
  mediaUrl(path).then((url) => { el.src = url; }).catch((e) => {
    if (onFail) onFail(String(e.message || e));
    else el.replaceWith(Object.assign(document.createElement('div'),
      { className: 'mediafail', textContent: path + ' — ' + (e.message || e) }));
  });
}

function kindOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png','jpg','jpeg','gif','webp','svg','avif'].includes(ext)) return 'image';
  if (['mp3','wav','ogg','m4a','flac'].includes(ext)) return 'audio';
  if (['mp4','webm','mov'].includes(ext)) return 'video';
  if (['html','htm'].includes(ext)) return 'page';
  if (ext === 'pdf') return 'pdf';
  return 'text';
}

const ICON = { image: '🖼', audio: '🎧', video: '🎬', page: '🌐', pdf: '📄',
               text: '📄', dir: '📁', file: '📄' };

// Images named in a message are shown, not described. Everything else becomes
// a button underneath.
function pictures(text) {
  const found = [];
  let m;
  const re = new RegExp(FILEISH.source, 'gi');
  while ((m = re.exec(text))) {
    if (kindOf(m[1]) === 'image' && !found.includes(m[1])) found.push(m[1]);
  }
  if (!found.length) return null;
  const box = document.createElement('div');
  box.className = 'shots';
  found.slice(0, 4).forEach((path) => {
    const img = document.createElement('img');
    img.onclick = () => openFile(path, 'image');
    box.appendChild(img);
    // These paths were read out of prose. One that does not resolve was never
    // a file, so it leaves quietly rather than announcing itself.
    feed(img, path, () => {
      img.remove();
      if (!box.children.length) box.remove();
    });
  });
  return box;
}

// Shown under a message that mentioned something openable.
function attachments(text) {
  const found = new Map();
  let m;
  while ((m = FILEISH.exec(text))) found.set(m[1], { path: m[1], kind: kindOf(m[1]) });
  while ((m = ARTIFACT.exec(text))) found.set(m[0], { url: m[0], kind: 'page' });
  if (!found.size) return null;
  const bar = document.createElement('div');
  bar.className = 'chips';
  [...found.values()].slice(0, 6).forEach((item) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = (ICON[item.kind] || '📄') + ' ' +
      (item.url ? 'artifact' : item.path.split('/').pop());
    chip.onclick = () => (item.url ? window.open(item.url, '_blank')
                                   : openFile(item.path, item.kind));
    bar.appendChild(chip);
    if (!item.url) {
      // Same reasoning as the pictures: prove it exists before offering it.
      fetch('/api/file?path=' + encodeURIComponent(item.path), {
        method: 'HEAD', headers: { Authorization: 'Bearer ' + TOKEN },
      }).then((r) => { if (!r.ok) chip.remove(); }).catch(() => chip.remove());
    }
  });
  return bar;
}

// Media plays in place; a page or a PDF gets its own tab, because that is what
// they are for.
function openFile(path, kind) {
  kind = kind || kindOf(path);
  if (kind === 'page' || kind === 'pdf') {
    window.open(fileUrl(path), '_blank');
    return;
  }
  const card = document.createElement('div');
  card.className = 'turn assistant';
  const name = path.split('/').pop();
  const tag = { image: 'img', audio: 'audio', video: 'video' }[kind] || '';
  card.innerHTML = '<div class="bubble preview"><div class="fname">' + esc(name) +
    '</div>' + (tag ? '<' + tag + (tag === 'img' ? '' : ' controls') + '></' + tag + '>' : '') +
    '</div><div class="meta"></div>';
  $('stream').appendChild(card);
  const media = card.querySelector('img, audio, video');
  if (media) feed(media, path);
  if (kind === 'text') {
    fetch(fileUrl(path))
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((body) => {
        card.querySelector('.bubble').innerHTML =
          '<div class="fname">' + name + '</div>' +
          '<div class="code"><pre>' + esc(body.slice(0, 20000)) + '</pre></div>';
        toBottom(true);
      })
      .catch(() => { card.querySelector('.bubble').innerHTML =
        '<div class="fname">' + name + '</div><p>Acilamadi.</p>'; });
  }
  toBottom(true);
}

async function filesSheet(dir) {
  const data = await api('/api/files?dir=' + encodeURIComponent(dir || ''));
  const here = data.dir || '';
  sheet('📁 ' + (here || data.root), (box) => {
    if (here) {
      const up = here.split('/').slice(0, -1).join('/');
      button(box, '◀ Yukari', null, () => filesSheet(up));
    }
    if (!data.entries.length) button(box, '(bos klasor)', null, () => {});
    const list = data.entries.length ? group(box) : box;
    data.entries.forEach((entry) => {
      const size = entry.dir ? '' : humanSize(entry.size);
      button(list, (ICON[entry.kind] || '📄') + ' ' + entry.name, size, () => {
        if (entry.dir) { filesSheet(entry.path); return; }
        closeSheet();
        openFile(entry.path, entry.kind);
      });
    });
  });
}

function humanSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
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

$('who').onclick = sessionSheet;
$('btnMenu').onclick = menuSheet;
$('veil').onclick = (e) => { if (e.target === $('veil')) closeSheet(); };
$('popveil').onclick = closePop;

const text = $('text');
text.addEventListener('input', () => {
  text.style.height = 'auto';
  text.style.height = Math.min(text.scrollHeight, 130) + 'px';
});
text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
});

$('attach').onclick = () => $('picker').click();
$('picker').onchange = async (e) => {
  await takeFiles([...e.target.files]);
  e.target.value = '';
};

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const ready = tray.filter((x) => x.path);
  const typed = text.value.trim();
  if ((!typed && !ready.length) || !session) return;
  // The session reads files by path, so that is what a message carries.
  const paths = ready.map((x) => x.path);
  const body = [typed, paths.length
    ? 'Ekli dosya' + (paths.length > 1 ? 'lar' : '') + ': ' + paths.join(', ')
    : ''].filter(Boolean).join('\n\n');
  text.value = '';
  text.style.height = 'auto';
  tray = [];
  paintTray();
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
