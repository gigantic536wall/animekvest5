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

function boardHtml(tree, quiz, scores) {
  const teams = activeTeams(tree, quiz, scores).sort((a, b) => scores.totals[b] - scores.totals[a]);
  if (!teams.length) return '<p class="muted">Пока нет команд</p>';
  return `<table class="board">${teams.map((t, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><span class="dot" style="background:${TEAM_COLORS[t]}"></span> ${esc(teamName(tree, quiz, t))}
        <div class="small muted">${playersOf(tree, t).map((p) => esc(p.name)).join(', ')}</div></td>
      <td class="num total">${scores.totals[t]}</td>
    </tr>`).join('')}</table>`;
}

function fmtTime(ms) {
  return Math.max(0, Math.ceil(ms / 1000));
}
