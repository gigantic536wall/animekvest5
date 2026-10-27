// ==================== Админка ====================
// SHA-256 пароля администратора (сейчас: admin123).
const ADMIN_HASH = '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9';

let quiz = null;
let tree = {};
const view = { r: 0, q: 0, follow: true }; // какой вопрос открыт в панели проверки
const keys = {};

const $ = (s) => document.querySelector(s);
const st = () => tree.state || { phase: 'lobby' };

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Переходы состояния игры ----------
// Все переходы атомарные: если состояние уже сменилось (другая вкладка админа), ничего не делаем.
const same = (a, b) => a && a.phase === b.phase && a.round === b.round && a.q === b.q && a.start === b.start;

function questionState(round, q) {
  return { phase: 'question', round, q, start: now(), frozenAt: null, showBoard: false };
}

const actions = {
  openRound: (r) => api.put('state', { phase: 'intro', round: r, q: 0, frozenAt: null, showBoard: false }),
  startRound: () => api.transaction('state', (cur) => (cur?.phase === 'intro' ? questionState(cur.round, 0) : null)),
  startQuestion: (r, q) => api.put('state', questionState(r, q)),

  async endQuestion(expected) {
    const s = expected || st();
    const r = quiz.rounds[s.round];
    const ok = await api.transaction('state', (cur) =>
      same(cur, s) && cur.phase === 'question' ? { ...cur, phase: 'pause', pauseEnd: now() + quiz.pauseBetween * 1000, frozenAt: null } : null
    );
    // Финал: кто не ответил — минус ставка.
    if (ok && r.type === 'final') {
      const answers = tree.answers?.[`r${s.round}`]?.[`q${s.q}`] || {};
      for (const t of activeTeams(tree, quiz, computeScores(tree, quiz))) {
        if (!answers[`t${t}`]) await api.patch(`marks/r${s.round}/q${s.q}/t${t}`, { a: false, auto: true });
      }
    }
  },

  next(expected) {
    const s = expected || st();
    const r = quiz.rounds[s.round];
    return api.transaction('state', (cur) => {
      if (!same(cur, s)) return null;
      if (s.q + 1 < r.questions.length) return questionState(s.round, s.q + 1);
      return { phase: 'roundEnd', round: s.round, q: s.q, frozenAt: null, showBoard: false };
    });
  },

  toggleFreeze: () => api.transaction('state', (cur) => {
    if (!cur) return null;
    if (cur.frozenAt) {
      const d = now() - cur.frozenAt;
      const n = { ...cur, frozenAt: null };
      if (n.start) n.start += d;
      if (n.pauseEnd) n.pauseEnd += d;
      return n;
    }
    return { ...cur, frozenAt: now() };
  }),

  reveal: (r) => api.put('state', { phase: 'reveal', round: r, q: 0, revealQ: 0, showBoard: false }),
  revealMove: (d) => api.transaction('state', (cur) => {
    if (cur?.phase !== 'reveal') return null;
    const n = quiz.rounds[cur.round].questions.length;
    return { ...cur, revealQ: Math.max(0, Math.min(n - 1, (cur.revealQ || 0) + d)) };
  }),
  lobby: () => api.put('state', { phase: 'lobby' }),
  toggleBoard: () => api.transaction('state', (cur) => ({ ...(cur || { phase: 'lobby' }), showBoard: !cur?.showBoard })),
};

// Ведущая вкладка двигает игру по таймеру.
let driving = false;
async function drive() {
  const s = st();
  if (driving || s.frozenAt) return;
  const r = quiz.rounds[s.round];
  driving = true;
  try {
    if (s.phase === 'question' && elapsed(s) >= questionDuration(r)) await actions.endQuestion(s);
    else if (s.phase === 'pause' && now() >= s.pauseEnd) await actions.next(s);
  } catch (e) {
    console.warn(e);
  }
  driving = false;
}

// ---------- Панели ----------
function controlsHtml() {
  const s = st();
  const r = quiz.rounds[s.round];
  const phaseName = { lobby: 'Лобби', intro: 'Правила раунда', question: 'Идёт вопрос', pause: 'Пауза между вопросами', roundEnd: 'Раунд завершён (ждём вас)', reveal: 'Показ ответов' }[s.phase] || s.phase;
  let info = '';
  if (r && s.phase !== 'lobby') info = `Задание ${s.round + 1}: ${esc(r.title)}`;
  if (s.phase === 'question' || s.phase === 'pause') info += `, вопрос ${s.q + 1}/${r.questions.length}`;
  if (s.phase === 'reveal') info += `, ответ ${(s.revealQ || 0) + 1}/${r.questions.length}`;
  return `
    <div class="row"><b class="grow">${phaseName}${s.frozenAt ? ' — ⏸ ПАУЗА' : ''}</b><span class="timer" id="atimer"></span></div>
    <div class="muted small" style="margin-bottom:10px">${info}</div>
    <div class="row">
      ${s.phase === 'intro' ? '<button class="primary" data-act="startRound">▶ Начать раунд</button>' : ''}
      ${s.phase === 'question' || s.phase === 'pause' ? `<button data-act="toggleFreeze">${s.frozenAt ? '▶ Продолжить' : '⏸ Пауза'}</button>` : ''}
      ${s.phase === 'question' ? '<button data-act="endQuestion">⏹ Закончить вопрос</button>' : ''}
      ${s.phase === 'pause' ? '<button class="primary" data-act="next">⏭ Пропустить паузу</button>' : ''}
      ${s.phase === 'roundEnd' || s.phase === 'reveal' ? `<button class="primary" data-act="reveal">📖 Показать ответы раунда</button>` : ''}
      ${s.phase === 'reveal' ? '<button data-act="revPrev">◀</button><button data-act="revNext">▶</button>' : ''}
      ${s.phase === 'roundEnd' && s.round + 1 < quiz.rounds.length ? `<button data-act="nextRound">➡ К заданию ${s.round + 2}</button>` : ''}
    </div>
    <div class="row" style="margin-top:8px">
      <button class="sm ${s.showBoard ? 'on' : ''}" data-act="toggleBoard">🏆 Табло у игроков</button>
      <button class="sm" data-act="lobby">Лобби</button>
    </div>`;
}

function roundsHtml() {
  const s = st();
  return `<div class="rounds-list">${quiz.rounds.map((r, i) => `
    <button data-open="${i}" class="${s.round === i && s.phase !== 'lobby' ? 'cur' : ''}">
      <span>${i + 1}. ${esc(r.title)}</span><span class="muted small">${r.questions.length} в.</span></button>`).join('')}</div>
    <p class="small muted">Нажмите на задание — у игроков откроются его правила, затем «Начать раунд».</p>`;
}

function previewHtml() {
  const s = st();
  if (s.phase !== 'question' && s.phase !== 'pause') return '<p class="muted">Сейчас нет активного вопроса</p>';
  const r = quiz.rounds[s.round];
  const q = r.questions[s.q];
  const answered = Object.keys(tree.answers?.[`r${s.round}`]?.[`q${s.q}`] || {}).length;
  const total = activeTeams(tree, quiz, computeScores(tree, quiz)).length;
  return `
    <p class="qtext">${esc(questionSummary(r, q))}</p>
    ${q.image ? `<img src="${esc(q.image)}" style="max-height:120px;border-radius:8px" alt="">` : ''}
    <p class="answer-key">✅ ${esc(correctText(r, q))}</p>
    <p class="muted">Ответили команд: ${answered} из ${total}</p>
    <p class="row small">Перейти к вопросу: <span class="qnav">${r.questions.map((_, i) => `<button class="sm ${i === s.q ? 'on' : ''}" data-goq="${i}">${i + 1}</button>`).join('')}</span></p>`;
}

function markButtons(r, q, t, ans, mark, bet) {
  const m = mark || {};
  const btn = (field, value, label) =>
    `<button class="sm ${value ? 'ok' : 'bad'} ${m[field] === value ? 'on' : ''}" data-mark="${field}" data-val="${value}" data-team="${t}">${label}</button>`;
  switch (r.type) {
    case 'error':
    case 'lasthit': return btn('a', true, '✓ +2') + btn('a', false, '✗');
    case 'odd': return `<span class="small">выбор: ${ans ? (ans.choice === q.correct ? '✅ +1' : '❌') : '—'}</span><br>причина: ${btn('b', true, '✓ +1')}${btn('b', false, '✗')}`;
    case 'order':
    case 'truefalse': return '<span class="small muted">авто</span>';
    case 'chat': return `аниме: ${btn('a', true, '✓ +2')}${btn('a', false, '✗')}<br>персонажи: ${btn('b', true, '✓ +1')}${btn('b', false, '✗')}`;
    case 'emblem': return `организация: ${btn('a', true, '✓ +2')}${btn('a', false, '✗')}<br>участник: ${btn('b', true, '✓ +1')}${btn('b', false, '✗')}`;
    case 'anagram': return `имя: ${btn('a', true, ans && ans.el < r.hintAt * 1000 ? '✓ +3' : '✓ +2')}${btn('a', false, '✗')}<br>аниме: ${btn('b', true, '✓ +1')}${btn('b', false, '✗')}`;
    case 'frame': return ans ? btn('a', true, `✓ +${4 - frameStage(r, ans.el)}`) + btn('a', false, '✗ −1') : '';
    case 'final': return `<span class="small">ставка ${bet || 1}</span> ` + btn('a', true, `✓ +${bet || 1}`) + btn('a', false, `✗ −${bet || 1}`);
  }
  return '';
}

function checkHtml() {
  const r = quiz.rounds[view.r];
  const q = r.questions[view.q];
  const scores = computeScores(tree, quiz);
  const teams = activeTeams(tree, quiz, scores);
  const rows = teams.map((t) => {
    const ans = tree.answers?.[`r${view.r}`]?.[`q${view.q}`]?.[`t${t}`];
    const mark = tree.marks?.[`r${view.r}`]?.[`q${view.q}`]?.[`t${t}`];
    const bet = tree.bets?.[`q${view.q}`]?.[`t${t}`]?.bet;
    const pts = scoreAnswer(r, q, ans, mark, bet);
    return `<tr>
      <td><span class="dot" style="background:${TEAM_COLORS[t]}"></span> ${esc(teamName(tree, quiz, t))}</td>
      <td>${ans ? `<b>${esc(answerText(r, q, ans))}</b><div class="small muted">${esc(ans.name)}</div>` : '<span class="muted">нет ответа</span>'}</td>
      <td class="small">${esc(stageText(r, ans))}</td>
      <td>${markButtons(r, q, t, ans, mark, bet)}</td>
      <td class="num"><span class="pts ${pts > 0 ? 'pos' : pts < 0 ? 'neg' : ''}">${pts > 0 ? '+' : ''}${pts}</span></td>
    </tr>`;
  });
  return `
    <div class="row" style="margin-bottom:8px">
      <select id="checkRound">${quiz.rounds.map((x, i) => `<option value="${i}" ${i === view.r ? 'selected' : ''}>${i + 1}. ${esc(x.title)}</option>`).join('')}</select>
      <span class="qnav">${r.questions.map((_, i) => `<button class="sm ${i === view.q ? 'on' : ''}" data-viewq="${i}">${i + 1}</button>`).join('')}</span>
      <label class="small" style="margin:0"><input type="checkbox" id="follow" ${view.follow ? 'checked' : ''} style="width:auto"> следовать за игрой</label>
    </div>
    <p><b>${esc(questionSummary(r, q))}</b></p>
    <p class="answer-key small">✅ ${esc(correctText(r, q))}</p>
    ${rows.length ? `<table class="check"><tr><th>Команда</th><th>Ответ</th><th>Этап</th><th>Проверка</th><th class="num">Очки</th></tr>${rows.join('')}</table>` : '<p class="muted">Нет команд</p>'}`;
}

function teamsHtml() {
  const scores = computeScores(tree, quiz);
  return quiz.teams.map((_, t) => `
    <div style="margin-bottom:12px">
      <div class="row"><span class="dot" style="background:${TEAM_COLORS[t]}"></span>
        <input style="padding:6px 10px;width:150px" data-tname="${t}" value="${esc(teamName(tree, quiz, t))}">
        <b class="total grow" style="text-align:right">${scores.totals[t]}</b>
        <button class="sm" data-adj="${t}" data-d="1" title="Ручная правка">+1</button><button class="sm" data-adj="${t}" data-d="-1" title="Ручная правка">−1</button></div>
      <div class="small muted">${playersOf(tree, t).map((p) => `${esc(p.name)} <button class="sm" data-kick="${p.id}" title="Удалить игрока">✕</button>`).join(' ') || 'нет игроков'}
        ${tree.adjust?.[t] ? `<span class="tag">ручная правка ${tree.adjust[t] > 0 ? '+' : ''}${tree.adjust[t]}</span>` : ''}</div>
    </div>`).join('');
}

function scoresHtml() {
  const scores = computeScores(tree, quiz);
  const teams = activeTeams(tree, quiz, scores);
  if (!teams.length) return '<p class="muted">Пока нет команд</p>';
  return `<div style="overflow-x:auto"><table><tr><th>Команда</th>${quiz.rounds.map((_, i) => `<th class="num">${i + 1}</th>`).join('')}<th class="num">Итого</th></tr>
    ${teams.sort((a, b) => scores.totals[b] - scores.totals[a]).map((t) => `<tr><td>${esc(teamName(tree, quiz, t))}</td>
      ${scores.byRound[t].map((v) => `<td class="num">${v}</td>`).join('')}<td class="num total">${scores.totals[t]}</td></tr>`).join('')}
  </table></div>`;
}

// Перерисовываем панель, только если её содержимое поменялось (и в ней не печатают).
function panel(id, html) {
  const el = $(id);
  if (keys[id] === html) return;
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  keys[id] = html;
  el.innerHTML = html;
}

function renderAll() {
  const s = st();
  if (view.follow && (s.phase === 'question' || s.phase === 'pause' || s.phase === 'reveal')) {
    view.r = s.round;
    view.q = s.phase === 'reveal' ? s.revealQ || 0 : s.q;
  }
  panel('#controls', controlsHtml());
  panel('#rounds', roundsHtml());
  panel('#preview', previewHtml());
  panel('#check', checkHtml());
  panel('#teams', teamsHtml());
  panel('#scores', scoresHtml());
}

function tickTimer() {
  const s = st();
  const t = $('#atimer');
  if (!t) return;
  const r = quiz.rounds[s.round];
  if (s.phase === 'question') {
    const left = questionDuration(r) - elapsed(s);
    t.textContent = fmtTime(left);
    t.classList.toggle('low', left < 5000);
  } else if (s.phase === 'pause') {
    t.textContent = fmtTime(s.pauseEnd - (s.frozenAt || now()));
    t.classList.remove('low');
  } else t.textContent = '';
}

// ---------- Обработчики (делегирование) ----------
function bind() {
  document.body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const s = st();
    try {
      if (b.dataset.act) {
        const a = b.dataset.act;
        if (a === 'startRound') await actions.startRound();
        if (a === 'toggleFreeze') await actions.toggleFreeze();
        if (a === 'endQuestion') await actions.endQuestion();
        if (a === 'next') await actions.next();
        if (a === 'reveal') await actions.reveal(s.round);
        if (a === 'revPrev') await actions.revealMove(-1);
        if (a === 'revNext') await actions.revealMove(1);
        if (a === 'nextRound') await actions.openRound(s.round + 1);
        if (a === 'toggleBoard') await actions.toggleBoard();
        if (a === 'lobby') await actions.lobby();
        if (a === 'resetAnswers' && confirm('Удалить все ответы, ставки и очки? Игроки останутся.')) {
          await Promise.all(['answers', 'marks', 'bets', 'adjust'].map((p) => api.del(p)));
          await actions.lobby();
        }
        if (a === 'resetAll' && confirm('Полный сброс: удалить игроков, команды, ответы и очки?')) {
          await api.del('');
          await actions.lobby();
        }
      }
      if (b.dataset.open !== undefined) {
        const i = +b.dataset.open;
        if (s.phase === 'question' && !confirm('Сейчас идёт вопрос. Всё равно открыть другое задание?')) return;
        await actions.openRound(i);
      }
      if (b.dataset.goq !== undefined) await actions.startQuestion(s.round, +b.dataset.goq);
      if (b.dataset.viewq !== undefined) { view.q = +b.dataset.viewq; view.follow = false; renderAll(); }
      if (b.dataset.mark) {
        const t = +b.dataset.team;
        const val = b.dataset.val === 'true';
        const path = `marks/r${view.r}/q${view.q}/t${t}`;
        const cur = tree.marks?.[`r${view.r}`]?.[`q${view.q}`]?.[`t${t}`]?.[b.dataset.mark];
        await api.patch(path, { [b.dataset.mark]: cur === val ? null : val, auto: null });
      }
      if (b.dataset.adj !== undefined) {
        const t = +b.dataset.adj;
        await api.put(`adjust/${t}`, Number(tree.adjust?.[t] || 0) + Number(b.dataset.d));
      }
      if (b.dataset.kick && confirm('Удалить игрока из игры?')) await api.del(`players/${b.dataset.kick}`);
    } catch (err) {
      alert('Ошибка связи с базой: ' + err.message);
    }
  });
  document.body.addEventListener('change', async (e) => {
    if (e.target.id === 'checkRound') { view.r = +e.target.value; view.q = 0; view.follow = false; renderAll(); }
    if (e.target.id === 'follow') { view.follow = e.target.checked; renderAll(); }
    if (e.target.dataset.tname !== undefined) await api.put(`teams/${e.target.dataset.tname}/name`, e.target.value.trim() || null);
  });
}

async function startAdmin() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  quiz = await loadQuiz();
  await syncClock().catch(() => {});
  bind();
  subscribe(
    (t) => { tree = t || {}; renderAll(); },
    (s) => { $('#conn').className = 'dot status-' + s; }
  );
  setInterval(() => { tickTimer(); drive(); }, 250);
}

(function init() {
  let ok = false;
  try { ok = sessionStorage.getItem('aq5_admin') === ADMIN_HASH; } catch (e) {}
  if (ok) return startAdmin();
  const go = async () => {
    if ((await sha256($('#pwd').value)) === ADMIN_HASH) {
      try { sessionStorage.setItem('aq5_admin', ADMIN_HASH); } catch (e) {}
      startAdmin();
    } else {
      $('#err').textContent = 'Неверный пароль';
    }
  };
  $('#enter').addEventListener('click', go);
  $('#pwd').addEventListener('keydown', (e) => e.key === 'Enter' && go());
})();
