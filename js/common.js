// ==================== Общее для игрока и админа ====================
// База: Firebase Realtime Database через REST, всё лежит в ветке kvest5/.
const DB_URL = 'https://anime-database-7d48e-default-rtdb.europe-west1.firebasedatabase.app';
const ROOT = 'kvest5';
const TEAM_COLORS = ['#f472b6', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#fb923c', '#a3e635', '#e879f9'];
const LETTERS = 'АБВГДЕЖЗ';

const api = {
  url: (p) => `${DB_URL}/${ROOT}${p ? '/' + p : ''}.json`,
  async get(p) {
    const r = await fetch(api.url(p));
    if (!r.ok) throw new Error(`GET ${p}: ${r.status}`);
    return r.json();
  },
  async put(p, data) {
    const r = await fetch(api.url(p), { method: 'PUT', body: JSON.stringify(data) });
    if (!r.ok) throw new Error(`PUT ${p}: ${r.status}`);
    return r.json();
  },
  async patch(p, data) {
    const r = await fetch(api.url(p), { method: 'PATCH', body: JSON.stringify(data) });
    if (!r.ok) throw new Error(`PATCH ${p}: ${r.status}`);
    return r.json();
  },
  async del(p) {
    const r = await fetch(api.url(p), { method: 'DELETE' });
    if (!r.ok) throw new Error(`DELETE ${p}: ${r.status}`);
  },
  // Запись только если по этому пути ещё ничего нет. true — записали первыми.
  async putIfEmpty(p, data) {
    const r = await fetch(api.url(p), { method: 'PUT', headers: { 'if-match': 'null_etag' }, body: JSON.stringify(data) });
    if (r.status === 412) return false;
    if (!r.ok) throw new Error(`PUT ${p}: ${r.status}`);
    return true;
  },
  // Атомарное изменение узла: mutate(старое) -> новое или null (ничего не менять).
  async transaction(p, mutate) {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(api.url(p), { headers: { 'X-Firebase-ETag': 'true' } });
      const etag = r.headers.get('ETag');
      const next = mutate(await r.json());
      if (next === null || next === undefined) return false;
      const w = await fetch(api.url(p), { method: 'PUT', headers: { 'if-match': etag }, body: JSON.stringify(next) });
      if (w.ok) return true;
      if (w.status !== 412) throw new Error(`transaction ${p}: ${w.status}`);
    }
    return false;
  },
};

// ---------- Серверное время: у всех одинаковый таймер ----------
let clockOffset = 0;
const now = () => Date.now() + clockOffset;

async function syncClock() {
  const id = 'c' + Math.random().toString(36).slice(2, 10);
  let best = null;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const server = await api.put(`clock/${id}`, { '.sv': 'timestamp' });
    const t1 = Date.now();
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: server - (t0 + t1) / 2 };
  }
  clockOffset = best.offset;
  api.del(`clock/${id}`).catch(() => {});
}

// ---------- Живая подписка на всю ветку kvest5 ----------
function setIn(tree, path, value) {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return value ?? {};
  const root = tree && typeof tree === 'object' ? tree : {};
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === null || value === undefined) delete node[last];
  else node[last] = value;
  return root;
}

function subscribe(onChange, onStatus) {
  let tree = {};
  let es = null;
  let pollTimer = null;
  let errors = 0;

  const startPolling = () => {
    if (pollTimer) return;
    onStatus?.('poll');
    let busy = false;
    pollTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        tree = (await api.get('')) || {};
        onChange(tree);
        onStatus?.('poll');
      } catch (e) {
        onStatus?.('offline');
      }
      busy = false;
    }, 800);
  };

  try {
    es = new EventSource(api.url(''));
    es.addEventListener('put', (e) => {
      const { path, data } = JSON.parse(e.data);
      tree = setIn(tree, path, data);
      errors = 0;
      onStatus?.('live');
      onChange(tree);
    });
    es.addEventListener('patch', (e) => {
      const { path, data } = JSON.parse(e.data);
      for (const k of Object.keys(data || {})) tree = setIn(tree, `${path}/${k}`, data[k]);
      onChange(tree);
    });
    es.onerror = () => {
      errors++;
      onStatus?.('offline');
      if (errors >= 3) {
        es.close();
        startPolling();
      }
    };
  } catch (e) {
    startPolling();
  }
}

// ---------- Вопросы ----------
async function loadQuiz() {
  const r = await fetch('questions.json', { cache: 'no-store' });
  return r.json();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').toUpperCase().replace(/[^А-ЯЁA-Z]/g, '');

function teamName(tree, quiz, t) {
  return tree?.teams?.[t]?.name || quiz.teams[t] || `Команда ${t + 1}`;
}

// Аватарка команды: картинка из базы или кружок цвета команды с номером.
function avatarHtml(tree, t, size = 40) {
  const src = tree?.teams?.[t]?.avatar;
  const style = `width:${size}px;height:${size}px;--c:${TEAM_COLORS[t]}`;
  if (typeof src === 'string' && src.startsWith('data:image/')) {
    return `<img class="ava" style="${style}" src="${src}" alt="">`;
  }
  return `<span class="ava ava-empty" style="${style};font-size:${Math.round(size * 0.42)}px">${t + 1}</span>`;
}

// Сжимаем загруженную картинку до квадрата size×size (обрезка по центру), JPEG.
function compressAvatar(file, size = 200) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть картинку')); };
    img.src = url;
  });
}

// Подпись команд без самих картинок — чтобы дёшево замечать изменения.
function teamsSig(tree) {
  return Object.entries(tree?.teams || {}).map(([t, v]) => `${t}:${v?.name || ''}:${(v?.avatar || '').length}`).join('|');
}

function playersOf(tree, t) {
  return Object.entries(tree?.players || {})
    .filter(([, p]) => p.team === t)
    .map(([id, p]) => ({ id, ...p }));
}

// Команды, в которых есть игроки или уже есть очки.
function activeTeams(tree, quiz, scores) {
  return quiz.teams.map((_, t) => t).filter((t) => playersOf(tree, t).length || scores?.totals[t]);
}

// Длительность вопроса (мс) — включая фазу ставок в финале.
function questionDuration(round) {
  if (round.type === 'frame') return round.stageTime * round.blocks.length * 1000;
  if (round.type === 'final') return (round.betTime + round.time) * 1000;
  return round.time * 1000;
}

// Сколько прошло с начала вопроса с учётом паузы админа.
function elapsed(state) {
  if (!state?.start) return 0;
  return (state.frozenAt || now()) - state.start;
}

function frameStage(round, el) {
  return Math.min(round.blocks.length - 1, Math.max(0, Math.floor(el / (round.stageTime * 1000))));
}

// ---------- Подсчёт очков ----------
// mark: { a: true/false, b: true/false } — решения админа.
function scoreAnswer(round, q, ans, mark, bet) {
  const m = mark || {};
  switch (round.type) {
    case 'error':
    case 'lasthit':
      return m.a ? 2 : 0;
    case 'odd':
      if (!ans) return 0;
      return (ans.choice === q.correct ? 1 : 0) + (m.b ? 1 : 0);
    case 'order':
      return ans && norm(ans.order) === norm(q.answer) ? 3 : 0;
    case 'truefalse':
      if (!ans) return 0;
      return ans.tf === q.answer ? 1 : -1;
    case 'chat':
      return (m.a ? 2 : 0) + (m.b ? 1 : 0);
    case 'emblem': {
      const base = (m.a ? 2 : 0) + (m.b ? 1 : 0);
      return base && ans && ans.el < round.revealAt * 1000 ? base + 1 : base;
    }
    case 'anagram':
      return (m.a ? (ans && ans.el < round.hintAt * 1000 ? 3 : 2) : 0) + (m.b ? 1 : 0);
    case 'frame':
      if (m.a === true) return 4 - frameStage(round, ans?.el || 0);
      if (m.a === false && ans) return -1;
      return 0;
    case 'final':
      if (m.a === true) return bet || 1;
      if (m.a === false) return -(bet || 1);
      return 0;
  }
  return 0;
}

// Итог проверки ответа для подсветки: ok — зелёный, partial — жёлтый, bad — красный, pending — ещё не проверен.
function verdict(round, q, ans, mark) {
  if (!ans) return mark?.a === false ? 'bad' : 'none';
  const m = mark || {};
  const fromParts = (parts) => {
    const good = parts.filter(Boolean).length;
    return good === parts.length ? 'ok' : good ? 'partial' : 'bad';
  };
  switch (round.type) {
    case 'order': return norm(ans.order) === norm(q.answer) ? 'ok' : 'bad';
    case 'truefalse': return ans.tf === q.answer ? 'ok' : 'bad';
    case 'odd':
      if (m.b === undefined) return 'pending';
      return fromParts([ans.choice === q.correct, m.b]);
    case 'chat':
    case 'emblem':
    case 'anagram':
      if (m.a === undefined && m.b === undefined) return 'pending';
      return fromParts([m.a === true, m.b === true]);
    default:
      if (m.a === undefined) return 'pending';
      return m.a ? 'ok' : 'bad';
  }
}

const VERDICT_TEXT = { ok: '✅ Верно', partial: '🟡 Частично верно', bad: '❌ Неверно', pending: '⏳ Ждёт проверки', none: '' };

function computeScores(tree, quiz) {
  const totals = {};
  const byRound = {};
  quiz.teams.forEach((_, t) => {
    totals[t] = Number(tree?.adjust?.[t] || 0);
    byRound[t] = quiz.rounds.map(() => 0);
  });
  quiz.rounds.forEach((round, r) => {
    round.questions.forEach((q, qi) => {
      quiz.teams.forEach((_, t) => {
        const ans = tree?.answers?.[`r${r}`]?.[`q${qi}`]?.[`t${t}`];
        const mark = tree?.marks?.[`r${r}`]?.[`q${qi}`]?.[`t${t}`];
        const bet = tree?.bets?.[`q${qi}`]?.[`t${t}`]?.bet;
        const pts = scoreAnswer(round, q, ans, mark, bet);
        byRound[t][r] += pts;
        totals[t] += pts;
      });
    });
  });
  return { totals, byRound };
}

// Потолок ставки в финале: от 1 до 5, но не больше, чем есть у команды.
function betCap(total) {
  return Math.max(1, Math.min(5, Math.floor(total)));
}

// ---------- Тексты ответов ----------
function correctText(round, q) {
  switch (round.type) {
    case 'odd': return `${q.options[q.correct]} — ${q.reason}`;
    case 'order': return [...q.answer].map((l) => `${l}) ${q.cards[LETTERS.indexOf(l)]}`).join(' → ') + (q.note ? ` (${q.note})` : '');
    case 'truefalse': return `${q.answer ? 'Верю' : 'Не верю'}. ${q.explain}`;
    case 'chat': return `${q.anime}: ${q.characters}`;
    case 'emblem': return `${q.org} (${q.anime}). Участники: ${q.members}`;
    case 'anagram': return `${q.answer} — ${q.anime}`;
    default: return q.answer;
  }
}

function answerText(round, q, ans) {
  if (!ans) return '';
  switch (round.type) {
    case 'odd': return `${ans.choice !== undefined ? q.options[ans.choice] : '—'}${ans.text ? ' — ' + ans.text : ''}`;
    case 'order': return [...(ans.order || '')].join(' ');
    case 'truefalse': return ans.tf ? 'Верю' : 'Не верю';
    case 'chat': return `Аниме: ${ans.text || '—'}; персонажи: ${ans.text2 || '—'}`;
    case 'emblem': return `Организация: ${ans.text || '—'}; участник: ${ans.text2 || '—'}`;
    case 'anagram': return `Имя: ${ans.text || '—'}; аниме: ${ans.text2 || '—'}`;
    default: return ans.text || '';
  }
}

// Этап, на котором ответила команда — для админской проверки.
function stageText(round, ans) {
  if (!ans) return '';
  const sec = (ans.el / 1000).toFixed(1) + ' с';
  if (round.type === 'frame') return `этап ${frameStage(round, ans.el) + 1} (${sec})`;
  if (round.type === 'emblem') return `${ans.el < round.revealAt * 1000 ? 'до картинки' : 'после картинки'} (${sec})`;
  if (round.type === 'anagram') return `${ans.el < round.hintAt * 1000 ? 'до подсказки' : 'после подсказки'} (${sec})`;
  if (round.type === 'final') return `${((ans.el - round.betTime * 1000) / 1000).toFixed(1)} с`;
  return sec;
}

// Короткая формулировка вопроса — для показа ответов и админки.
function questionSummary(round, q) {
  switch (round.type) {
    case 'error': return `${q.anime}: ${q.text}`;
    case 'lasthit': return `${q.character} (${q.anime})`;
    case 'odd': return `${q.options.join(', ')} (${q.anime})`;
    case 'order': return `${q.task}: ${q.cards.map((c, i) => `${LETTERS[i]}) ${c}`).join(' ')}`;
    case 'truefalse': return q.text;
    case 'chat': return q.messages.join(' / ');
    case 'emblem': return q.description;
    case 'anagram': return q.anagram;
    case 'frame': return q.description;
    case 'final': return `${q.topic}: ${q.question}`;
  }
  return '';
}

// Табло: места (одинаковые очки — одно место), аватарки, полоска очков. podium — пьедестал для топ-3.
function boardHtml(tree, quiz, scores, opts = {}) {
  const teams = activeTeams(tree, quiz, scores).sort((a, b) => scores.totals[b] - scores.totals[a] || a - b);
  if (!teams.length) return '<p class="muted">Пока нет команд</p>';
  const place = {};
  teams.forEach((t, i) => (place[t] = i && scores.totals[t] === scores.totals[teams[i - 1]] ? place[teams[i - 1]] : i + 1));
  const max = Math.max(1, ...teams.map((t) => scores.totals[t]));
  const medal = (p) => ['🥇', '🥈', '🥉'][p - 1] || p;
  const members = (t) => playersOf(tree, t).map((p) => esc(p.name)).join(', ');
  const word = (n) => ['очко', 'очка', 'очков'][n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2];

  let podium = '';
  let rest = teams;
  if (opts.podium && teams.length >= 3) {
    rest = teams.slice(3);
    podium = `<div class="podium">${[1, 0, 2].map((i) => {
      const t = teams[i];
      return `<div class="pod pod${i + 1}" style="--c:${TEAM_COLORS[t]};animation-delay:${0.15 * (3 - i)}s">
        <div class="pod-medal">${medal(place[t])}</div>
        ${avatarHtml(tree, t, i === 0 ? 96 : 72)}
        <div class="pod-name">${esc(teamName(tree, quiz, t))}</div>
        <div class="lb-members" style="max-width:100%">${members(t) || '&nbsp;'}</div>
        <div class="pod-score">${scores.totals[t]}</div>
        <div class="pod-step"></div>
      </div>`;
    }).join('')}</div>`;
  }
  return `${podium}<div class="lb">${rest.map((t, i) => `
    <div class="lb-row ${place[t] <= 3 ? 'top' + place[t] : ''}" style="--c:${TEAM_COLORS[t]};animation-delay:${0.05 * i}s">
      <div class="lb-place">${medal(place[t])}</div>
      ${avatarHtml(tree, t, 48)}
      <div class="lb-info">
        <div class="lb-name">${esc(teamName(tree, quiz, t))}</div>
        <div class="lb-members">${members(t) || '&nbsp;'}</div>
        <div class="lb-bar"><div style="width:${Math.max(0, (scores.totals[t] / max) * 100)}%"></div></div>
      </div>
      <div class="lb-score">${scores.totals[t]}<span>${word(Math.abs(scores.totals[t]))}</span></div>
    </div>`).join('')}</div>`;
}

function fmtTime(ms) {
  return Math.max(0, Math.ceil(ms / 1000));
}
