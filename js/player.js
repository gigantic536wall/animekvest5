// ==================== Экран игрока ====================
let quiz = null;
let tree = {};
let loaded = false;
let me = null;
let screenKey = '';
let dynamic = null; // обновление таймеров/этапов текущего экрана, вызывается каждые 150 мс
const local = {}; // черновики игрока: порядок карточек, плитки, выбор в «Лишнем»

const $ = (s) => document.querySelector(s);
const main = () => $('#main');

try { me = JSON.parse(localStorage.getItem('aq5_me')); } catch (e) { me = null; }

function saveMe(v) {
  me = v;
  try { v ? localStorage.setItem('aq5_me', JSON.stringify(v)) : localStorage.removeItem('aq5_me'); } catch (e) {}
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 2500);
}

const st = () => tree.state || { phase: 'lobby' };
const round = () => quiz.rounds[st().round];
const question = () => round()?.questions[st().q];
const teamAnswer = (r = st().round, q = st().q) => tree.answers?.[`r${r}`]?.[`q${q}`]?.[`t${me.team}`];

function isJoined() {
  return me && tree.players?.[me.id];
}

// ---------- Вход ----------
function joinHtml() {
  const counts = quiz.teams.map((_, t) => playersOf(tree, t).length);
  const sel = local.joinTeam ?? -1;
  return `
    <div class="card">
      <h2>Вход в игру</h2>
      <label>Ваш ник</label>
      <input id="nick" maxlength="20" placeholder="Например, Наруто" value="${esc(local.nick || '')}">
      <label>Команда (по ${quiz.maxPerTeam} человека)</label>
      <div class="teams">${quiz.teams.map((_, t) => `
        <button class="team ${sel === t ? 'sel' : ''}" data-team="${t}" ${counts[t] >= quiz.maxPerTeam ? 'disabled' : ''}>
          <b><span class="dot" style="background:${TEAM_COLORS[t]}"></span> ${esc(teamName(tree, quiz, t))}</b>
          <span class="small muted">${counts[t]}/${quiz.maxPerTeam}: ${playersOf(tree, t).map((p) => esc(p.name)).join(', ') || 'пусто'}</span>
        </button>`).join('')}
      </div>
      <p><button class="primary" id="join">Войти</button></p>
    </div>`;
}

function initJoin() {
  $('#nick').addEventListener('input', (e) => (local.nick = e.target.value));
  document.querySelectorAll('[data-team]').forEach((b) =>
    b.addEventListener('click', () => {
      local.joinTeam = +b.dataset.team;
      screenKey = '';
      update();
    })
  );
  $('#join').addEventListener('click', async () => {
    const name = ($('#nick').value || '').trim();
    const team = local.joinTeam;
    if (!name) return toast('Введите ник');
    if (team === undefined || team < 0) return toast('Выберите команду');
    if (playersOf(tree, team).length >= quiz.maxPerTeam) return toast('В этой команде уже нет мест');
    const id = me?.id || 'p' + Math.random().toString(36).slice(2, 10);
    await api.put(`players/${id}`, { name, team, joined: { '.sv': 'timestamp' } });
    // Если в последний момент в команду вошли одновременно с нами — лишний тот, кто вошёл позже.
    const mates = Object.entries((await api.get('players')) || {})
      .filter(([, p]) => p.team === team)
      .sort(([a, x], [b, y]) => x.joined - y.joined || a.localeCompare(b));
    if (mates.findIndex(([pid]) => pid === id) >= quiz.maxPerTeam) {
      await api.del(`players/${id}`);
      return toast('Пока вы входили, команду заполнили — выберите другую');
    }
    saveMe({ id, name, team });
    screenKey = '';
    update();
  });
}

// ---------- Ожидание ----------
function lobbyHtml() {
  const mates = playersOf(tree, me.team).map((p) => esc(p.name)).join(', ');
  return `
    <div class="card center">
      <h2>Ждём начала игры</h2>
      <p>Вы в команде <b style="color:${TEAM_COLORS[me.team]}">${esc(teamName(tree, quiz, me.team))}</b></p>
      <p class="muted">Состав: ${mates}</p>
      <p class="small muted">Отвечает команда целиком: принимается первый ответ любого из вас, после этого поле блокируется у всей команды.</p>
    </div>
    <div class="card"><h3>Команды</h3>${boardHtml(tree, quiz, computeScores(tree, quiz))}</div>`;
}

function introHtml() {
  const r = round();
  return `
    <div class="card">
      <div class="muted">Задание ${st().round + 1} из ${quiz.rounds.length}</div>
      <h1 class="logo">${esc(r.title)}</h1>
      ${r.warning ? `<p class="alert">⚠️ ${esc(r.warning)}</p>` : ''}
      <p>${esc(r.rules)}</p>
      <p class="muted">Вопросов: ${r.questions.length}. Баллы: ${esc(r.points)}</p>
      <p class="center muted">Сейчас начнётся…</p>
    </div>`;
}

function roundEndHtml() {
  const r = round();
  return `
    <div class="card center">
      <div class="muted">Задание ${st().round + 1}</div>
      <h2>«${esc(r.title)}» — раунд завершён</h2>
      <p class="muted">Ждём ведущего</p>
    </div>
    <div class="card"><h3>Табло</h3>${boardHtml(tree, quiz, computeScores(tree, quiz))}</div>`;
}

function revealHtml() {
  const r = round();
  const qi = st().revealQ || 0;
  const q = r.questions[qi];
  const ans = teamAnswer(st().round, qi);
  const mark = tree.marks?.[`r${st().round}`]?.[`q${qi}`]?.[`t${me.team}`];
  const pts = scoreAnswer(r, q, ans, mark, tree.bets?.[`q${qi}`]?.[`t${me.team}`]?.bet);
  return `
    <div class="card">
      <div class="muted">Ответы: «${esc(r.title)}», вопрос ${qi + 1} из ${r.questions.length}</div>
      <p class="qtext">${esc(questionSummary(r, q))}</p>
      ${q.image ? `<img class="emblem-img" src="${esc(q.image)}" alt="">` : ''}
      <p class="answer-key">✅ ${esc(correctText(r, q))}</p>
      <p>Ваша команда: ${ans ? esc(answerText(r, q, ans)) : '<span class="muted">не ответила</span>'}
        <span class="pts ${pts > 0 ? 'pos' : pts < 0 ? 'neg' : ''}">(${pts > 0 ? '+' : ''}${pts})</span></p>
    </div>`;
}

// ---------- Вопрос ----------
function lockedHtml(ans) {
  const r = round();
  return `<div class="locked">✅ Ваша команда ответила: <b>${esc(answerText(r, question(), ans))}</b>
    <div class="small muted">Ответ отправил(а) ${esc(ans.name)}. Изменить его нельзя.</div></div>`;
}

function headHtml() {
  const r = round();
  return `
    <div class="qhead">
      <div><div class="muted small">Задание ${st().round + 1}: ${esc(r.title)}</div>
        <b>Вопрос ${st().q + 1} из ${r.questions.length}</b></div>
      <div class="timer" id="timer">–</div>
    </div>
    <div class="bar"><div id="bar" style="width:100%"></div></div>`;
}

function canAnswer() {
  const s = st();
  return s.phase === 'question' && !s.frozenAt && elapsed(s) < questionDuration(round()) + 500;
}

async function submit(payload) {
  if (!canAnswer()) return toast('Время вышло');
  const s = st();
  const ok = await api.putIfEmpty(`answers/r${s.round}/q${s.q}/t${me.team}`, {
    ...payload,
    by: me.id,
    name: me.name,
    at: { '.sv': 'timestamp' },
    el: Math.round(elapsed(s)),
  });
  if (!ok) toast('Ваша команда уже ответила');
}

const textForm = (fields) => `
  ${fields.map((f) => `<label>${esc(f.label)}</label><input id="${f.id}" maxlength="200" autocomplete="off" placeholder="${esc(f.ph || '')}">`).join('')}
  <p><button class="primary" id="send">Отправить ответ</button></p>`;

function bindSend(collect) {
  const send = $('#send');
  if (!send) return;
  const go = async () => {
    const payload = collect();
    if (!payload) return;
    send.disabled = true;
    await submit(payload).catch(() => toast('Не удалось отправить, попробуйте ещё раз'));
    send.disabled = false;
  };
  send.addEventListener('click', go);
  document.querySelectorAll('#main input').forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && go()));
}

const val = (id) => ($(id)?.value || '').trim();

// Каждый тип раунда: html(q, ans) + init(q) + dyn(el) (необязательно)
const VIEWS = {
  error: {
    html: (q, ans) => `
      <span class="anime-tag">${esc(q.anime)}</span>
      <p class="qtext">${esc(q.text)}</p>
      ${ans ? lockedHtml(ans) : textForm([{ id: 'a1', label: 'Что не так и как правильно?', ph: 'Ошибка → как правильно' }])}`,
    init: () => bindSend(() => (val('#a1') ? { text: val('#a1') } : (toast('Напишите ответ'), null))),
  },
  lasthit: {
    html: (q, ans) => `
      <span class="anime-tag">${esc(q.anime)}</span>
      <p class="qtext">💀 ${esc(q.character)}</p>
      <p class="muted">Кто или что его убило?</p>
      ${ans ? lockedHtml(ans) : textForm([{ id: 'a1', label: 'Ответ' }])}`,
    init: () => bindSend(() => (val('#a1') ? { text: val('#a1') } : (toast('Напишите ответ'), null))),
  },
  odd: {
    html: (q, ans) => `
      <span class="anime-tag">${esc(q.anime)}</span>
      <p class="qtext">Кто здесь лишний?</p>
      ${ans ? lockedHtml(ans) : `
        <div class="options">${q.options.map((o, i) => `<button data-opt="${i}">${esc(o)}</button>`).join('')}</div>
        ${textForm([{ id: 'a1', label: 'Почему он лишний?' }])}`}`,
    init: () => {
      const key = `odd${st().round}_${st().q}`;
      const mark = () => document.querySelectorAll('[data-opt]').forEach((b) => b.classList.toggle('on', +b.dataset.opt === local[key]));
      document.querySelectorAll('[data-opt]').forEach((b) => b.addEventListener('click', () => { local[key] = +b.dataset.opt; mark(); }));
      mark();
      bindSend(() => {
        if (local[key] === undefined) return toast('Выберите лишнего'), null;
        return { choice: local[key], text: val('#a1') };
      });
    },
  },
  order: {
    html: (q, ans) => `
      <p class="qtext">${esc(q.task)}</p>
      ${ans ? lockedHtml(ans) : `
        <p class="small muted">Перетащите карточки или двигайте стрелками: сверху — первый.</p>
        <ul class="cards" id="cards"></ul>
        <p><button class="primary" id="send">Отправить порядок</button></p>`}`,
    init: (q) => {
      const list = $('#cards');
      if (!list) return;
      const key = `order${st().round}_${st().q}`;
      if (!local[key]) local[key] = q.cards.map((_, i) => i);
      const order = local[key];
      const draw = () => {
        list.innerHTML = order.map((c, pos) => `
          <li data-pos="${pos}"><span class="num">${pos + 1}.</span><span class="letter">${LETTERS[c]})</span> ${esc(q.cards[c])}
            <span class="arrows"><button class="sm" data-up="${pos}" ${pos === 0 ? 'disabled' : ''}>▲</button><button class="sm" data-down="${pos}" ${pos === order.length - 1 ? 'disabled' : ''}>▼</button></span></li>`).join('');
      };
      const move = (from, to) => { const [x] = order.splice(from, 1); order.splice(to, 0, x); };
      list.addEventListener('click', (e) => {
        const up = e.target.closest('[data-up]');
        const down = e.target.closest('[data-down]');
        if (up) { move(+up.dataset.up, +up.dataset.up - 1); draw(); }
        if (down) { move(+down.dataset.down, +down.dataset.down + 1); draw(); }
      });
      let dragPos = null;
      list.addEventListener('pointerdown', (e) => {
        const li = e.target.closest('li');
        if (!li || e.target.closest('button')) return;
        dragPos = +li.dataset.pos;
        li.classList.add('drag');
        list.setPointerCapture(e.pointerId);
      });
      list.addEventListener('pointermove', (e) => {
        if (dragPos === null) return;
        const li = document.elementFromPoint(e.clientX, e.clientY)?.closest('#cards li');
        if (li && +li.dataset.pos !== dragPos) {
          move(dragPos, +li.dataset.pos);
          dragPos = +li.dataset.pos;
          draw();
          list.querySelector(`li[data-pos="${dragPos}"]`)?.classList.add('drag');
        }
      });
      const stop = () => { dragPos = null; list.querySelectorAll('.drag').forEach((x) => x.classList.remove('drag')); };
      list.addEventListener('pointerup', stop);
      list.addEventListener('pointercancel', stop);
      draw();
      bindSend(() => ({ order: order.map((c) => LETTERS[c]).join('') }));
    },
  },
  truefalse: {
    html: (q, ans) => `
      <p class="qtext">${esc(q.text)}</p>
      ${ans ? lockedHtml(ans) : `
        <div class="tf"><button class="ok" data-tf="1">👍 Верю</button><button class="bad" data-tf="0">👎 Не верю</button></div>
        <p class="small muted center">Верно +1, неверно −1, без ответа 0</p>`}`,
    init: () => document.querySelectorAll('[data-tf]').forEach((b) =>
      b.addEventListener('click', async () => {
        document.querySelectorAll('[data-tf]').forEach((x) => (x.disabled = true));
        await submit({ tf: b.dataset.tf === '1' }).catch(() => toast('Не удалось отправить'));
        document.querySelectorAll('[data-tf]').forEach((x) => (x.disabled = false));
      })
    ),
  },
  chat: {
    html: (q, ans) => `
      <div class="phone"><div class="head">🔒 Абонент 1 и Абонент 2</div><div id="msgs"></div><div class="typing" id="typing"></div></div>
      ${ans ? `<p></p>${lockedHtml(ans)}` : textForm([
        { id: 'a1', label: 'Аниме (+2)' },
        { id: 'a2', label: 'Кто переписывается (+1)', ph: 'Абонент 1 и Абонент 2' },
      ])}`,
    init: () => bindSend(() => (val('#a1') || val('#a2') ? { text: val('#a1'), text2: val('#a2') } : (toast('Напишите ответ'), null))),
    // Сообщения появляются по одному: «печатает…», затем текст.
    dyn: (q, el) => {
      const step = Math.min(3500, (round().time * 1000 * 0.55) / q.messages.length);
      const shown = Math.min(q.messages.length, Math.floor((el - 400) / step) + 1);
      const box = $('#msgs');
      if (!box) return;
      while (box.children.length < shown) {
        const i = box.children.length;
        const div = document.createElement('div');
        div.className = `msg ${i % 2 ? 'r' : 'l'}`;
        div.innerHTML = `<div class="who">Абонент ${(i % 2) + 1}</div>${esc(q.messages[i])}`;
        box.appendChild(div);
      }
      $('#typing').textContent = shown < q.messages.length ? `Абонент ${(shown % 2) + 1} печатает…` : '';
    },
  },
  emblem: {
    html: (q, ans) => `
      <p class="qtext">🔰 ${esc(q.description)}</p>
      <div id="pic"><div class="wait-pic">Картинка появится через <b id="picin">10</b> с</div></div>
      ${ans ? `<p></p>${lockedHtml(ans)}` : textForm([
        { id: 'a1', label: 'Организация (+2)' },
        { id: 'a2', label: 'Любой участник (+1)' },
      ])}
      <p class="small muted">Ответ до появления картинки даёт ещё +1.</p>`,
    init: () => bindSend(() => (val('#a1') || val('#a2') ? { text: val('#a1'), text2: val('#a2') } : (toast('Напишите ответ'), null))),
    dyn: (q, el) => {
      const left = round().revealAt * 1000 - el;
      if (left > 0) { const s = $('#picin'); if (s) s.textContent = fmtTime(left); return; }
      const pic = $('#pic');
      if (pic && !pic.dataset.shown) {
        pic.dataset.shown = '1';
        pic.innerHTML = `<img class="emblem-img" src="${esc(q.image)}" alt="">`;
      }
    },
  },
  anagram: {
    html: (q, ans) => `
      <p class="qtext center" style="font-size:28px;letter-spacing:3px">${esc(q.anagram)}</p>
      <p class="center hint" id="hint"></p>
      ${ans ? lockedHtml(ans) : `
        <div class="small muted">Черновик: нажимайте на плитки, чтобы собрать имя (это видите только вы)</div>
        <div class="tiles" id="build"></div>
        <div class="tiles" id="pool"></div>
        <div class="row"><button class="sm" id="space">+ пробел</button><button class="sm" id="clear">Сбросить</button>
          <button class="sm" id="usebuild">Вставить в ответ</button></div>
        ${textForm([{ id: 'a1', label: 'Полное имя (+3, после подсказки +2)' }, { id: 'a2', label: 'Аниме (+1)' }])}`}`,
    init: (q) => {
      const pool = $('#pool');
      if (pool) {
        const key = `ana${st().round}_${st().q}`;
        const letters = [...q.anagram.replace(/\s/g, '')];
        if (!local[key]) local[key] = [];
        const built = local[key]; // индексы букв, -1 — пробел
        const draw = () => {
          $('#build').innerHTML = built.map((b, i) => `<button class="tile ${b < 0 ? 'space' : ''}" data-b="${i}">${b < 0 ? '' : letters[b]}</button>`).join('');
          pool.innerHTML = letters.map((l, i) => (built.includes(i) ? '' : `<button class="tile" data-p="${i}">${l}</button>`)).join('');
        };
        pool.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) { built.push(+b.dataset.p); draw(); } });
        $('#build').addEventListener('click', (e) => { const b = e.target.closest('[data-b]'); if (b) { built.splice(+b.dataset.b, 1); draw(); } });
        $('#space').addEventListener('click', () => { built.push(-1); draw(); });
        $('#clear').addEventListener('click', () => { built.length = 0; draw(); });
        $('#usebuild').addEventListener('click', () => {
          const s = built.map((b) => (b < 0 ? ' ' : letters[b])).join('').replace(/\s+/g, ' ').trim().toLowerCase();
          $('#a1').value = s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
        });
        draw();
      }
      bindSend(() => (val('#a1') || val('#a2') ? { text: val('#a1'), text2: val('#a2') } : (toast('Напишите ответ'), null)));
    },
    dyn: (q, el) => {
      const h = $('#hint');
      if (h && el >= round().hintAt * 1000 && !h.textContent) {
        h.textContent = 'Подсказка: ' + q.answer.split(' ').map((w) => w[0] + '…').join(' ');
      }
    },
  },
  frame: {
    html: (q, ans) => `
      <div class="frame-wrap"><canvas id="cv" width="640" height="360"></canvas></div>
      <div class="stages" id="stages">${round().blocks.map((b, i) => `<span>${4 - i > 0 ? '+' + (4 - i) : ''} ${b ? b + ' бл.' : 'оригинал'}</span>`).join('')}</div>
      ${ans ? lockedHtml(ans) : `${textForm([{ id: 'a1', label: 'Из какого это аниме?' }])}<p class="small muted">Неверный ответ — −1, исправить нельзя.</p>`}`,
    init: (q) => {
      const img = new Image();
      img.onload = () => { local.frameImg = img; local.frameStage = -1; };
      img.src = q.image;
      local.frameImg = null;
      bindSend(() => (val('#a1') ? { text: val('#a1') } : (toast('Напишите ответ'), null)));
    },
    dyn: (q, el) => {
      const r = round();
      const stage = frameStage(r, el);
      const img = local.frameImg;
      document.querySelectorAll('#stages span').forEach((s, i) => s.classList.toggle('cur', i === stage));
      if (!img || local.frameStage === stage) return;
      local.frameStage = stage;
      const cv = $('#cv');
      const ctx = cv.getContext('2d');
      cv.width = Math.min(960, img.naturalWidth);
      cv.height = Math.round(cv.width * img.naturalHeight / img.naturalWidth);
      const blocks = r.blocks[stage];
      if (!blocks) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        return;
      }
      const w = blocks;
      const h = Math.max(1, Math.round(blocks * img.naturalHeight / img.naturalWidth));
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      tmp.getContext('2d').drawImage(img, 0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, w, h, 0, 0, cv.width, cv.height);
    },
  },
  final: {
    html: (q, ans, sub) => {
      const r = round();
      const scores = computeScores(tree, quiz);
      const cap = betCap(scores.totals[me.team]);
      const bet = tree.bets?.[`q${st().q}`]?.[`t${me.team}`]?.bet;
      if (sub === 'bet') {
        return `
          <div class="muted center">Тема вопроса</div>
          <div class="topic">${esc(q.topic)}</div>
          <p class="center">Ставка команды (у вас ${scores.totals[me.team]} б., можно поставить до ${cap}):</p>
          <div class="bets">${[1, 2, 3, 4, 5].map((b) => `<button data-bet="${b}" class="${(bet || 1) === b ? 'on' : ''}" ${b > cap ? 'disabled' : ''}>${b}</button>`).join('')}</div>
          <p class="center small muted">${bet ? `Текущая ставка: ${bet}` : 'Если не выбрать, ставка будет 1'}. Выбрать может любой из команды.</p>`;
      }
      return `
        <span class="anime-tag">${esc(q.topic)}</span> <span class="badge">Ставка: ${bet || 1}</span>
        <p class="qtext">${esc(q.question)}</p>
        ${ans ? lockedHtml(ans) : textForm([{ id: 'a1', label: 'Ответ' }])}
        <p class="small muted">Верно — +${bet || 1}, неверно или без ответа — −${bet || 1}.</p>`;
    },
    init: () => {
      document.querySelectorAll('[data-bet]').forEach((b) =>
        b.addEventListener('click', () => api.put(`bets/q${st().q}/t${me.team}`, { bet: +b.dataset.bet, by: me.name }).catch(() => toast('Не удалось сохранить ставку')))
      );
      bindSend(() => (val('#a1') ? { text: val('#a1') } : (toast('Напишите ответ'), null)));
    },
  },
};

function questionHtml(sub) {
  const r = round();
  const q = question();
  const view = VIEWS[r.type];
  const ans = r.type === 'final' && sub === 'bet' ? null : teamAnswer();
  return `<div class="card">${headHtml()}${view.html(q, ans, sub)}</div>`;
}

function pauseHtml() {
  const r = round();
  const q = question();
  const ans = teamAnswer();
  const last = st().q + 1 >= r.questions.length;
  return `
    <div class="card center">
      <div class="muted">Задание ${st().round + 1}: ${esc(r.title)}, вопрос ${st().q + 1} из ${r.questions.length}</div>
      <h2>${ans ? 'Ответ принят' : 'Время вышло'}</h2>
      ${ans ? `<p>Ваша команда: <b>${esc(answerText(r, q, ans))}</b></p>` : '<p class="muted">Ваша команда не ответила</p>'}
      ${r.type === 'truefalse' ? `<p class="answer-key">${q.answer ? '👍 Правда' : '👎 Ложь'}: ${esc(q.explain)}</p>` : ''}
      <p class="muted">${last ? 'Раунд заканчивается через' : 'Следующий вопрос через'} <b id="pausein">–</b> с</p>
    </div>`;
}

// ---------- Отрисовка ----------
function currentKey() {
  if (!loaded) return 'loading';
  if (!isJoined()) return 'join|' + JSON.stringify(tree.players || {}) + (local.joinTeam ?? '');
  const s = st();
  const base = `${s.phase}|${s.round}|${s.q}|${me.team}`;
  switch (s.phase) {
    case 'question': {
      const r = round();
      const sub = r.type === 'final' ? (elapsed(s) < r.betTime * 1000 ? 'bet' : 'answer') : '';
      const bet = r.type === 'final' ? tree.bets?.[`q${s.q}`]?.[`t${me.team}`]?.bet : '';
      return `${base}|${sub}|${bet}|${teamAnswer() ? 1 : 0}`;
    }
    case 'pause': return `${base}|${teamAnswer() ? 1 : 0}`;
    case 'reveal': return `${base}|${s.revealQ}|${JSON.stringify(tree.marks?.[`r${s.round}`] || {})}`;
    case 'lobby':
    case 'roundEnd':
      return `${base}|${JSON.stringify(tree.players || {})}|${JSON.stringify(tree.teams || {})}|${JSON.stringify(computeScores(tree, quiz).totals)}`;
  }
  return base;
}

function render(key) {
  dynamic = null;
  if (key === 'loading') return;
  if (key.startsWith('join')) {
    main().innerHTML = joinHtml();
    return initJoin();
  }
  const s = st();
  switch (s.phase) {
    case 'intro': main().innerHTML = introHtml(); break;
    case 'roundEnd': main().innerHTML = roundEndHtml(); break;
    case 'reveal': main().innerHTML = revealHtml(); break;
    case 'pause':
      main().innerHTML = pauseHtml();
      dynamic = () => { const p = $('#pausein'); if (p) p.textContent = fmtTime(st().pauseEnd - (st().frozenAt || now())); };
      break;
    case 'question': {
      const r = round();
      const sub = key.split('|')[4];
      main().innerHTML = questionHtml(sub);
      const view = VIEWS[r.type];
      view.init(question());
      dynamic = () => {
        const s2 = st();
        const el = elapsed(s2);
        let left = questionDuration(r) - el;
        let total = questionDuration(r);
        if (r.type === 'final') {
          if (el < r.betTime * 1000) { left = r.betTime * 1000 - el; total = r.betTime * 1000; }
          else total = r.time * 1000;
        }
        if (r.type === 'frame') { const stage = (r.stageTime * 1000); left = stage - (el % stage); total = stage; if (el >= questionDuration(r)) left = 0; }
        const t = $('#timer');
        if (t) { t.textContent = fmtTime(left); t.classList.toggle('low', left < 5000); }
        const b = $('#bar');
        if (b) b.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
        view.dyn?.(question(), el);
      };
      break;
    }
    default: main().innerHTML = lobbyHtml();
  }
}

function renderOverlay() {
  const s = st();
  const ov = $('#overlay');
  if (isJoined() && s.frozenAt) {
    ov.innerHTML = '<div class="card center"><div class="big">⏸</div><h2>Пауза</h2><p class="muted">Ведущий остановил игру</p></div>';
    ov.classList.remove('hidden');
  } else if (isJoined() && s.showBoard) {
    ov.innerHTML = `<div class="card"><h2 class="center">🏆 Табло</h2>${boardHtml(tree, quiz, computeScores(tree, quiz))}</div>`;
    ov.classList.remove('hidden');
  } else {
    ov.classList.add('hidden');
  }
}

function renderTop() {
  $('#me').innerHTML = isJoined()
    ? `<span class="dot" style="background:${TEAM_COLORS[me.team]}"></span> ${esc(me.name)} · ${esc(teamName(tree, quiz, me.team))}
       <button class="sm" id="leave" title="Выйти">✕</button>`
    : '';
  $('#leave')?.addEventListener('click', async () => {
    if (!confirm('Выйти из команды?')) return;
    await api.del(`players/${me.id}`).catch(() => {});
    saveMe(null);
    screenKey = '';
    update();
  });
}

let topKey = '';
function update() {
  const key = currentKey();
  if (key !== screenKey) {
    screenKey = key;
    render(key);
  }
  const tk = isJoined() ? `${me.id}|${tree.teams?.[me.team]?.name}` : '';
  if (tk !== topKey) { topKey = tk; renderTop(); }
  renderOverlay();
  dynamic?.();
}

(async function start() {
  quiz = await loadQuiz();
  document.title = quiz.title;
  $('#title').textContent = quiz.title;
  await syncClock().catch(() => {});
  subscribe(
    (t) => {
      tree = t || {};
      loaded = true;
      // если игрока удалили (сброс игры) — забываем его, но оставляем ник
      if (me && !tree.players?.[me.id]) local.nick = local.nick || me.name;
      update();
    },
    (s) => { $('#conn').className = 'dot status-' + s; $('#conn').title = { live: 'Связь есть', poll: 'Связь через опрос', offline: 'Нет связи' }[s]; }
  );
  setInterval(update, 150);
})();
