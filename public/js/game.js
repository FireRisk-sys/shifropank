// ============================================================================
// ШИФРОПАНК — игровой экран: слоты, рука, карта, таргетинг, таймер.
// ============================================================================
const GAME = (() => {
  let pending = null;        // { uid, indices, prog } — программа ждёт выбора цели

  // Узоры «Сломанной системы» (зеркало BROKEN_PATTERNS в engine.js).
  // Выбранная клетка — ЦЕНТР узора; углы смотрят во все 4 стороны.
  const BROKEN_PATTERN_OFFSETS = {
    h:  [[-1, 0], [0, 0], [1, 0]],
    v:  [[0, -1], [0, 0], [0, 1]],
    d1: [[-1, -1], [0, 0], [1, 1]],
    d2: [[-1, 1], [0, 0], [1, -1]],
    cornerTL: [[0, 0], [1, 0], [0, 1]],
    cornerTR: [[0, 0], [-1, 0], [0, 1]],
    cornerBL: [[0, 0], [1, 0], [0, -1]],
    cornerBR: [[0, 0], [-1, 0], [0, -1]],
  };
  // Куб Data_Error 4×4, клик = центр (зеркало эффекта в engine.js).
  const DATA_ERROR_OFFSETS = [];
  for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) DATA_ERROR_OFFSETS.push([dx, dy]);

  // Превью области эффекта под курсором (Сломанная система, Data_Error).
  // Читает ТЕКУЩИЙ pending, поэтому после розыгрыша программы призрак
  // больше не появляется.
  function onCellHover(x, y) {
    if (!pending || !pending.prog) return;
    let offsets = null;
    if (pending.prog.id === 'broken-system') offsets = BROKEN_PATTERN_OFFSETS[pending.pattern || 'h'];
    else if (pending.prog.id === 'data-error') offsets = DATA_ERROR_OFFSETS;
    if (!offsets) return;
    document.querySelectorAll('#game-map .cell.pattern-preview').forEach(c => c.classList.remove('pattern-preview'));
    for (const [dx, dy] of offsets) {
      const c = document.querySelector(`#game-map .cell[data-x="${x + dx}"][data-y="${y + dy}"]`);
      if (c) c.classList.add('pattern-preview');
    }
  }
  let timerEndsAt = 0;
  let timerInterval = null;
  let mapDrawnFor = null;

  const progById = (id) => NET.meta.programs.find(p => p.id === id);
  const key = (x, y) => `${x},${y}`;
  const cheb = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  // ---------- геометрия (дублирует сервер для подсветки) ----------
  function objectAt(x, y) { return NET.state.map.objects[key(x, y)] || null; }
  function copyAt(x, y) { return (NET.state.copies || {})[key(x, y)] || null; }
  function pawnAt(x, y) {
    return NET.state.players.find(p => p.alive && p.pos && p.pos.x === x && p.pos.y === y) || null;
  }

  // peer-to-peer: если я подключён к другому игроку (statuses.p2pTarget),
  // мои карты исполняются С ЕГО пешки — дальность, видимость и подсветка
  // целей считаются от него. Без связи «точка исполнения» — я сам.
  function anchor() {
    const m = me();
    if (m && m.statuses && m.statuses.p2pTarget) {
      const linked = NET.state.players.find(p => p.id === m.statuses.p2pTarget && p.alive && p.pos);
      if (linked) return linked;
    }
    return m;
  }
  function isFree(x, y) {
    const { w, h } = NET.state.map;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const o = objectAt(x, y);
    if (o && !o.walkable) return false;
    if (copyAt(x, y)) return false; // копия занимает клетку, как пешка
    return !pawnAt(x, y);
  }
  function bfs(from, maxSteps) {
    // 4 направления — как на сервере.
    const seen = new Set([key(from.x, from.y)]);
    const out = new Set();
    let frontier = [from];
    for (let s = 0; s < maxSteps; s++) {
      const next = [];
      for (const c of frontier) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = c.x + dx, ny = c.y + dy, k = key(nx, ny);
          if (seen.has(k) || !isFree(nx, ny)) continue;
          seen.add(k); out.add(k); next.push({ x: nx, y: ny });
        }
      }
      frontier = next;
    }
    return out;
  }
  function los(a, b) {
    let x0 = a.x, y0 = a.y;
    const dx = Math.abs(b.x - x0), dy = Math.abs(b.y - y0);
    const sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1;
    let err = dx - dy;
    while (!(x0 === b.x && y0 === b.y)) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
      if (x0 === b.x && y0 === b.y) break;
      const o = objectAt(x0, y0);
      if (o && !o.walkable) return false;
    }
    return true;
  }

  // ---------- «лаги» интерфейса при низком ХП ----------
  // Короткие помехи каждые несколько секунд: заметно, что система умирает,
  // но играть остаётся возможно.
  let lowHpTimer = null;
  function startLowHpFx() {
    if (lowHpTimer) return;
    document.body.classList.add('low-hp');
    const tick = () => {
      FX.glitchBurst(260, false);           // короткая вспышка помех
      document.body.classList.add('ui-lag'); // интерфейс «дёргается»
      setTimeout(() => document.body.classList.remove('ui-lag'), 320);
      lowHpTimer = setTimeout(tick, 2600 + Math.random() * 1800);
    };
    lowHpTimer = setTimeout(tick, 1200);
  }
  function stopLowHpFx() {
    if (lowHpTimer) { clearTimeout(lowHpTimer); lowHpTimer = null; }
    document.body.classList.remove('low-hp', 'ui-lag');
  }

  // ---------- лёгкий «лаг» экрана при перегреве военного интерфейса ----------
  // Отдельный, более слабый эффект, чем при низком ХП: редкие микро-подёргивания.
  let overheatTimer = null;
  function startOverheatFx() {
    if (overheatTimer) return;
    const tick = () => {
      document.body.classList.add('ui-lag-soft');
      setTimeout(() => document.body.classList.remove('ui-lag-soft'), 240);
      overheatTimer = setTimeout(tick, 1500 + Math.random() * 1700);
    };
    overheatTimer = setTimeout(tick, 700);
  }
  function stopOverheatFx() {
    if (overheatTimer) { clearTimeout(overheatTimer); overheatTimer = null; }
    document.body.classList.remove('ui-lag-soft');
  }

  // ---------- верхняя панель ----------
  function renderTopbar() {
    const cur = currentTurnPlayer();
    const m = me();
    $('turn-banner').textContent = NET.state.over
      ? '// СЕССИЯ ЗАВЕРШЕНА //'
      : isMyTurn() ? '>> ВАШ ХОД <<' : `ХОД: ${cur ? cur.name : '...'}`;
    // Пульс баннера в свой ход — заметно даже краем глаза.
    $('turn-banner').classList.toggle('mine', !NET.state.over && isMyTurn());
    if (m) {
      // В режиме захвата показываем очки; иначе — просто раунд.
      const cap = NET.state.settings.mode === 'capture'
        ? ` | ОЧКИ <b>${m.capturePoints || 0}</b>/${NET.state.settings.capturePoints}` : '';
      // Антивирус: до пробуждения — счётчик раунда, после — его тип.
      const av = NET.state.antivirus;
      const AV_NAMES = { shuffle: 'ПЕРЕСБОРКА КАРТЫ', damage: 'ПЕРЕГРУЗКА СЕТИ', ban: 'КАРАНТИН ПРОГРАММ', teleport: 'ПРЫЖКИ УЗЛОВ' };
      const avText = av && av.round > 0
        ? (av.active ? ` | <span class="av-on">⚠ АНТИВИРУС: ${AV_NAMES[av.resolved] || '?'}</span>`
                     : ` | <span class="dim">⚠ антивирус: раунд ${av.round}</span>`)
        : '';
      $('my-stats').innerHTML = `ХП <b>${m.hp}</b> | МОЩНОСТЬ <i>${m.power}</i> | РАУНД ${NET.state.round}${cap}${avText}`;
      const oh = $('overheat-btn');
      const showOh = m.interfaceId === 'mil' && isMyTurn() && m.alive && !NET.state.over;
      oh.classList.toggle('hidden', !showOh);
      // Матрица: кнопка таблицы ставок в топбаре — на месте «перегрева» военного.
      $('matrix-help-btn').classList.toggle('hidden', !(m.interfaceId === 'matrix' && m.alive && !NET.state.over));
      oh.disabled = m.statuses.overheat;
      document.body.classList.toggle('overheat', !!m.statuses.overheat);
      // Пока перегрев включён — интерфейс военного слегка «лагает».
      if (m.statuses.overheat && m.alive && !NET.state.over) startOverheatFx(); else stopOverheatFx();
      // трещины + «лагающий» интерфейс при низком ХП
      if (m.alive && m.hp < 5) { FX.crack(true); startLowHpFx(); }
      else { $('crack-overlay').classList.remove('perma'); stopLowHpFx(); }
    }
    $('endturn-btn').disabled = !isMyTurn() || NET.state.over;
  }

  // ---------- список игроков ----------
  const ifaceShort = (id) => {
    const i = (NET.meta.interfaces || []).find(x => x.id === id);
    return i ? (i.short || i.name) : '—';
  };

  function renderPlayers() {
    const ul = $('game-players');
    ul.innerHTML = '';
    const slots = NET.state.slots || [];
    const capture = NET.state.settings.mode === 'capture';
    const teams = !!NET.state.settings.teamsEnabled;
    // Хост (первый в лобби) — админ сессии: видит кнопки кика.
    const amHost = NET.lobby && NET.lobby.players[0] && NET.lobby.players[0].id === NET.myId;
    NET.state.order.forEach((pid, idx) => {
      const p = NET.state.players.find(pl => pl.id === pid);
      if (!p) return;
      const isCur = idx === NET.state.turnIndex && !NET.state.over;
      const li = document.createElement('li');
      if (isCur) li.classList.add('current-turn');
      if (!p.alive) li.classList.add('dead');
      const tags = [];
      // Активные защиты и инкогнито — тайна владельца: чужие их не видят
      // (ни тегами тут, ни кольцами на пешке). DEBUG — служебный, виден всем.
      if (p.id === NET.myId) {
        if (p.incognito) tags.push('ИНКОГНИТО');
        if (p.statuses.firewall) tags.push(p.statuses.firewall > 1 ? `FW×${p.statuses.firewall}` : 'FW');
        if (p.statuses.aiDefense) tags.push('AI');
        if (p.statuses.reverseFlow) tags.push('REV');
        if (p.statuses.aimbot) tags.push('AIM');
        if (p.statuses.backupPower) tags.push('UPS');
        if (p.statuses.p2pTarget) tags.push('P2P');
      }
      if (p.debug) tags.push('DEBUG');
      // Значок команды (командный режим)
      const teamTag = teams && p.team != null
        ? `<span class="p-team" style="border-color:${LOBBY.TEAM_COLORS[p.team]};color:${LOBBY.TEAM_COLORS[p.team]}">${LOBBY.TEAM_NAMES[p.team]}</span>` : '';
      // Три строки: 1) номер, цвет, ник, интерфейс; 2) ХП/мощность (+очки, теги);
      // 3) слоты активного игрока. Длинный ник режется многоточием и ничего
      // не выталкивает — статы живут на своей строке.
      const slotsHtml = isCur && slots.length
        ? `<div class="p-line3"><span class="p-slots">${slots.map(s =>
            `<i class="bit ${s.closed ? 'bclosed' : s.value ? 'b1' : 'b0'}">${s.closed ? '✕' : s.value}</i>`).join('')}</span></div>`
        : '';
      li.innerHTML = `<div class="p-line1">
          <span class="dim">#${idx + 1}</span>
          <span class="p-color" style="background:${esc(p.color)}"></span>
          <span class="p-name" title="${esc(p.name)}">${esc(p.name)}</span>
          ${teamTag}
          <span class="p-iface" title="интерфейс">${esc(ifaceShort(p.interfaceId))}</span>
        </div>
        <div class="p-line2">
          <span class="p-hp">♥${p.hp}</span>
          <span class="p-pow">⚡${p.power}</span>
          ${capture ? `<span class="p-cap">◈${p.capturePoints || 0}</span>` : ''}
          ${tags.map(t => `<span class="p-tag">${t}</span>`).join('')}
        </div>
        ${slotsHtml}`;
      // Кнопка кика — только хосту и только на чужих строках.
      if (amHost && p.id !== NET.myId) {
        const kick = document.createElement('button');
        kick.className = 'kick-btn';
        kick.textContent = '✕';
        kick.title = 'исключить игрока из сессии (то же, что /kick в чате)';
        kick.addEventListener('click', () => {
          if (confirm(`Исключить ${p.name} из сессии?`)) socket.emit('player:kick', { name: p.name });
        });
        li.appendChild(kick);
      }
      ul.appendChild(li);
    });
  }

  // ---------- слоты ----------
  function openSlotSequence(startIdx, len) {
    // Возвращает индексы len открытых слотов начиная со startIdx (corp — через закрытые).
    const slots = NET.state.slots;
    const m = me();
    const corp = m && m.interfaceId === 'corp';
    const out = [];
    if (!slots[startIdx] || slots[startIdx].closed) return out;
    if (!corp) {
      for (let i = startIdx; i < startIdx + len; i++) {
        if (!slots[i] || slots[i].closed) return [];
        out.push(i);
      }
      return out;
    }
    for (let i = startIdx; i < slots.length && out.length < len; i++) {
      if (!slots[i].closed) out.push(i);
    }
    return out.length === len ? out : [];
  }

  // --- ЦЕНТРИРОВАННОЕ окно слотов ---
  // Приём перетаскивания — ВСЯ полоска: X курсора переводится в «координату
  // слота», и выбирается окно, чей ЦЕНТР ближе всего к курсору. Для нечётной
  // длины центр окна — средний слот (наводим на середину комбинации), для
  // чётной — шов между двумя средними слотами (наводим МЕЖДУ слотами).
  // У краёв полоски окно просто сдвигается до ближайшего помещающегося.
  // ВАЖНО: выбор окна чисто ПОЗИЦИОННЫЙ — на значения битов он не смотрит,
  // иначе подсветка светилась бы только над верной комбинацией («машем
  // картой, пока не засветится»). Значения проверяются в момент броска.
  let slotGeom = null; // { centers: [px, ...] } — меряем ОДИН раз за драг
  function ensureSlotGeom() {
    if (slotGeom) return slotGeom;
    const els = document.querySelectorAll('#slots-strip .slot');
    slotGeom = {
      centers: [...els].map(el => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      }),
    };
    return slotGeom;
  }
  // Ближайшее к курсору (по X) валидное окно из len открытых слотов.
  // Корп-окна (через закрытые) поддерживаются автоматически openSlotSequence.
  function windowForCursor(clientX, len) {
    const slots = NET.state.slots || [];
    if (!slots.length || len < 1 || len > slots.length) return [];
    const g = ensureSlotGeom();
    let best = null, bestD = Infinity;
    for (let s = 0; s < slots.length; s++) {
      const seq = openSlotSequence(s, len);
      if (seq.length !== len) continue;
      const cx = seq.reduce((sum, i) => sum + (g.centers[i] || 0), 0) / len;
      const d = Math.abs(cx - clientX);
      if (d < bestD - 0.001) { best = seq; bestD = d; } // при равенстве — левее
    }
    return best || [];
  }

  function renderSlots() {
    const strip = $('slots-strip');
    strip.innerHTML = '';
    // Слоты — личные. Полоску видит только тот, чей сейчас ход;
    // чужие слоты можно подсмотреть только в очереди игроков слева.
    if (!isMyTurn() || NET.state.over) {
      strip.innerHTML = '<span class="dim">— слоты появятся в начале вашего хода —</span>';
      return;
    }
    const slots = NET.state.slots || [];
    const m = me();
    const corp = m && m.interfaceId === 'corp';
    slots.forEach((s, i) => {
      const div = document.createElement('div');
      div.className = 'slot' + (s.value === 0 ? ' v0' : '') + (s.closed ? ' closed' + (corp ? ' corp' : '') : '')
        + (s.glitched && !s.closed ? ' glitched' : '') // перевёрнутый кустарным интерфейсом бит глитчит
        + (s.overheated && !s.closed ? ' overheated' : '') // перегретый слот военного: двойной урон, если не закрыть
        + (s.ideal && !s.closed ? ' ideal' : ''); // идеальный слот (джекпот Матрицы): считается и 0, и 1
      div.textContent = s.ideal && !s.closed ? '◆' : s.value;
      if (s.ideal && !s.closed) div.title = 'Идеальный слот (ДЖЕКПОТ Матрицы): считается и 0, и 1';
      div.dataset.idx = i;
      // Мобильный тап-режим: выбор слотов для «взведённой» карты.
      // Слушатель стоит ПЕРВЫМ: если тап обработан, глушим остальные клики
      // (debug-переворот, кустарный интерфейс) через stopImmediatePropagation.
      div.addEventListener('click', (ev) => { if (onSlotTap(i)) ev.stopImmediatePropagation(); });
      // Drop-зоны на слотах больше нет: приём перетаскивания — ВСЯ полоска
      // (обработчики в init), чтобы чётную программу можно было навести
      // МЕЖДУ слотами. Здесь остаётся только клик для переворота бита.
      // Режим отладки: клик по своему открытому слоту переворачивает бит.
      if (m && m.debug && isMyTurn() && !s.closed) {
        div.classList.add('dbg-flip');
        div.title = 'debug: перевернуть бит';
        div.addEventListener('click', () => socket.emit('debug:slots', { action: 'flip', index: i }));
      } else if (m && m.interfaceId === 'home' && isMyTurn() && !s.closed) {
        // Кустарный интерфейс: раз за свой ход — перевернуть один бит за 1 ХП.
        const used = m.statuses.homeFlipUsed;
        div.classList.add('home-flip');
        div.title = used
          ? 'Кустарный интерфейс: бит уже перевёрнут в этом ходу.'
          : 'КУСТАРНЫЙ ИНТЕРФЕЙС: перевернуть бит (−1 ХП, раз за ход)';
        if (!used) div.addEventListener('click', () => socket.emit('game:flipBit', { index: i }));
      }
      strip.appendChild(div);
    });
    // Тап-режим: после перерисовки возвращаем пометки уже выбранных слотов.
    if (tapPicked.length) {
      tapPicked.forEach(i => {
        const el = strip.querySelector(`.slot[data-idx="${i}"]`);
        if (el) el.classList.add('picked');
      });
    }
    if (!slots.length) {
      strip.innerHTML = '<span class="dim">— слоты появятся в начале вашего хода —</span>';
    }
  }

  let draggedCard = null; // { uid, progId, consumption }

  // ---------- перетаскивание карт ----------
  // Карта «достаётся из руки»: исходная в веере прячется (opacity:0, место
  // сохраняется), а за курсором следует свой призрак с pointer-events:none —
  // он не может перехватить наведение на слоты. Нативный призрак глушим
  // прозрачным пикселем. setData ОБЯЗАТЕЛЕН — без него Firefox не начинает драг.
  let blankDragImage = null;
  function getBlankDragImage() {
    if (!blankDragImage) {
      blankDragImage = document.createElement('div');
      blankDragImage.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;opacity:0;';
      document.body.appendChild(blankDragImage);
    }
    return blankDragImage;
  }
  let dragGhost = null;
  let dragGhostW = 0, dragGhostH = 0;     // размер призрака в css-px (меряем ОДИН раз)
  let ghostPendingX = 0, ghostPendingY = 0, ghostRaf = 0;
  // Множитель zoom интерфейса (🎨 ВИД → размер): translate() внутри body
  // масштабируется zoom'ом, а координаты курсора — экранные. Делим на zoom.
  function uiZoom() { return parseFloat(getComputedStyle(document.body).zoom) || 1; }
  // transform призрака: origin 0 0 + scale(.55) — центр призрака под курсором.
  function ghostTransform(x, y) {
    const z = uiZoom();
    const a = x / z - dragGhostW * 0.275;  // 0.275 = 0.55/2 (половина после scale)
    const b = y / z - dragGhostH * 0.275;
    return `translate(${a.toFixed(1)}px, ${b.toFixed(1)}px) scale(.55)`;
  }
  // Движение призрака — только через transform (композитор, без layout),
  // и не чаще одного кадра: dragover стреляет десятки раз в секунду,
  // а чтение offsetWidth на каждый вызов вызывало пересчёт раскладки и лаги.
  function moveDragGhost(x, y) {
    ghostPendingX = x; ghostPendingY = y;
    if (ghostRaf) return;
    ghostRaf = requestAnimationFrame(() => {
      ghostRaf = 0;
      if (!dragGhost) return;
      dragGhost.style.transform = ghostTransform(ghostPendingX, ghostPendingY);
    });
  }
  function onDragGhostMove(e) { moveDragGhost(e.clientX, e.clientY); }
  function showDragGhost(cardEl, x, y) {
    hideDragGhost();
    dragGhost = cardEl.cloneNode(true);
    dragGhost.classList.add('drag-ghost');
    dragGhost.classList.remove('dragging');
    dragGhost.style.setProperty('--fan-t', 'none');
    document.body.appendChild(dragGhost);
    // Единственный замер размеров за весь драг (принудительный layout — один раз).
    dragGhostW = dragGhost.offsetWidth;
    dragGhostH = dragGhost.offsetHeight;
    dragGhost.style.transform = ghostTransform(x, y);
    document.addEventListener('dragover', onDragGhostMove);
  }
  function hideDragGhost() {
    document.removeEventListener('dragover', onDragGhostMove);
    if (ghostRaf) { cancelAnimationFrame(ghostRaf); ghostRaf = 0; }
    if (dragGhost) { dragGhost.remove(); dragGhost = null; }
    slotGeom = null; // геометрию слотов меряем заново на следующий драг
    const strip = $('slots-strip');
    if (strip) strip.classList.remove('drag-even', 'drag-odd');
  }

  let lastHlKey = ''; // какое окно уже подсвечено ('' = ничего)
  function highlightSlots(clientX) {
    if (!draggedCard) return;
    // Подсветка позиционная: показывает, КАКИЕ слоты закроются при броске,
    // но не подсказывает, верные ли там биты — их игрок проверяет глазами.
    const seq = windowForCursor(clientX, draggedCard.consumption.length);
    const k = seq.join(',');
    // dragover стреляет непрерывно, даже когда курсор стоит на месте, —
    // без этого фильтра каждый тик перекрашивал всю полоску.
    if (k === lastHlKey) return;
    lastHlKey = k;
    document.querySelectorAll('#slots-strip .slot').forEach(el => {
      el.classList.toggle('hl', seq.includes(+el.dataset.idx));
    });
  }
  function clearSlotHighlight() {
    lastHlKey = '';
    document.querySelectorAll('#slots-strip .slot.hl').forEach(el => el.classList.remove('hl'));
  }

  function onSlotDrop(e) {
    e.preventDefault();
    // Страховка: если draggedCard потерялся (браузерные капризы), восстановим по uid.
    if (!draggedCard && e.dataTransfer) {
      const uid = e.dataTransfer.getData('text/plain');
      if (uid === '__cipher__' && NET.state.cipher) {
        draggedCard = { uid, progId: 'code-cipher', consumption: NET.state.cipher.consumption };
      } else {
        const m = me();
        if (uid && m) draggedCard = (m.hand || []).find(c => c.uid === uid) || null;
      }
    }
    if (!draggedCard) return;
    if (!isMyTurn() || NET.state.over) { draggedCard = null; return; }
    // Окно выбирается позиционно — ближайшее к курсору по центру (подсветка
    // его уже показывала). Значения проверяем только здесь, в момент броска.
    const indices = windowForCursor(e.clientX, draggedCard.consumption.length);
    const card = draggedCard;
    draggedCard = null;
    clearSlotHighlight();
    if (!validateCardSlots(card, indices)) return;
    commitCardPlay(card, indices);
  }

  // Общая проверка комбинации для драга и тапов: значения битов в выбранных
  // слотах должны совпасть с потреблением карты (слева направо).
  function validateCardSlots(card, indices) {
    if (!indices.length) { FX.errorBeep(); FX.toast('Сюда программу не вставить.'); return false; }
    const slots = NET.state.slots;
    for (let i = 0; i < indices.length; i++) {
      if (!slots[indices[i]].ideal && String(slots[indices[i]].value) !== card.consumption[i]) {
        FX.errorBeep();
        FX.toast('Комбинация не совпадает с потреблением.');
        return false;
      }
    }
    return true;
  }

  // Общий финал розыгрыша карты (мышь или тапы): КодШифр и программы «без
  // цели» уходят на сервер сразу, Андервольтинг ждёт выбора силы, остальные —
  // выбора цели на карте (режим pending).
  function commitCardPlay(card, indices) {
    const prog = progById(card.progId);
    if (prog.id === 'code-cipher') {
      // КодШифр — виртуальная карта точки контроля, цели не нужно.
      socket.emit('game:useProgram', { uid: '__cipher__', indices });
    } else if (prog.id === 'undervolt') {
      // Андервольтинг: сначала выбираем силу обмена (1–5), потом отправляем.
      pending = { uid: card.uid, indices, prog, needAmount: true };
      $('target-hint').textContent = 'АНДЕРВОЛЬТИНГ: выберите, сколько мощности обменять на ХП. Esc — отмена.';
      updateAmountPicker();
    } else if (prog.target === 'none') {
      socket.emit('game:useProgram', { uid: card.uid, indices });
    } else {
      pending = { uid: card.uid, indices, prog, pattern: 'h' };
      // При активной p2p-связи подсвечиваем, от чьей пешки считается дальность.
      const m0 = me();
      const linked0 = m0 && m0.statuses.p2pTarget
        ? NET.state.players.find(p => p.id === m0.statuses.p2pTarget) : null;
      const p2pNote = linked0 ? ` [P2P: от позиции ${linked0.name}]` : '';
      $('target-hint').textContent = prog.target === 'enemy'
        ? `Выберите цель (дальность ${prog.range}${p2pNote}). Esc — отмена.`
        : `Выберите клетку на карте${p2pNote}. Esc — отмена.`;
      updatePatternPicker();
      renderMap();
    }
  }

  // Панель выбора силы «Андервольтинга» (видна, только когда ждём число).
  function updateAmountPicker() {
    $('amount-picker').classList.toggle('hidden', !(pending && pending.needAmount));
  }

  // Выбор узора для «Сломанной системы» (3 битых пикселя).
  function updatePatternPicker() {
    const pp = $('pattern-picker');
    const show = !!(pending && pending.prog.id === 'broken-system');
    pp.classList.toggle('hidden', !show);
    if (!show) return;
    pp.querySelectorAll('.pattern-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.pattern === (pending.pattern || 'h'));
    });
  }

  // ---------- рука: веер карт, как в Hearthstone ----------
  // Веер — ЗАЦИКЛЕННАЯ прокручиваемая дуга: шаг между картами фиксированный,
  // «центр» крутится колёсиком мыши или стрелками ← → БЕСКОНЕЧНО: за последней
  // картой снова идёт первая. Одновременно видно не больше FAN_HALF*2+1 карт.
  // Чем дальше карта от центра — тем сильнее она завёрнута, ниже, мельче
  // и прозрачнее; наведение всё равно поднимает её полностью.
  const FAN_STEP = 8;     // градусов между соседними картами (фиксировано)
  const FAN_HALF = 4;     // полуширина окна: видно максимум 2*4+1 = 9 карт
  let fanCenter = 0;      // индекс карты в центре дуги (может быть x.5)
  let fanPrevLen = 0;     // при смене числа карт веер возвращается в середину
  let fanDirty = false;   // пришло обновление руки во время драга — дорисовать после

  // Геометрия дуги для смещения t (0 = центр): угол, провал вниз, размер,
  // прозрачность. Вынесено, чтобы FLIP-анимация прокрутки использовала то же.
  function fanPose(t) {
    const at = Math.abs(t);
    return {
      angle: t * FAN_STEP,
      yOff: Math.pow(at, 1.5) * 3.4,                  // края сильнее заворачиваются вниз
      scale: Math.max(0.6, 1 - 0.09 * at),            // и уменьшаются
      opacity: Math.max(0.22, 1 - 0.17 * Math.pow(at, 1.1)), // и гаснут
    };
  }
  function fanTransform(t) {
    const p = fanPose(t);
    return `rotate(${p.angle.toFixed(2)}deg) translateY(${p.yOff.toFixed(1)}px) scale(${p.scale.toFixed(3)})`;
  }
  // Прокрутка веера: центр сдвигается на delta карт ПО КОЛЬЦУ — вращение
  // бесконечное в обе стороны. Вращать можно, когда карт больше трёх:
  // с 1–3 картами крутить просто нечего.
  function fanScrollBy(delta) {
    const m = me();
    if (!m || !m.hand) return;
    const n = m.hand.length;
    if (n <= 3) return;
    fanCenter = ((fanCenter + delta) % n + n) % n;
    renderHand();
  }
  // Кольцевое смещение карты i от центра: ближайшее расстояние по кругу
  // (в диапазоне -n/2..n/2) — именно оно задаёт позу карты на дуге.
  function fanT(i, n) {
    let t = i - fanCenter;
    t = ((t % n) + n) % n;       // 0..n-1
    if (t > n / 2) t -= n;       // -n/2..n/2
    return t;
  }

  // Полупрозрачный «принт» на карте по типу программы
  const KIND_GLYPHS = { move: '⇄', damage: '✖', defense: '⛨', utility: '⚙', mass: '☢', support: '✚' };

  // Привязка HTML5-драга к карточке (рука и отдельная карта «КодШифр»).
  // Карта «достаётся из руки»: исходная в веере прячется (opacity:0), за
  // курсором следует призрак с pointer-events:none. Подробности — у CSS.
  function bindCardDrag(div, card) {
    // Мобильный тап-режим: клик по карте «взводит» её (см. onCardTap).
    // На десктопе клик игнорируется внутри onCardTap.
    div.addEventListener('click', () => onCardTap(div, card));
    div.addEventListener('dragstart', (ev) => {
      hideCardPreview();
      draggedCard = card; div.classList.add('dragging');
      // На время драга выключаем поднятие карт при наведении (см. CSS):
      // поднятая карта перекрывает слоты и перехватывает dragover/drop.
      const fan = $('hand-fan'); if (fan) fan.classList.add('dragging-active');
      // Подсказка-«линейка»: у чётных программ центр окна — ШОВ между
      // слотами (включаем засечки), у нечётных — средний слот.
      const stripEl = $('slots-strip');
      if (stripEl && card.consumption) {
        stripEl.classList.toggle('drag-even', card.consumption.length % 2 === 0);
        stripEl.classList.toggle('drag-odd', card.consumption.length % 2 === 1);
      }
      if (ev.dataTransfer) {
        ev.dataTransfer.setData('text/plain', card.uid); // без этого Firefox не стартует драг
        try { ev.dataTransfer.effectAllowed = 'move'; } catch (e) {}
        try { ev.dataTransfer.setDragImage(getBlankDragImage(), 0, 0); } catch (e) {}
      }
      showDragGhost(div, ev.clientX, ev.clientY);
      // ВАЖНО: нельзя давать карте pointer-events:none во время драга —
      // Chromium мгновенно отменяет нативный drag, если источник
      // перестаёт попадать под hit-testing.
    });
    div.addEventListener('dragend', () => {
      div.classList.remove('dragging'); clearSlotHighlight(); hideDragGhost(); // карта «возвращается в руку»
      const fan = $('hand-fan'); if (fan) fan.classList.remove('dragging-active');
      draggedCard = null;
      // Если во время драга пришло обновление (или крутили веер) — дорисовать.
      if (fanDirty) { fanDirty = false; renderHand(); }
    });
  }

  // Текущий дизайн руки из локальных настроек (PREFS объявлен в main.js).
  function handMode() { return (typeof PREFS !== 'undefined' && PREFS.hand) || 'fan'; }

  // Диспетчер: три дизайна руки на выбор в настройках вида (🎨 ВИД).
  function renderHand() {
    const mode = handMode();
    if (mode === 'classic') return renderHandClassic();
    if (mode === 'list') return renderHandList();
    return renderHandFan();
  }

  // Колёсико мыши над рукой — вешается один раз; что оно крутит, зависит
  // от выбранного дизайна: веер вращается, классика листается, список едет.
  function bindHandWheel(fan, box) {
    if (fan.dataset.wheelBound) return;
    fan.dataset.wheelBound = '1';
    fan.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const mode = handMode();
      if (mode === 'list') { box.scrollLeft += ev.deltaY * 1.5; return; }
      if (mode === 'classic') { classicScrollBy(ev.deltaY > 0 ? 1 : -1); return; }
      fanScrollBy(ev.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    // Свайп пальцем по полосе руки (телефон): веер крутится, классика листается.
    // В режиме «список» ничего не делаем — там родной горизонтальный скролл.
    let touchX = null;
    fan.addEventListener('touchstart', (ev) => {
      if (handMode() === 'list') return;
      touchX = ev.touches[0].clientX;
    }, { passive: true });
    fan.addEventListener('touchmove', (ev) => {
      if (touchX === null) return;
      const x = ev.touches[0].clientX;
      const dx = x - touchX;
      if (Math.abs(dx) >= 34) {          // шаг свайпа — одна карта
        const dir = dx > 0 ? -1 : 1;     // свайп влево -> следующие карты
        if (handMode() === 'classic') classicScrollBy(dir); else fanScrollBy(dir);
        touchX = x;
      }
      ev.preventDefault();               // страницу при свайпе по руке не скроллим
    }, { passive: false });
    fan.addEventListener('touchend', () => { touchX = null; });
    fan.addEventListener('touchcancel', () => { touchX = null; });
  }

  // ── Превью карты в отдельном окне ─────────────────────────────────────
  // Карта в руке при наведении больше НЕ поднимается (подъём накрывал слоты
  // и мешал кликать) — вместо этого полноразмерная копия всплывает в правом
  // нижнем углу (#card-preview, pointer-events:none — кликам не мешает).
  function showCardPreview(cardEl) {
    // Превью-окно оставлено только для «списка» — там карты мелкие и без подъёма.
    if (handMode() !== 'list' || isTapMode() || draggedCard) return; // на таче нет hover; в драге не показываем
    const pv = $('card-preview');
    if (!pv) return;
    pv.innerHTML = '';
    const clone = cardEl.cloneNode(true);
    clone.classList.remove('dragging', 'tap-armed', 'no-anim');
    clone.draggable = false;
    pv.appendChild(clone);
    pv.classList.remove('hidden');
  }
  function hideCardPreview() {
    const pv = $('card-preview');
    if (!pv) return;
    pv.classList.add('hidden');
    pv.innerHTML = '';
  }

  // ── Полноэкранный просмотр карты (телефон, долгий тап) ────────────────
  // На таче нет hover-подсказки — описание программы читается здесь.
  function showCardModal(cardEl) {
    const md = $('card-modal'); if (!md) return;
    const box = $('card-modal-box');
    box.innerHTML = '';
    const clone = cardEl.cloneNode(true);
    clone.classList.remove('dragging', 'tap-armed', 'no-anim');
    clone.draggable = false;
    box.appendChild(clone);
    // Матричный интерфейс на телефоне: ставка — кнопкой прямо из описания карты.
    const card = cardEl._card;
    const m = typeof me === 'function' ? me() : null;
    if (card && m && m.interfaceId === 'matrix' && isMyTurn() && NET.state && !NET.state.over
        && !card.broken && !card.stolen && (card.consumption || '').length >= 2
        && !m.statuses.matrixBetDone) {
      const btn = document.createElement('button');
      btn.className = 'btn matrix-bet-btn';
      btn.textContent = '🎰 СТАВКА';
      btn.title = 'Матричный интерфейс: слоты перегенерируются; выпадет комбинация этой карты — удача, нет — провал.';
      btn.addEventListener('click', () => { hideCardModal(); socket.emit('game:bet', { uid: card.uid }); });
      box.appendChild(btn);
    }
    md.classList.remove('hidden');
    FX.sfx.click();
  }
  function hideCardModal() { const md = $('card-modal'); if (md) md.classList.add('hidden'); }

  // Общий конструктор карточки руки для всех трёх дизайнов.
  function buildHandCard(card, m) {
    const prog = progById(card.progId);
    // Анти-накопление: получив бонус от чужого «Стороннего айпи»,
    // своя одноимённая карта заблокирована до конца хода (серым).
    const tpiBlocked = card.progId === 'third-party-ip' && m.statuses.tpiBlocked;
    // Блок перехватом сканера или провалом ставки Матрицы — до конца след. раунда.
    const scanBlocked = !!(card.blockedUntilRound && NET.state.round <= card.blockedUntilRound);
    const div = document.createElement('div');
    div._card = card; // ссылка для модалки (кнопка СТАВКА у Матрицы)
    div.className = `hand-card fan-card kind-${prog.kind}` + (card.broken ? ' broken' : '')
      + (tpiBlocked || scanBlocked ? ' blocked' : '') + (card.stolen ? ' stolen' : '');
    div.draggable = isMyTurn() && !NET.state.over && !tpiBlocked && !scanBlocked;
    const glyph = KIND_GLYPHS[prog.kind] || '▣';
    div.innerHTML = `<div class="p-print">${glyph}</div>
      <div class="p-name">${esc(prog.name)}</div>
      <div class="p-cons">${esc(card.consumption)}</div>
      <div class="p-desc">${esc(prog.short || prog.desc)}</div>
      ${card.broken ? '<div class="p-broken-tag">⚠ СЛОМАНА: -2 ХП</div>' : ''}
      ${prog.burns ? '<div class="p-broken-tag">⚠ сгорает</div>' : ''}
      ${tpiBlocked ? '<div class="p-broken-tag">⛔ заблокирована бонусом</div>' : ''}
      ${scanBlocked ? '<div class="p-broken-tag">⛔ заблокирована до конца след. раунда</div>' : ''}
      ${card.stolen ? '<div class="p-broken-tag p-stolen-tag">⛨ ПЕРЕХВАТ — сгорит в конце хода</div>' : ''}`;
    // На карте — короткое описание; полное — во всплывающей подсказке.
    div.title = tpiBlocked
      ? 'Заблокирована: вы получили бонус мощности от чужого Стороннего айпи. Разблокируется после вашего хода.'
      : scanBlocked
        ? 'Заблокирована перехватом сканера или провалом ставки Матрицы — до конца следующего раунда.'
        : prog.desc;
    bindCardDrag(div, card);
    // Наведение — полноразмерное превью в отдельном окне (не подъём карты).
    // Долгий тап (0.45с без движения) — полноэкранный просмотр программы.
    // Короткий тап остаётся взведением карты; click после долгого глушится.
    let lpTimer = null, lpX = 0, lpY = 0;
    div.addEventListener('touchstart', (ev) => {
      if (!isTapMode()) return;
      lpX = ev.touches[0].clientX; lpY = ev.touches[0].clientY;
      lpTimer = setTimeout(() => {
        lpTimer = null;
        lpSuppressUntil = Date.now() + 600; // глушим click после отпускания
        showCardModal(div);
      }, 450);
    }, { passive: true });
    div.addEventListener('touchmove', (ev) => {
      if (!lpTimer) return;
      const dx = ev.touches[0].clientX - lpX, dy = ev.touches[0].clientY - lpY;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) { clearTimeout(lpTimer); lpTimer = null; }
    }, { passive: true });
    div.addEventListener('touchend', () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
    div.addEventListener('touchcancel', () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
    div.addEventListener('mouseenter', () => showCardPreview(div));
    div.addEventListener('mouseleave', hideCardPreview);
    // В тап-режиме возвращаем подсветку «взведённой» карте после перерисовки.
    if (tapCard && tapCard.uid === card.uid) div.classList.add('tap-armed');
    return div;
  }

  // Общий пролог отрисовки руки: скрыть без руки, колёсико, страж драга,
  // сброс протухшей «взведённой» карты. null — дальше рисовать нечего.
  function handProlog() {
    const fan = $('hand-fan');
    const box = $('fan-cards');
    const m = me();
    if (!m || !m.hand) { fan.classList.add('hidden'); return null; }
    fan.classList.remove('hidden');
    bindHandWheel(fan, box);
    hideCardPreview(); // превью указывает на старый DOM — пересоздадим при наведении
    // Во время драга руку НЕ перестраиваем: удаление источника из DOM
    // отменяет нативный drag. Отложим до dragend.
    if (draggedCard) { fanDirty = true; return null; }
    // Тап-режим: сбрасываем «взведённую» карту, если ход кончился
    // или карта ушла из руки (сыграна/сгорела).
    if (tapCard && (!isMyTurn() || NET.state.over || !m.hand.some(c => c.uid === tapCard.uid))) disarmTap();
    return { fan, box, m };
  }

  // ── Дизайн 1: ВЕЕР (по умолчанию) — зацикленная вращающаяся дуга ──────
  function renderHandFan() {
    const ctx = handProlog();
    if (!ctx) return;
    const { box, m } = ctx;
    if (!m.hand.length) {
      box.innerHTML = '<span class="dim">— рука пуста —</span>';
      return;
    }
    const n = m.hand.length;
    // Рука изменилась по составу — возвращаем веер в середину.
    if (n !== fanPrevLen) { fanCenter = (n - 1) / 2; fanPrevLen = n; }
    fanCenter = ((fanCenter % n) + n) % n; // кольцо: центр всегда в 0..n-1

    // FLIP-плавность: запоминаем прошлые позиции карт (по uid), чтобы при
    // прокрутке карты «провернулись» по дуге, а не мигнули на новые места.
    const lastT = new Map();
    box.querySelectorAll('.fan-slot').forEach(s => lastT.set(s.dataset.uid, parseFloat(s.dataset.t)));

    box.innerHTML = '';

    // Видимое окно: кольцевое |t| <= FAN_HALF. Остальные картинки «за поворотом»
    // дуги — докрутите колёсиком или стрелками, веер бесконечный.
    const visible = [];
    m.hand.forEach((card, i) => {
      const t = fanT(i, n);
      if (Math.abs(t) <= FAN_HALF + 0.01) visible.push({ card, i, t });
    });
    // ВАЖНО: слоты раскладываются по смещению t, а не по индексу в руке.
    // Иначе на склейке кольца (центр около первой/последней карты) порядок
    // ломался: карта с позой центра вставала на край, и дуга «складывалась».
    // С сортировкой веер выглядит ОДИНАКОВО в любой точке вращения.
    visible.sort((a, b) => a.t - b.t);

    for (const { card, t } of visible) {
      // Неподвижная хит-зона: наведение висит на .fan-slot, а карта внутри
      // поднимается — её движение не может сбросить наведение (фикс мерцания).
      const slot = document.createElement('div');
      slot.className = 'fan-slot';
      slot.dataset.uid = card.uid;
      slot.dataset.t = t;
      slot.style.zIndex = String(50 - Math.ceil(Math.abs(t))); // центр выше краёв
      const div = buildHandCard(card, m);
      const pose = fanPose(t);
      div.style.setProperty('--fan-t', fanTransform(t));
      div.style.opacity = pose.opacity.toFixed(2);
      slot.appendChild(div);
      box.appendChild(slot);

      // Плавный «проворот»: карта, бывшая на дуге, стартует со СТАРОЙ позы
      // и за один кадр переходит к новой (CSS-transition на transform/opacity).
      const pt = lastT.get(card.uid);
      if (pt !== undefined && pt !== t) {
        div.classList.add('no-anim');
        div.style.setProperty('--fan-t', fanTransform(pt));
        div.style.opacity = fanPose(pt).opacity.toFixed(2);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          div.classList.remove('no-anim');
          div.style.setProperty('--fan-t', fanTransform(t));
          div.style.opacity = pose.opacity.toFixed(2);
        }));
      }
    }
  }

  // ── Дизайн 2: КЛАССИКА — старый плоский ряд из 9 карт со стрелками ◂ ▸ ──
  const CLASSIC_MAX = 9;   // сколько карт видно одновременно
  let classicOffset = 0;   // индекс первой видимой карты
  function classicScrollBy(delta) {
    const m = me();
    if (!m || !m.hand) return;
    const n = m.hand.length;
    if (n <= CLASSIC_MAX) return; // всё и так видно — листать нечего
    classicOffset = Math.max(0, Math.min(n - CLASSIC_MAX, classicOffset + delta));
    renderHand();
  }
  function renderHandClassic() {
    const ctx = handProlog();
    if (!ctx) return;
    const { fan, box, m } = ctx;
    const n = m.hand.length;
    if (!n) {
      box.innerHTML = '<span class="dim">— рука пуста —</span>';
      syncClassicArrows(fan, 0);
      return;
    }
    classicOffset = Math.max(0, Math.min(Math.max(0, n - CLASSIC_MAX), classicOffset));
    const vis = m.hand.slice(classicOffset, classicOffset + CLASSIC_MAX);
    const mid = (vis.length - 1) / 2; // центр окна — ровно посередине
    box.innerHTML = '';
    vis.forEach((card, k) => {
      const t = k - mid;
      const slot = document.createElement('div');
      slot.className = 'fan-slot cls-slot';
      slot.dataset.uid = card.uid;
      slot.style.zIndex = String(50 - Math.ceil(Math.abs(t)));
      const div = buildHandCard(card, m);
      // Старая геометрия: лёгкий наклон веером, без затухания и уменьшения.
      div.style.setProperty('--fan-t',
        `rotate(${(t * 3.2).toFixed(2)}deg) translateY(${(Math.pow(Math.abs(t), 1.5) * 1.6).toFixed(1)}px)`);
      slot.appendChild(div);
      box.appendChild(slot);
    });
    syncClassicArrows(fan, n);
  }
  // Стрелки ◂ ▸ со счётчиками скрытых карт. Создаются один раз и живут в
  // #hand-fan; видны только в режиме «классика» (управляет CSS).
  function syncClassicArrows(fan, n) {
    let l = fan.querySelector('.fan-scroll.left');
    if (!l) {
      l = document.createElement('div');
      l.className = 'fan-scroll left';
      l.innerHTML = '◂<span class="cnt"></span>';
      l.title = 'прокрутить руку влево';
      l.addEventListener('click', () => classicScrollBy(-1));
      const r = document.createElement('div');
      r.className = 'fan-scroll right';
      r.innerHTML = '<span class="cnt"></span>▸';
      r.title = 'прокрутить руку вправо';
      r.addEventListener('click', () => classicScrollBy(1));
      fan.appendChild(l);
      fan.appendChild(r);
    }
    const r = fan.querySelector('.fan-scroll.right');
    const show = n > CLASSIC_MAX;
    l.classList.toggle('hidden', !show);
    r.classList.toggle('hidden', !show);
    // Счётчики: сколько карт скрыто слева/справа (пусто, если ноль).
    l.querySelector('.cnt').textContent = classicOffset || '';
    r.querySelector('.cnt').textContent = (n - CLASSIC_MAX - classicOffset) || '';
  }

  // ── Дизайн 3: СПИСОК — все карты в ряд с горизонтальной прокруткой ────
  function renderHandList() {
    const ctx = handProlog();
    if (!ctx) return;
    const { box, m } = ctx;
    if (!m.hand.length) {
      box.innerHTML = '<span class="dim">— рука пуста —</span>';
      return;
    }
    const keepScroll = box.scrollLeft; // перерисовка не должна дёргать прокрутку
    box.innerHTML = '';
    m.hand.forEach((card) => {
      const slot = document.createElement('div');
      slot.className = 'fan-slot list-slot';
      slot.dataset.uid = card.uid;
      slot.appendChild(buildHandCard(card, m));
      box.appendChild(slot);
    });
    box.scrollLeft = keepScroll;
  }

  // ── Тап-режим (мобильные): вместо drag&drop — тап по карте, тапы по слотам ──
  let tapCard = null;   // «взведённая» тапом карта
  let tapPicked = [];   // индексы выбранных тапами слотов (в порядке тапов)
  function isTapMode() { return document.body.classList.contains('mobile'); }
  function disarmTap(silent) {
    tapCard = null; tapPicked = [];
    document.querySelectorAll('.tap-armed').forEach(el => el.classList.remove('tap-armed'));
    document.querySelectorAll('#slots-strip .slot.picked').forEach(el => el.classList.remove('picked'));
    if (!silent && !pending) $('target-hint').textContent = '';
  }
  // Тап по карте руки: взвести / снять. Дальше — тапы по слотам.
  let lpSuppressUntil = 0; // до этого момента тапы по картам игнорируются (был долгий тап)
  function onCardTap(div, card) {
    if (Date.now() < lpSuppressUntil) return; // этот click — отпускание долгого тапа
    if (!isTapMode() || !NET.state) return;
    if (!isMyTurn() || NET.state.over) return;
    if (tapCard && tapCard.uid === card.uid) { disarmTap(); return; }
    disarmTap(true);
    tapCard = card; tapPicked = [];
    div.classList.add('tap-armed');
    const prog = progById(card.progId) || { name: 'КодШифр' };
    $('target-hint').textContent =
      `«${prog.name}»: тапните ${card.consumption.length} слот(а) — комбинация ${card.consumption}. Повторный тап по карте — отмена.`;
  }
  // Тап по открытому слоту при взведённой карте. Возвращает true, если тап
  // обработан как выбор слота (тогда прочие клики слота глушатся).
  function onSlotTap(idx) {
    if (!isTapMode() || !tapCard) return false;
    const s = (NET.state.slots || [])[idx];
    if (!s || s.closed) return false;
    const el = document.querySelector(`#slots-strip .slot[data-idx="${idx}"]`);
    const at = tapPicked.indexOf(idx);
    if (at >= 0) { // повторный тап — снять выбор
      tapPicked.splice(at, 1);
      if (el) el.classList.remove('picked');
      return true;
    }
    tapPicked.push(idx);
    if (el) el.classList.add('picked');
    if (tapPicked.length === tapCard.consumption.length) {
      const card = tapCard;
      // Порядок слева направо — как при перетаскивании мышью.
      const indices = [...tapPicked].sort((a, b) => a - b);
      disarmTap(true);
      if (validateCardSlots(card, indices)) commitCardPlay(card, indices);
    }
    return true;
  }

  // ---------- карта «КодШифр» (режим захвата): отдельно от руки, правее неё ----------
  function renderCipher() {
    const box = $('cipher-card');
    box.innerHTML = '';
    const c = NET.state && NET.state.cipher;
    if (!c || !me()) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const div = document.createElement('div');
    div.className = 'hand-card cipher';
    div.draggable = isMyTurn() && !NET.state.over;
    div.innerHTML = `<div class="p-print">◈</div>
      <div class="p-name">КодШифр</div>
      <div class="p-cons">${esc(c.consumption)}</div>
      <div class="p-desc">+1 очко захвата. Потребление меняется каждый раунд и растёт с вашими очками (если включено в настройках).</div>`;
    div.title = 'Сыграйте на слоты, стоя на точке контроля: +1 очко захвата.';
    bindCardDrag(div, { uid: '__cipher__', progId: 'code-cipher', consumption: c.consumption });
    box.appendChild(div);
  }

  // ---------- окно «Разлом данных» ----------
  // Открывается, когда мы вступаем на разлом (fx 'rift' от сервера).
  // В окне — целые программы руки: клик по биту потребления ломает программу
  // (убирает этот бит, программа начинает бить владельца на 2 ХП при игре).
  // После использования ЭТОТ разлом для нас исчерпан — окно больше не всплывёт.
  function closeRiftModal() { $('rift-modal').classList.remove('show'); }

  function openRiftModal() {
    const m = me();
    const box = $('rift-list');
    box.innerHTML = '';
    const whole = m && m.hand ? m.hand.filter(c => !c.broken && c.consumption.length > 1) : [];
    if (!whole.length) {
      box.innerHTML = '<p class="dim">— нет целых программ, которые можно сломать —</p>';
    }
    for (const card of whole) {
      const prog = (NET.meta && NET.meta.programs || []).find(p => p.id === card.progId) || { name: card.progId };
      const row = document.createElement('div');
      row.className = 'rift-row';
      const bits = card.consumption.split('').map((b, bi) =>
        `<button class="btn small bit-btn" data-uid="${esc(card.uid)}" data-b="${bi}" title="убрать этот бит потребления">${b}</button>`).join('');
      row.innerHTML = `<span class="rift-name">${esc(prog.name)}</span><span class="rift-bits">${bits}</span>`;
      box.appendChild(row);
    }
    box.querySelectorAll('.bit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        FX.sfx.click();
        socket.emit('game:riftUse', { uid: btn.dataset.uid, removeIndex: +btn.dataset.b });
        // Окно закроется по fx 'riftUsed' от сервера; при ошибке останется.
      });
    });
    $('rift-modal').classList.add('show');
  }

  // ---------- карта ----------
  function targetingCells() {
    // Множества клеток для подсветки в режиме выбора цели.
    const res = { targets: new Set(), range: new Set() };
    if (!pending || pending.needAmount) return res;
    const m = me();
    if (!m) return res;
    // peer-to-peer: дальность и видимость считаем от пешки ПОДКЛЮЧЁННОГО
    // игрока (anchor()); без связи anchor — это я сам.
    const anc = anchor() || m;
    if (!anc.pos) return res;
    const prog = pending.prog;
    // Режим Насилия не действует при p2p (карта играется «как есть»).
    const violence = m.statuses.violence && !m.statuses.p2pTarget;
    const objects = NET.state.map.objects;

    if (prog.target === 'enemy') {
      for (let y = 0; y < NET.state.map.h; y++) for (let x = 0; x < NET.state.map.w; x++) {
        // Радиус рисуем честно: клетки за битыми пикселями (нет линии
        // видимости) НЕ подсвечиваем — иначе игрок думает, что достанет
        // туда, а сервер отклоняет ход. Исключение — программы, которым
        // видимость не нужна (noLos: бьют сквозь стены).
        if (cheb(anc.pos, { x, y }) <= prog.range && (prog.noLos || los(anc.pos, { x, y }))) res.range.add(key(x, y));
      }
      // Сторонний айпи: дальность любая, но целью может быть только один из
      // БЛИЖАЙШИХ игроков — остальные клетки не подсвечиваются и не кликаются.
      let onlyNearest = null;
      if (prog.id === 'third-party-ip') {
        const others = NET.state.players.filter(p => p.alive && p.id !== anc.id && p.pos);
        if (others.length) {
          const minD = Math.min(...others.map(p => cheb(anc.pos, p.pos)));
          onlyNearest = new Set(others.filter(p => cheb(anc.pos, p.pos) === minD).map(p => p.id));
        }
      }
      for (const p of NET.state.players) {
        if (!p.alive || p.id === anc.id || !p.pos) continue;
        if (onlyNearest && !onlyNearest.has(p.id)) continue;
        if (cheb(anc.pos, p.pos) <= prog.range && (prog.noLos || los(anc.pos, p.pos))) res.targets.add(key(p.pos.x, p.pos.y));
      }
      // Цифровые копии — законная цель атакующих программ (с уроном > 0).
      // Копии живут отдельно от объектов (state.copies) — поверх зон/порталов.
      if (prog.kind === 'damage' && (prog.damage || 0) > 0) {
        for (const k of Object.keys(NET.state.copies || {})) {
          const [cx, cy] = k.split(',').map(Number);
          if (cheb(anc.pos, { x: cx, y: cy }) <= prog.range && los(anc.pos, { x: cx, y: cy })) res.targets.add(k);
        }
      }
      // Режим Насилия: программу урона можно использовать как движение.
      if (violence && prog.kind === 'damage') {
        for (const k of bfs(anc.pos, prog.damage || prog.range)) res.targets.add(k);
      }
    } else if (prog.target === 'cell') {
      let cells;
      if (prog.id === 'change-provider') {
        cells = new Set();
        for (let y = 0; y < NET.state.map.h; y++) for (let x = 0; x < NET.state.map.w; x++) {
          if (isFree(x, y)) cells.add(key(x, y));
        }
      } else if (prog.id === 'broken-system') {
        cells = new Set();
        const offsets = BROKEN_PATTERN_OFFSETS[pending.pattern || 'h'] || BROKEN_PATTERN_OFFSETS.h;
        for (let y = 0; y < NET.state.map.h; y++) for (let x = 0; x < NET.state.map.w; x++) {
          if (offsets.every(([dx, dy]) => isFree(x + dx, y + dy))) cells.add(key(x, y));
        }
      } else if (prog.id === 'bug-pass') {
        cells = new Set();
        for (let y = 0; y < NET.state.map.h; y++) for (let x = 0; x < NET.state.map.w; x++) {
          if (!isFree(x, y)) continue;
          const near = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].some(([dx, dy]) => {
            const o = objectAt(x + dx, y + dy);
            return o && !o.walkable;
          });
          if (near) cells.add(key(x, y));
        }
      } else if (prog.id === 'signal-split' || prog.id === 'data-error' || prog.id === 'mine-plant') {
        // Свободная точка привязки в пределах дальности (по Манхэттену).
        cells = new Set();
        for (let y = 0; y < NET.state.map.h; y++) for (let x = 0; x < NET.state.map.w; x++) {
          if (cheb(anc.pos, { x, y }) > prog.range) continue;
          if (prog.id === 'signal-split' && !isFree(x, y)) continue;
          if (prog.id === 'mine-plant' && (!isFree(x, y) || objectAt(x, y))) continue; // мина — только на пустую клетку
          cells.add(key(x, y));
        }
      } else {
        cells = bfs(anc.pos, prog.range);
      }
      for (const k of cells) res.targets.add(k);
      // Картой передвижения можно кликнуть по СВОЕЙ копии — обмен местами.
      if (prog.kind === 'move') {
        for (const [k, cp] of Object.entries(NET.state.copies || {})) {
          if (cp.ownerId === anc.id) res.targets.add(k);
        }
      }
      // Режим Насилия: программу движения можно использовать как урон.
      if (violence && prog.kind === 'move') {
        for (const p of NET.state.players) {
          if (!p.alive || p.id === anc.id || !p.pos) continue;
          if (cheb(anc.pos, p.pos) <= prog.range && los(anc.pos, p.pos)) res.targets.add(key(p.pos.x, p.pos.y));
        }
      }
    }
    return res;
  }

  // ══ РАЗМЕР КАРТЫ В БОЮ ═════════════════════════════════════════════
  // Окно карты ФИКСИРОВАННОЕ (style.css: переменная --map-w в body +
  // #game-map-panel). Здесь клетки подгоняются под окно: чем больше
  // клеток в карте, тем мельче каждая — карта никогда не вылезает за
  // рамку и не даёт скролла. MIN_CELL_PX — нижний предел клетки.
  const MIN_CELL_PX = 4;
  function fitCells(grid, w, h) {
    const cw = grid.clientWidth - 12, ch = grid.clientHeight - 12;
    if (cw <= 0 || ch <= 0) return;
    // Локальный масштаб клеток из настроек вида (🎨 ВИД → РАЗМЕР КАРТЫ):
    // 100% — карта влезает в окно целиком; больше — клетки крупнее,
    // карта прокручивается внутри окна (у каждого игрока своё значение).
    const scale = (typeof PREFS !== 'undefined' && PREFS.mapscale ? PREFS.mapscale : 100) / 100;
    // На телефоне клетка не мельче 12px — иначе пиксели игроков не видны.
    const minCell = document.body.classList.contains('mobile') ? 12 : MIN_CELL_PX;
    const size = Math.max(minCell, Math.floor(Math.min(cw / w, ch / h) * scale));
    grid.style.setProperty('--cell', size + 'px');
  }

  function renderMap() {
    const grid = $('game-map');
    const { w, h } = NET.state.map;
    const mapKey = `${w}x${h}`;
    if (mapDrawnFor !== mapKey) {
      grid.style.gridTemplateColumns = `repeat(${w}, var(--cell, 18px))`;
      grid.innerHTML = '';
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.x = x; cell.dataset.y = y;
        cell.addEventListener('click', onMapClick);
        // Превью области эффекта под курсором. Обработчик вешается ОДИН РАЗ
        // при создании клетки и читает АКТУАЛЬНЫЙ pending — иначе старые
        // обработчики накапливались и квадрат-призрак оставался под мышкой
        // даже после установки объекта.
        cell.addEventListener('mouseenter', () => onCellHover(x, y));
        grid.appendChild(cell);
      }
      mapDrawnFor = mapKey;
    }
    fitCells(grid, w, h);
    const tc = targetingCells();
    const objects = NET.state.map.objects;
    for (const cell of grid.children) {
      const x = +cell.dataset.x, y = +cell.dataset.y, k = key(x, y);
      const obj = objects[k];
      cell.className = 'cell';
      cell.style.background = '';
      cell.style.removeProperty('--obj-color');
      cell.innerHTML = '';
      cell.title = '';
      cell.removeAttribute('data-glyph');
      cell.removeAttribute('data-pair');
      cell.removeAttribute('data-team');
      if (obj) {
        cell.style.setProperty('--obj-color', obj.color);
        cell.title = obj.name + (obj.roundsLeft > 0 ? ` (ещё ${obj.roundsLeft} раунд.)` : '');
        if (obj.type === 'mine') {
          cell.classList.add('obj-mine');
        } else if (obj.type === 'portal') {
          cell.classList.add('obj-portal');
        } else if (obj.type === 'portal2') {
          cell.classList.add('obj-portal2'); // парный телепорт — другой цвет
          cell.dataset.pair = obj.pair || 1; // номер пары рисуется в углу клетки
          cell.title += ` (пара №${obj.pair || 1})`;
        } else if (obj.type === 'rift') {
          cell.classList.add('obj-rift');   // разлом данных: сломать программу
        } else if (obj.type === 'spawn') {
          cell.classList.add('obj-spawn');  // пиксель спауна: стартовая клетка
        } else if (obj.type === 'point') {
          cell.classList.add('obj-point');   // точка контроля (режим захвата)
          if (obj.team != null) {            // командная точка: буква в углу
            cell.dataset.team = 'АБВГ'[obj.team];
            cell.title += ` (команда ${'АБВГ'[obj.team]})`;
          }
        } else if (obj.walkable) {
          cell.classList.add('zone');
          cell.style.background = obj.color + '55';
        } else {
          // Битый пиксель: глитч-стена со случайным символом помех.
          cell.classList.add('wall');
          cell.dataset.glyph = '▓▒░╳#%&@?!'[Math.floor(Math.random() * 10)];
          cell.style.animationDelay = (Math.random() * 0.8).toFixed(2) + 's';
        }
      }
      if (pending) {
        if (tc.range.has(k)) cell.classList.add('attack-range');
        if (tc.targets.has(k)) cell.classList.add('targetable');
      }
      const pawn = pawnAt(x, y);
      if (pawn) {
        const d = document.createElement('div');
        d.className = 'pawn';
        // Визуальные «кольца» активных защит видит только владелец пешки:
        // для остальных брандмауэр и AI-защита — скрытая информация.
        if (pawn.id === NET.myId) {
          if (pawn.statuses.firewall) d.classList.add('sh-fw');
          if (pawn.statuses.aiDefense) d.classList.add('sh-ai');
          if (pawn.statuses.torrent) d.classList.add('sh-tr');
        }
        d.style.background = pawn.color;
        d.style.color = pawn.color;
        cell.appendChild(d);
        cell.title = pawn.name;
      }
      // Цифровая копия — оверлей ПОВЕРХ объекта (зона/портал под ней живы).
      // «Разделение сигнала» — маскировка: для ВЛАДЕЛЬЦА копия помечена
      // (класс copy + имя «Копия: ...» и её ХП в подсказке), для остальных
      // она выглядит ТОЧНО как настоящая пешка этого игрока — по виду
      // не отличить, кто настоящий, а кто клон.
      const cp = copyAt(x, y);
      if (cp) {
        const mineCopy = cp.ownerId === NET.myId;
        if (mineCopy) cell.classList.add('obj-copy');
        const ghost = document.createElement('div');
        ghost.className = mineCopy ? 'pawn copy' : 'pawn';
        ghost.style.background = cp.color;
        ghost.style.color = cp.color;
        cell.appendChild(ghost);
        if (mineCopy) cell.title = `${cp.name} — ♥${cp.hp}`;
        else cell.title = ((NET.state.players.find(p => p.id === cp.ownerId) || {}).name) || cp.name;
      }
    }
  }

  function onMapClick(e) {
    // Цель выбирает ходящий игрок. При peer-to-peer — тоже он сам, просто
    // дальность/видимость считаются от подключённого (anchor()).
    if (!pending || pending.needAmount) return;
    if (!isMyTurn()) return;
    const x = +e.currentTarget.dataset.x, y = +e.currentTarget.dataset.y;
    const m = me();
    const anc = anchor() || m; // «исполнитель»: при p2p — подключённый
    const prog = pending.prog;
    const pawn = pawnAt(x, y);
    const obj = objectAt(x, y);
    let target = null;

    // --- клик по цифровой копии («Разделение сигнала») ---
    // Копия — оверлей: на клетке может быть и зона/портал под ней.
    const cpClicked = copyAt(x, y);
    if (cpClicked) {
      if (cpClicked.ownerId === anc.id && prog.kind === 'move' && prog.target === 'cell') {
        target = { swapCopy: true };      // своя копия + карта перемещения = обмен местами
      } else if (prog.kind === 'damage' && prog.target === 'enemy' && (prog.damage || 0) > 0) {
        target = { copyKey: key(x, y) };  // атака по копии (Пинг-понг не бьёт — урона 0)
      }
    } else if (prog.target === 'enemy') {
      if (pawn && pawn.id !== anc.id) {
        target = { playerId: pawn.id };
      } else if (!m.statuses.p2pTarget && m.statuses.violence && prog.kind === 'damage' && isFree(x, y)) {
        // Режим Насилия: программу урона можно использовать как движение.
        target = { x, y, violenceMode: 'asMove' };
      }
    } else if (prog.target === 'cell') {
      if (pawn && pawn.id !== anc.id && !m.statuses.p2pTarget && m.statuses.violence && prog.kind === 'move') {
        // Режим Насилия: программу движения можно использовать как урон.
        target = { playerId: pawn.id, violenceMode: 'asDamage' };
      } else if (!pawn) {
        target = { x, y, pattern: pending.pattern || 'h' };
      }
    }

    if (!target) {
      // Промах мимо цели — просто предупреждение, программа остаётся
      // активированной. Отменить активацию можно клавишей Esc.
      FX.errorBeep();
      return FX.toast('Недопустимая цель. Esc — отмена.');
    }

    // violenceMode живёт на верхнем уровне payload (так ждёт движок).
    const payload = { uid: pending.uid, indices: pending.indices, target };
    if (target.violenceMode) { payload.violenceMode = target.violenceMode; delete target.violenceMode; }
    pending = null;
    $('target-hint').textContent = '';
    updatePatternPicker();
    socket.emit('game:useProgram', payload);
    renderMap();
  }

  // ---------- Матричный интерфейс: окно ставки ----------
  // Видно только игроку с МТРХ в его ход и ДО использования слотов (ставка —
  // первое действие хода). Сервер всё перепроверяет — тут лишь визибилити.
  function renderMatrixZone() {
    const z = $('matrix-zone');
    if (!z) return;
    const m = me();
    const slots = (NET.state && NET.state.slots) || [];
    const show = !!(m && m.interfaceId === 'matrix' && isMyTurn() && !NET.state.over
      && !m.statuses.matrixBetDone && !m.statuses.homeFlipUsed
      && slots.length && !slots.some(s => s.closed));
    z.classList.toggle('hidden', !show);
  }

  // ---------- мобильная полоска «чей ход» (тап — список игроков) ----------
  function renderTurnStrip() {
    const el = $('turn-strip');
    if (!el) return;
    const mob = document.body.classList.contains('mobile');
    const on = mob && NET.phase === 'game' && !!NET.state;
    el.classList.toggle('hidden', !on);
    if (!on) return;
    const cur = currentTurnPlayer();
    el.textContent = NET.state.over
      ? '// СЕССИЯ ЗАВЕРШЕНА //'
      : (isMyTurn() ? '>> ВАШ ХОД <<' : `ХОД: ${cur ? cur.name : '...'}`) + '  ·  игроки ▸';
    el.classList.toggle('mine', !NET.state.over && isMyTurn());
  }

  // Полный список игроков модалкой (мобильная версия): кто ходит, ХП, мощность.
  function openPlayersModal() {
    const ul = $('players-modal-list');
    ul.innerHTML = '';
    (NET.state.order || []).forEach((pid, idx) => {
      const p = NET.state.players.find(pl => pl.id === pid);
      if (!p) return;
      const isCur = idx === NET.state.turnIndex && !NET.state.over;
      const li = document.createElement('li');
      if (isCur) li.classList.add('current-turn');
      if (!p.alive) li.classList.add('dead');
      li.innerHTML = `<div class="p-line1">
          <span class="dim">#${idx + 1}</span>
          <span class="p-color" style="background:${esc(p.color)}"></span>
          <span class="p-name">${esc(p.name)}</span>
          <span class="p-iface">${esc(ifaceShort(p.interfaceId))}</span>
        </div>
        <div class="p-line2"><span class="p-hp">♥${p.hp}</span><span class="p-pow">⚡${p.power}</span>${p.alive ? '' : '<span class="p-tag">☠</span>'}</div>`;
      ul.appendChild(li);
    });
    $('players-modal').classList.add('show');
  }

  // ---------- таймер ----------
  function startTimer({ endsAt, seconds, paused, remaining }) {
    clearInterval(timerInterval);
    const btn = $('timer-pause-btn');
    // Таймер отключён в настройках (0 сек): бесконечный ход, пауза не нужна.
    if (!seconds) {
      btn.classList.add('hidden');
      $('timer-value').textContent = '∞';
      $('timer-box').classList.remove('low');
      return;
    }
    btn.classList.remove('hidden');
    if (paused) {
      btn.textContent = '▶';
      btn.classList.add('danger');
      const left = Math.max(0, Math.ceil((remaining || 0) / 1000));
      $('timer-value').textContent = left + ' ⏸';
      $('timer-box').classList.remove('low');
      return;
    }
    btn.textContent = '⏸';
    btn.classList.remove('danger');
    timerEndsAt = endsAt;
    timerInterval = setInterval(() => {
      const left = Math.max(0, Math.ceil((timerEndsAt - Date.now()) / 1000));
      $('timer-value').textContent = left;
      $('timer-box').classList.toggle('low', left <= 10);
    }, 250);
  }

  // ---------- панель отладки ----------
  function renderDebug() {
    const m = me();
    const panel = $('debug-panel');
    const on = !!(m && m.debug);
    panel.classList.toggle('hidden', !on);
    if (!on) return;
    $('dbg-hp').textContent = m.hp;
    $('dbg-pw').textContent = m.power;
  }

  // ---------- главный рендер ----------
  function render() {
    if (!NET.state) return;

    // Управление pending ДО отрисовки карты: иначе подсветка целей появится
    // только на следующий рендер.

    if (isMyTurn()) {
      // ход наступил — перезагрузка завершена, мощность восстановлена
      FX.hideReboot();
      // Активная p2p-связь: напоминаем, от чьей пешки исполняются карты.
      const m = me();
      if (m && m.statuses.p2pTarget && !pending) {
        const linked = NET.state.players.find(p => p.id === m.statuses.p2pTarget);
        if (linked) $('target-hint').textContent = `P2P: до конца хода ваши карты исполняются с позиции ${linked.name}.`;
      }
    } else if (pending) {
      // Чужой ход: незавершённый выбор цели недействителен.
      pending = null; $('target-hint').textContent = '';
      updatePatternPicker();
      updateAmountPicker();
    }

    renderTopbar();
    renderPlayers();
    renderSlots();
    renderHand();
    renderCipher();
    renderMap();
    renderDebug();
    renderMatrixZone();
    renderTurnStrip();
  }

  function init() {
    $('endturn-btn').addEventListener('click', () => socket.emit('game:endTurn'));
    $('overheat-btn').addEventListener('click', () => socket.emit('game:overheat'));
    $('matrix-help-btn').addEventListener('click', () => window.openMatrixHelp());
    // Полноэкранный просмотр карты: закрытие кнопкой или тапом по фону.
    $('card-modal-close').addEventListener('click', hideCardModal);
    $('card-modal-backdrop').addEventListener('click', hideCardModal);
    // Разлом данных: сервер сообщает, что мы вступили на разлом, — открываем
    // окно; после успешной поломки (fx 'riftUsed') окно закрывается само.
    socket.on('fx', (events) => {
      for (const e of events) {
        if (e.type === 'rift' && e.playerId === NET.myId) openRiftModal();
        if (e.type === 'riftUsed' && e.playerId === NET.myId) closeRiftModal();
      }
    });
    $('rift-close').addEventListener('click', closeRiftModal);
    document.addEventListener('keydown', (e) => {
      // ← → крутят веер руки. Не мешаем: печатающему в поле ввода и игроку
      // в змейку (у неё открыто окно) — там стрелки нужнее.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const inField = e.target && e.target.closest && e.target.closest('input,textarea,select');
        const sw = $('snake-window');
        const snakeOpen = sw && !sw.classList.contains('hidden');
        const fanEl = $('hand-fan');
        if (!inField && !snakeOpen && fanEl && !fanEl.classList.contains('hidden')) {
          // Что крутят стрелки — зависит от дизайна руки (веер/классика/список).
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          const mode = handMode();
          if (mode === 'list') {
            const box = $('fan-cards');
            if (box) box.scrollLeft += dir * 120;
          } else if (mode === 'classic') classicScrollBy(dir);
          else fanScrollBy(dir);
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Escape' && pending) {
        // Отмена незавершённого выбора (цели или числа).
        pending = null;
        $('target-hint').textContent = '';
        updatePatternPicker();
        updateAmountPicker();
        renderMap();
      }
    });
    // Выбор узора «Сломанной системы»
    document.querySelectorAll('.pattern-btn').forEach(b => {
      b.addEventListener('click', () => {
        if (!pending) return;
        pending.pattern = b.dataset.pattern;
        updatePatternPicker();
        FX.sfx.click();
        renderMap();
      });
    });
    // Выбор силы обмена для «Андервольтинга»: потерять X мощности, вылечить X ХП.
    document.querySelectorAll('.amount-btn').forEach(b => {
      b.addEventListener('click', () => {
        if (!pending || !pending.needAmount) return;
        socket.emit('game:useProgram', {
          uid: pending.uid, indices: pending.indices, amount: +b.dataset.amount,
        });
        pending = null;
        $('target-hint').textContent = '';
        updateAmountPicker();
        FX.sfx.click();
      });
    });
    socket.on('turn:timer', (info) => startTimer(info));
    window.addEventListener('resize', () => { if (NET.phase === 'game' && NET.state) renderMap(); });
    // Смена дизайна руки в настройках вида (🎨 ВИД) — перерисовать руку в бою.
    document.addEventListener('prefs:hand', () => { if (NET.phase === 'game' && NET.state) renderHand(); });

    // Приём перетаскивания — ВСЯ полоска слотов (а не отдельные слоты):
    // окно выбирается по X курсора, так что чётную программу можно навести
    // МЕЖДУ слотами (её центр — шов), а нечётную — на средний слот.
    const strip = $('slots-strip');
    strip.addEventListener('dragover', (e) => {
      if (!draggedCard) return;
      e.preventDefault(); // без этого браузер не даст drop
      highlightSlots(e.clientX);
    });
    strip.addEventListener('drop', onSlotDrop);

    // Матричный интерфейс: приём ставки перетаскиванием карты в окно МАТРИЦЫ.
    const mz = $('matrix-zone');
    if (mz) {
      mz.addEventListener('dragover', (e) => { if (draggedCard) { e.preventDefault(); mz.classList.add('hot'); } });
      mz.addEventListener('dragleave', () => mz.classList.remove('hot'));
      mz.addEventListener('drop', (e) => {
        e.preventDefault();
        mz.classList.remove('hot');
        let card = draggedCard;
        if (!card && e.dataTransfer) { // страховка, как в onSlotDrop
          const uid = e.dataTransfer.getData('text/plain');
          const m = me();
          if (uid && uid !== '__cipher__' && m) card = (m.hand || []).find(c => c.uid === uid) || null;
        }
        if (!card || !isMyTurn()) return;
        if (card.broken || card.stolen || (card.consumption || '').length < 2) {
          FX.errorBeep();
          FX.toast('На кон — только целая своя программа с потреблением от 2 бит.');
          return;
        }
        socket.emit('game:bet', { uid: card.uid });
      });
    }

    // Мобильная: кнопка ☰ ПАНЕЛИ открывает/прячет сайдбар поверх экрана.
    const pb = $('panels-btn');
    if (pb) pb.addEventListener('click', () => {
      document.body.classList.toggle('panels-open');
      FX.sfx.click();
    });
    // Полоска «чей ход» — тап открывает полный список игроков.
    const ts = $('turn-strip');
    if (ts) ts.addEventListener('click', openPlayersModal);
    $('players-modal-close').addEventListener('click', () => $('players-modal').classList.remove('show'));


    // --- отладка ---
    const dbgSet = (field, delta) => {
      const m = me();
      if (!m) return;
      if (field === 'hp') socket.emit('debug:set', { hp: m.hp + delta });
      else socket.emit('debug:set', { power: m.power + delta });
    };
    $('dbg-hp-minus').addEventListener('click', () => dbgSet('hp', -1));
    $('dbg-hp-plus').addEventListener('click', () => dbgSet('hp', 1));
    $('dbg-pw-minus').addEventListener('click', () => dbgSet('pw', -1));
    $('dbg-pw-plus').addEventListener('click', () => dbgSet('pw', 1));
    $('dbg-reroll').addEventListener('click', () => socket.emit('debug:slots', { action: 'reroll' }));
    $('dbg-endturn').addEventListener('click', () => socket.emit('debug:endTurn'));
  }

  function reset() {
    pending = null;
    mapDrawnFor = null;
    document.body.classList.remove('overheat');
    stopOverheatFx();
    updatePatternPicker();
    updateAmountPicker();
    $('target-hint').textContent = '';
    // веер карт — отдельный оверлей поверх экранов: прячем при выходе из матча
    const fan = $('hand-fan');
    if (fan) { fan.classList.add('hidden'); $('fan-cards').innerHTML = ''; }
    const cc = $('cipher-card');
    if (cc) { cc.classList.add('hidden'); cc.innerHTML = ''; }
    stopLowHpFx();
  }

  return { render, init, reset };
})();
