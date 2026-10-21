// ============================================================================
// ШИФРОПАНК — змейка: мини-игра на время долгого ожидания своего хода.
// Если чужой ход длится больше 2 минут, всплывает предложение сыграть.
// Окно маленькое и перетаскиваемое, игра НЕ прерывается: когда ваш ход
// наступает, заголовок окна мигает и приходит уведомление.
//
// ТАБЛИЦА ЛИДЕРОВ: после смерти показываются ваш счёт и топ-3 сессии
// (сессия = пока открыта страница).
// КРАСНЫЙ ПИКСЕЛЬ: после 20 очков каждая новая еда с шансом 5% — красная.
// Съели — проваливаетесь в змейку случайного соседа по комнате: PvP на
// общем поле (арбитр — сервер), столкновение со стеной или ЛЮБОЙ змейкой —
// смерть.
// ============================================================================
const SNAKE = (() => {
  const WAIT_MS = 120000;   // 2 минуты ожидания -> предложение
  const CELL = 15;          // размер клетки поля, px
  const GRID = 16;          // поле 16×16 клеток (как на сервере)
  const TICK_MS = 130;      // скорость змейки
  const RED_MIN_SCORE = 20; // красный пиксель появляется только после 20 очков
  const RED_CHANCE = 0.05;  // ...с шансом 5% на каждую новую еду

  let waitStart = null;     // когда началось текущее ожидание чужого хода
  let offerShown = false;   // предложение уже показано в этом ожидании
  let playing = false;      // окно змейки открыто и игра идёт
  let loop = null;          // setInterval игрового цикла (только одиночная)

  // состояние одиночной змейки
  let snake, dir, dirQueue, food, score, dead;
  let sessionTop = [];      // топ сессии: [{ name, score }] — живёт до перезагрузки страницы
  let waitingPvp = false;   // съели красный пиксель, ждём ответ сервера
  let pvp = null;           // PvP-режим: последний снимок от сервера

  const myName = () => {
    const lp = NET.lobby && NET.lobby.players && NET.lobby.players.find(p => p.id === NET.myId);
    return (lp && lp.name) || 'вы';
  };

  function resetGame() {
    snake = [{ x: 7, y: 8 }, { x: 6, y: 8 }, { x: 5, y: 8 }];
    dir = { x: 1, y: 0 };
    dirQueue = [];
    score = 0;
    dead = false;
    placeFood();
  }

  function placeFood() {
    do {
      food = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
    } while (snake.some(s => s.x === food.x && s.y === food.y));
    // После 20 очков — шанс 5%, что еда будет КРАСНОЙ (портал в PvP-змейку).
    food.red = score >= RED_MIN_SCORE && Math.random() < RED_CHANCE;
  }

  // Смерть в одиночной: запоминаем счёт в топ сессии.
  // Один игрок — одна строка: повторная игра обновляет запись, только если
  // побит личный рекорд. Топ нельзя «захватить» серией партий.
  function recordScore() {
    if (score <= 0) return;
    const name = myName();
    const mine = sessionTop.find(r => r.name === name);
    if (mine) mine.score = Math.max(mine.score, score);
    else sessionTop.push({ name, score });
    sessionTop.sort((a, b) => b.score - a.score);
    sessionTop = sessionTop.slice(0, 10); // храним чуть больше тройки — показываем топ-3
  }

  function step() {
    if (dead) return;
    if (dirQueue.length) dir = dirQueue.shift();
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    // Стены и собственный хвост — смерть (классика).
    if (head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID ||
        snake.some(s => s.x === head.x && s.y === head.y)) {
      dead = true;
      recordScore();
      draw();
      return;
    }
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      if (food.red) { enterPvp(); return; } // красный пиксель — портал в чужую змейку
      score++;
      placeFood();
    } else {
      snake.pop();
    }
    draw();
  }

  // Красный пиксель съеден: просим сервер подобрать случайного соседа
  // по комнате. Одиночная игра замораживается до ответа.
  function enterPvp() {
    waitingPvp = true;
    clearInterval(loop); loop = null;
    socket.emit('snake:pvp');
    draw();
  }

  function draw() {
    const cv = $('snake-canvas');
    const ctx = cv.getContext('2d');
    // фон — «матричная» сетка
    ctx.fillStyle = '#020a05';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = 'rgba(0,255,156,.07)';
    for (let i = 0; i <= GRID; i++) {
      ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, cv.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(cv.width, i * CELL); ctx.stroke();
    }
    // еда — янтарная; красная — портал в PvP
    ctx.fillStyle = food.red ? '#ff3860' : '#ffd740';
    ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8;
    ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
    // змейка — зелёная, голова ярче
    snake.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? '#7dffcb' : '#00ff9c';
      ctx.shadowColor = '#00ff9c'; ctx.shadowBlur = i === 0 ? 10 : 4;
      ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
    });
    ctx.shadowBlur = 0;
    if (dead) {
      ctx.fillStyle = 'rgba(2,10,5,.78)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#ff3860';
      ctx.font = 'bold 15px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('СИГНАЛ ПОТЕРЯН', cv.width / 2, 84);
      ctx.fillStyle = '#00ff9c';
      ctx.font = '11px monospace';
      ctx.fillText(`счёт: ${score}`, cv.width / 2, 104);
      // Топ-3 сессии.
      ctx.fillStyle = '#ffd740';
      ctx.fillText('— топ сессии —', cv.width / 2, 126);
      ctx.fillStyle = '#00ff9c';
      const top3 = sessionTop.slice(0, 3);
      if (!top3.length) ctx.fillText('пока пусто', cv.width / 2, 142);
      top3.forEach((r, i) => {
        ctx.fillText(`${i + 1}. ${r.name} — ${r.score}`, cv.width / 2, 142 + i * 14);
      });
      ctx.fillStyle = '#557a66';
      ctx.fillText('стрелка / свайп — заново', cv.width / 2, 200);
    }
    if (waitingPvp) {
      ctx.fillStyle = 'rgba(2,10,5,.78)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#ff3860';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('КРАСНЫЙ ПИКСЕЛЬ!', cv.width / 2, cv.height / 2 - 10);
      ctx.fillStyle = '#00ff9c';
      ctx.fillText('проваливаемся в чужую змейку...', cv.width / 2, cv.height / 2 + 10);
    }
    $('snake-score').textContent = String(score);
  }

  // ---------- PvP: поле общее, арбитр — сервер ----------
  function drawPvp() {
    const cv = $('snake-canvas');
    const ctx = cv.getContext('2d');
    const snap = pvp;
    ctx.fillStyle = '#020a05';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = 'rgba(0,255,156,.07)';
    for (let i = 0; i <= GRID; i++) {
      ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, cv.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(cv.width, i * CELL); ctx.stroke();
    }
    // еда
    ctx.fillStyle = '#ffd740';
    ctx.shadowColor = '#ffd740'; ctx.shadowBlur = 8;
    ctx.fillRect(snap.food.x * CELL + 2, snap.food.y * CELL + 2, CELL - 4, CELL - 4);
    // змейки: своя ярче, чужая — её цветом
    for (const pid of snap.players) {
      const body = snap.snakes[pid];
      const color = snap.colors[pid] || '#00ff9c';
      const mine = pid === NET.myId;
      body.forEach((s, i) => {
        ctx.fillStyle = i === 0 ? '#ffffff' : color;
        ctx.shadowColor = color; ctx.shadowBlur = i === 0 ? 10 : 4;
        ctx.globalAlpha = snap.alive[pid] ? 1 : 0.35;
        ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
        ctx.globalAlpha = 1;
      });
      if (mine) { /* своя голова белая */ }
    }
    ctx.shadowBlur = 0;
    const other = snap.players.find(id => id !== NET.myId);
    $('snake-score').textContent = `${snap.scores[NET.myId]} : ${snap.scores[other]}`;
  }

  function pvpOver(res) {
    if (!pvp) return;
    drawPvp();
    const cv = $('snake-canvas');
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(2,10,5,.78)';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.textAlign = 'center';
    const iWon = res.reason !== 'draw' && res.alive[NET.myId];
    ctx.fillStyle = res.reason === 'draw' ? '#ffd740' : iWon ? '#00ff9c' : '#ff3860';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(res.reason === 'draw' ? 'НИЧЬЯ' : iWon ? 'ПОБЕДА В PVP' : 'СИГНАЛ ПОТЕРЯН', cv.width / 2, 100);
    ctx.fillStyle = '#00ff9c';
    ctx.font = '11px monospace';
    const other = res.players.find(id => id !== NET.myId);
    const on = res.names[other] || '???';
    ctx.fillText(`вы ${res.scores[NET.myId]} : ${res.scores[other]} ${on}`, cv.width / 2, 122);
    ctx.fillStyle = '#557a66';
    ctx.fillText('стрелка / свайп — одиночная игра', cv.width / 2, 148);
    pvp = null; // дальше — обычная змейка
    dead = true; // первое же нажатие начнёт новую одиночную партию
    snake = snake || [{ x: 7, y: 8 }]; // draw() не упадёт, если позовут
    food = food || { x: 3, y: 3 };
    score = 0;
  }

  function onKey(e) {
    if (!playing) return;
    // Не перехватываем клавиши, когда печатают в чате или другом поле.
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const map = {
      ArrowUp: { x: 0, y: -1 }, KeyW: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 }, KeyS: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 }, KeyA: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 }, KeyD: { x: 1, y: 0 },
    };
    const nd = map[e.code];
    if (!nd) return;
    e.preventDefault();
    applyDir(nd);
  }

  // Единая точка для клавиш и свайпов.
  function applyDir(nd) {
    if (pvp) { socket.emit('snake:dir', nd); return; } // в PvP арбитр — сервер
    if (waitingPvp) return;
    if (dead) { startSolo(); return; }
    pushDir(nd);
  }

  // Новая одиночная партия (после смерти или после PvP).
  function startSolo() {
    resetGame();
    draw();
    if (!loop) loop = setInterval(step, TICK_MS);
  }

  // Поворот змейки: запрет разворота на 180° (смотрим на ПОСЛЕДНЕЕ
  // поставленное в очередь), очередь хранит максимум 3 поворота.
  function pushDir(nd) {
    const last = dirQueue.length ? dirQueue[dirQueue.length - 1] : dir;
    if (nd.x === -last.x && nd.y === -last.y) return;
    if (dirQueue.length < 3) dirQueue.push(nd);
  }

  // Свайп-управление на телефоне: направление = доминирующая ось свайпа.
  // Привязываемся к игровому полю, чтобы не мешать перетаскиванию окна
  // за заголовок.
  function bindSwipe() {
    const cv = $('snake-canvas');
    let start = null;
    cv.addEventListener('touchstart', (e) => {
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    cv.addEventListener('touchmove', (e) => {
      if (!start || !playing) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return; // мёртвая зона
      const nd = Math.abs(dx) > Math.abs(dy)
        ? { x: Math.sign(dx), y: 0 }
        : { x: 0, y: Math.sign(dy) };
      applyDir(nd);
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      e.preventDefault(); // поле не даём скроллить страницу
    }, { passive: false });
    cv.addEventListener('touchend', () => { start = null; });
  }

  function openWindow() {
    $('snake-offer').classList.add('hidden');
    $('snake-window').classList.remove('hidden');
    playing = true;
    pvp = null;
    waitingPvp = false;
    socket.emit('snake:playing'); // сервер: мы — легальная цель для чужого красного пикселя
    startSolo();
  }

  function closeWindow() {
    playing = false;
    clearInterval(loop); loop = null;
    if (pvp) socket.emit('snake:leave'); // вышел из PvP — змейка погибает
    socket.emit('snake:idle');           // сервер: в PvP нас больше не дёргать
    pvp = null;
    waitingPvp = false;
    $('snake-window').classList.add('hidden');
  }

  function resetWait() {
    waitStart = null;
    offerShown = false;
    $('snake-offer').classList.add('hidden');
  }

  // Следим за ходом: чужой ход затянулся — предлагаем змейку.
  function watch() {
    const s = NET.state;
    if (NET.phase !== 'game' || !s || s.over) { resetWait(); return; }
    const myTurn = s.order[s.turnIndex] === NET.myId;
    if (myTurn) {
      // Ход наступил — если играем, мигаем заголовком и напоминаем.
      if (playing) {
        $('snake-window').classList.add('my-turn');
        FX.toast('>> ВАШ ХОД << — змейка подождёт.');
        FX.sfx.turn();
      }
      resetWait();
      return;
    }
    $('snake-window').classList.remove('my-turn');
    if (waitStart === null) waitStart = Date.now();
    if (!offerShown && Date.now() - waitStart >= WAIT_MS) {
      offerShown = true;
      $('snake-offer').classList.remove('hidden');
      FX.sfx.chat();
    }
  }

  function init() {
    setInterval(watch, 1000); // раз в секунду проверяем длительность ожидания
    $('snake-yes').addEventListener('click', openWindow);
    $('snake-no').addEventListener('click', () => $('snake-offer').classList.add('hidden'));
    $('snake-close').addEventListener('click', closeWindow);
    document.addEventListener('keydown', onKey);
    bindSwipe(); // телефон: свайпы по полю змейки

    // --- PvP по сети (арбитр — сервер) ---
    // Нас выбрали «хозяином» чужого красного пикселя (или мы сами съели его):
    // окно открывается само, одиночная партия глохнет.
    socket.on('snake:pvpStart', (snap) => {
      clearInterval(loop); loop = null;
      waitingPvp = false;
      pvp = snap;
      playing = true;
      $('snake-offer').classList.add('hidden');
      $('snake-window').classList.remove('hidden');
      drawPvp();
      const other = snap.players.find(id => id !== NET.myId);
      FX.toast(`🐍 PVP-ЗМЕЙКА: ${snap.names[other] || '???'} на общем поле! Столкновение — смерть.`);
      FX.sfx.turn();
    });
    socket.on('snake:pvpState', (snap) => { if (pvp) { pvp = snap; drawPvp(); } });
    socket.on('snake:pvpOver', pvpOver);
    socket.on('snake:pvpFail', ({ reason }) => {
      FX.toast(reason || 'PvP не состоялось.');
      if (waitingPvp) { waitingPvp = false; startSolo(); } // продолжаем одиночную
    });

    // Перетаскивание окна за заголовок (как у радио).
    const win = $('snake-window');
    let drag = null;
    $('snake-title').addEventListener('mousedown', (e) => {
      if (e.target.closest('#snake-close')) return;
      const r = win.getBoundingClientRect();
      drag = { dx: e.clientX - r.x, dy: e.clientY - r.y };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      win.style.left = Math.max(0, Math.min(window.innerWidth - 120, e.clientX - drag.dx)) + 'px';
      win.style.top = Math.max(0, Math.min(window.innerHeight - 60, e.clientY - drag.dy)) + 'px';
      win.style.right = 'auto';
      win.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = null; });
  }

  return { init };
})();
