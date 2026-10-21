// ============================================================================
// ШИФРОПАНК — фаза подготовки (пошагово):
//   1. выбор интерфейса -> 2. редактор карты (у хоста) / ожидание (у остальных)
//   -> 3. сборка руки -> 4. расстановка персонажей -> автостарт матча.
// ============================================================================
const SETUP = (() => {
  let selectedInterface = null;
  let picked = [];            // progId[] (без дубликатов!)
  let localStep = 'class';    // 'class' | 'hand' — локальный шаг до отправки сборки
  let rectAnchor = null;      // первый угол прямоугольной заливки {x, y}
  let loadTimer = null;       // интервал анимации загрузки
  const drawnGrids = {};      // ключ размеров -> per-grid флаг отрисовки

  const isHost = () => NET.lobby && NET.lobby.players.length && NET.lobby.players[0].id === NET.myId;
  const meState = () => NET.state && NET.state.players.find(p => p.id === NET.myId);
  const submitted = () => { const m = meState(); return !!(m && m.interfaceId && m.handCount > 0); };
  const ifaceShort = (id) => {
    const i = (NET.meta.interfaces || []).find(x => x.id === id);
    return i ? (i.short || i.name) : '...';
  };

  // ---------- шаги ----------
  const STEPS = ['step-class', 'step-hand', 'step-wait', 'step-map', 'step-deploy'];
  function showStep(id) {
    for (const s of STEPS) $(s).classList.toggle('hidden', s !== id);
    if (id === 'step-wait') startLoading(); else stopLoading();
    if (id === 'step-map') requestAnimationFrame(() => renderEditorMap());
    if (id === 'step-deploy') requestAnimationFrame(() => renderDeployMap());
  }

  function currentStep() {
    if (!NET.state) return 'step-class';
    if (NET.state.setupStage === 'deploy') return 'step-deploy';
    // Карта идёт ДО сбора руки: после выбора класса хост редактирует сектор,
    // остальные ждут; когда карта готова (mapDone) — все собирают руки.
    if (submitted()) return 'step-wait';
    if (localStep === 'class') return 'step-class';
    if (!NET.state.mapDone) return isHost() ? 'step-map' : 'step-wait';
    return 'step-hand';
  }

  // ---------- шаг 1: интерфейсы ----------
  function renderInterfaces() {
    const box = $('interface-list');
    box.innerHTML = '';
    for (const iface of NET.meta.interfaces) {
      const div = document.createElement('div');
      // iface-<id> — свой цвет у каждого класса (CSS: КОРП синий, ВОЕН красный и т.д.)
      div.className = `iface-card iface-${iface.id}` + (selectedInterface === iface.id ? ' selected' : '');
      div.innerHTML = `<b>${esc(iface.name)}</b><p>${esc(iface.desc)}</p>`;
      // Матрица: таблица удач/провалов ставки — отдельным окном (не засоряет описание).
      if (iface.id === 'matrix') {
        const btn = document.createElement('button');
        btn.className = 'btn small matrix-table-btn';
        btn.textContent = '🎰 ТАБЛИЦА СТАВОК';
        btn.addEventListener('click', (e) => { e.stopPropagation(); window.openMatrixHelp(); });
        div.appendChild(btn);
      }
      div.addEventListener('click', () => {
        // Повторный клик/тап по уже выбранному классу — сразу «ДАЛЕЕ».
        if (selectedInterface === iface.id) {
          FX.sfx.click();
          $('to-hand-btn').click();
          return;
        }
        selectedInterface = iface.id;
        FX.sfx.click();
        renderInterfaces();
      });
      box.appendChild(div);
    }
  }

  // ---------- шаг 2: драфт программ (без дубликатов) ----------
  function maxPrograms() {
    return NET.debug ? draftablePrograms().length : (NET.lobby ? NET.lobby.settings.maxPrograms : 9);
  }

  // Программы, доступные для драфта (hidden — служебные, их выдать нельзя).
  function draftablePrograms() {
    return NET.meta.programs.filter(p => !p.hidden);
  }

  function renderPool() {
    const pool = $('program-pool');
    pool.innerHTML = '';
    for (const prog of draftablePrograms()) {
      const taken = picked.includes(prog.id);
      const div = document.createElement('div');
      div.className = `prog-card kind-${prog.kind}` + (taken ? ' taken' : '');
      div.innerHTML = `<div class="p-name">${esc(prog.name)}${taken ? ' ✔' : ''}</div>
        <div class="p-cons">${esc(prog.consumption)}</div>
        <div class="p-desc">${esc(prog.desc)}</div>
        ${prog.burns ? '<div class="p-burn">⚠ сгорает после использования</div>' : ''}`;
      div.title = prog.desc; // полный текст описания — во всплывающей подсказке
      div.addEventListener('click', () => {
        if (taken) { FX.errorBeep(); return FX.toast('Дубликаты запрещены: программа уже в руке.'); }
        if (picked.length >= maxPrograms()) { FX.errorBeep(); return FX.toast(`Рука полная (${maxPrograms()} программ).`); }
        picked.push(prog.id);
        FX.sfx.slot();
        renderPool(); renderHand();
      });
      pool.appendChild(div);
    }
    $('hand-counter').textContent = `(${picked.length}/${maxPrograms()})`;
  }

  function renderHand() {
    const box = $('setup-hand');
    box.innerHTML = '';
    picked.forEach((progId, i) => {
      const prog = NET.meta.programs.find(p => p.id === progId);
      const div = document.createElement('div');
      div.className = `prog-card kind-${prog.kind} in-hand`;
      div.innerHTML = `<div class="p-name">${esc(prog.name)}</div>
        <div class="p-cons">${esc(prog.consumption)}</div>`;
      div.title = 'Клик — убрать из руки';
      div.addEventListener('click', () => {
        picked.splice(i, 1);
        renderPool(); renderHand();
      });
      box.appendChild(div);
    });
  }

  // ---------- очередь (с интерфейсами игроков) ----------
  function renderOrder() {
    const ul = $('setup-order');
    ul.innerHTML = '';
    if (!NET.state) return;
    NET.state.order.forEach((pid, idx) => {
      const p = NET.state.players.find(pl => pl.id === pid);
      if (!p) return;
      const li = document.createElement('li');
      li.innerHTML = `<span class="dim">#${idx + 1}</span>
        <span class="p-color" style="background:${esc(p.color)}"></span>
        <span>${esc(p.name)}${p.debug ? ' <span class="p-tag">DEBUG</span>' : ''}</span>
        <span class="p-iface">${esc(ifaceShort(p.interfaceId))}</span>
        <span class="p-ready" style="margin-left:auto">${p.interfaceId && p.handCount > 0 ? '✔' : '...'}</span>`;
      if (pid !== NET.myId) {
        const btn = document.createElement('button');
        btn.className = 'btn tiny';
        btn.textContent = '⇄ обмен';
        btn.addEventListener('click', () => {
          socket.emit('setup:swapRequest', { targetId: pid });
          FX.toast('Запрос на обмен отправлен.');
        });
        li.appendChild(btn);
      }
      ul.appendChild(li);
    });
  }

  // ---------- анимация загрузки (шаг ожидания) ----------
  const LOAD_LINES = [
    '> handshake с узлом сектора... OK',
    '> маршрутизация через 26.x.x.x... OK',
    '> рукопожатие нейроинтерфейса... OK',
    '> загрузка карты сектора... ждём хоста',
    '> расшифровка пиксельной сетки...',
    '> проверка целостности слотов...',
    '> шум в канале: допустимый',
  ];
  function startLoading() {
    if (loadTimer) return;
    let i = 0;
    const log = $('load-log');
    log.textContent = '';
    $('load-fill').style.width = '5%';
    loadTimer = setInterval(() => {
      const line = LOAD_LINES[i % LOAD_LINES.length];
      log.textContent += line + '\n';
      if (log.textContent.split('\n').length > 9) {
        log.textContent = log.textContent.split('\n').slice(-9).join('\n');
      }
      const pct = 5 + ((i * 13) % 90);
      $('load-fill').style.width = pct + '%';
      i++;
      if (i % 3 === 0) FX.sfx.chat();
    }, 450);
  }
  function stopLoading() {
    clearInterval(loadTimer);
    loadTimer = null;
  }

  // ---------- редактор карты (хост) ----------
  function currentTool() { return $('tool-select').value; }

  function fitCells(grid, w, h) {
    const cw = grid.clientWidth - 12, ch = grid.clientHeight - 12;
    if (cw <= 0 || ch <= 0) return;
    const size = Math.max(8, Math.min(24, Math.floor(Math.min(cw / w, ch / h))));
    grid.style.setProperty('--cell', size + 'px');
  }

  // Текущая конфигурация объекта из панели инструментов. Ластик = null (стирание).
  function currentObjConfig() {
    const tool = currentTool();
    if (tool === 'erase') return null;
    const base = {
      type: tool,
      name: $('obj-name').value.trim(),
      color: $('obj-color').value,
      roundsLeft: +$('obj-rounds').value || 0,
    };
    if (tool === 'zone') {
      base.walkable = $('zone-walkable').checked;
      base.effect = { kind: $('zone-effect').value, amount: +$('zone-amount').value || 0 };
    } else if (tool === 'mine') {
      base.effect = { kind: 'damage', amount: +$('mine-amount').value || 5 };
    } else if (tool === 'portal') {
      base.radius = +$('portal-radius').value || 0; // 0 = телепорт по всей карте
    } else if (tool === 'portal2') {
      base.pair = +$('portal2-pair').value || 1; // номер связанной пары порталов
    } else if (tool === 'point') {
      // Чья точка контроля: '' — нейтральная (для всех), 0..3 — команда А/Б/В/Г.
      base.team = $('point-team').value === '' ? null : +$('point-team').value;
    }
    return base;
  }

  // Клетка + её зеркальные отражения по выбранным осям.
  function mirroredCells(x, y) {
    const { w, h } = NET.state.map;
    const mode = $('tool-mirror').value;
    const pts = [{ x, y }];
    if (mode === 'h' || mode === 'both') pts.push({ x: w - 1 - x, y });
    if (mode === 'v' || mode === 'both') pts.push({ x, y: h - 1 - y });
    if (mode === 'both') pts.push({ x: w - 1 - x, y: h - 1 - y });
    const seen = new Set();
    return pts.filter(p => { const k = p.x + ',' + p.y; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  const GLYPHS = '▓▒░╳#%&@?!';
  const rndGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

  // Общий рендер клетки с объектом (редактор и расстановка).
  function paintCell(cell, x, y) {
    const k = `${x},${y}`;
    const obj = NET.state.map.objects[k];
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
      if (obj.type === 'wall') {
        cell.classList.add('wall');
        cell.dataset.glyph = rndGlyph();
        cell.style.animationDelay = (Math.random() * 0.8).toFixed(2) + 's';
      } else if (obj.type === 'mine') {
        cell.classList.add('obj-mine');
      } else if (obj.type === 'portal') {
        cell.classList.add('obj-portal');
        if (obj.radius > 0) cell.title += ` (радиус ${obj.radius})`;
      } else if (obj.type === 'portal2') {
        cell.classList.add('obj-portal2');
        cell.dataset.pair = obj.pair || 1; // номер пары рисуется в углу клетки
        cell.title += ` (пара №${obj.pair || 1})`;
      } else if (obj.type === 'point') {
        cell.classList.add('obj-point');
        if (obj.team != null) {
          cell.dataset.team = 'АБВГ'[obj.team]; // буква команды в углу клетки
          cell.title += ` (команда ${'АБВГ'[obj.team]})`;
        }
      } else if (obj.type === 'rift') {
        cell.classList.add('obj-rift');   // разлом данных: сломать программу
      } else if (obj.type === 'spawn') {
        cell.classList.add('obj-spawn');  // пиксель спауна: стартовая клетка
      } else if (obj.type === 'copy') {
        cell.classList.add('obj-copy');
      } else {
        cell.classList.add('zone');
        cell.style.background = obj.color + '55';
        if (!obj.walkable) cell.classList.add('zone-solid');
      }
    }
    const pawn = NET.state.players.find(p => p.pos && p.pos.x === x && p.pos.y === y);
    if (pawn) {
      const d = document.createElement('div');
      d.className = 'pawn';
      d.style.background = pawn.color;
      d.style.color = pawn.color;
      cell.appendChild(d);
      cell.title = pawn.name;
    }
  }

  function ensureGrid(grid, w, h, onClick, onRmb) {
    const mapKey = `${grid.id}:${w}x${h}`;
    if (drawnGrids[grid.id] !== mapKey) {
      grid.style.gridTemplateColumns = `repeat(${w}, var(--cell, 18px))`;
      grid.innerHTML = '';
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.x = x; cell.dataset.y = y;
        if (onClick) cell.addEventListener('click', onClick);
        if (onRmb) cell.addEventListener('contextmenu', (e) => { e.preventDefault(); onRmb(e); });
        grid.appendChild(cell);
      }
      drawnGrids[grid.id] = mapKey;
    }
    fitCells(grid, w, h);
  }

  function renderEditorMap() {
    if (!NET.state) return;
    const { w, h } = NET.state.map;
    const grid = $('setup-map');
    ensureGrid(grid, w, h, onEditorClick, (e) => {
      rectAnchor = null;
      socket.emit('map:removeObject', { x: +e.currentTarget.dataset.x, y: +e.currentTarget.dataset.y });
    });
    for (const cell of grid.children) {
      paintCell(cell, +cell.dataset.x, +cell.dataset.y);
      if (rectAnchor && +cell.dataset.x === rectAnchor.x && +cell.dataset.y === rectAnchor.y) {
        cell.classList.add('rect-anchor');
      }
    }
  }

  function onEditorClick(e) {
    const x = +e.currentTarget.dataset.x, y = +e.currentTarget.dataset.y;
    FX.sfx.click();
    if ($('tool-rect').checked && currentTool() !== 'erase') {
      if (!rectAnchor) {
        rectAnchor = { x, y };
        renderEditorMap();
        FX.toast('Угол задан. Кликните второй угол для заливки.');
      } else {
        socket.emit('map:fillRect', { x1: rectAnchor.x, y1: rectAnchor.y, x2: x, y2: y, obj: currentObjConfig() });
        rectAnchor = null;
        FX.sfx.walls();
      }
      return;
    }
    paintAt(x, y);
  }

  // Установка/стирание с учётом зеркала — одним пакетом на сервер.
  function paintAt(x, y) {
    socket.emit('map:paintCells', { cells: mirroredCells(x, y), obj: currentObjConfig() });
  }

  // Рисование с зажатой ЛКМ: серия paintCells (на сервере сливается в одну отмену).
  let painting = false;
  function bindDragPaint() {
    const grid = $('setup-map');
    grid.addEventListener('mousedown', (e) => {
      if (e.button === 0) painting = true;
    });
    grid.addEventListener('mouseover', (e) => {
      if (!painting || $('tool-rect').checked) return;
      const cell = e.target.closest('.cell');
      if (!cell) return;
      paintAt(+cell.dataset.x, +cell.dataset.y);
    });
    window.addEventListener('mouseup', () => { painting = false; });
    grid.addEventListener('dragstart', (e) => e.preventDefault()); // не тащить «картинку» сетки
  }

  // Пиксели спауна на карте (если есть — расстановка только на них).
  function spawnCellsLocal() {
    const out = [];
    for (const k of Object.keys(NET.state.map.objects)) {
      if (NET.state.map.objects[k].type === 'spawn') out.push(k);
    }
    return out;
  }

  function renderDeployMap() {
    if (!NET.state) return;
    const { w, h } = NET.state.map;
    const grid = $('deploy-map');
    const spawns = spawnCellsLocal();
    ensureGrid(grid, w, h, (e) => {
      const x = +e.currentTarget.dataset.x, y = +e.currentTarget.dataset.y;
      if (spawns.length && !spawns.includes(`${x},${y}`)) {
        FX.errorBeep();
        return FX.toast('На этой карте расстановка только по пикселям спауна (белые ⦿).');
      }
      socket.emit('setup:place', { x, y });
      FX.sfx.move();
    }, null);
    for (const cell of grid.children) {
      paintCell(cell, +cell.dataset.x, +cell.dataset.y);
      if (spawns.length && spawns.includes(`${cell.dataset.x},${cell.dataset.y}`)) cell.classList.add('spawn-hl');
    }
  }

  // ---------- главный рендер ----------
  function render() {
    if (!NET.state) return;
    const m = meState();
    if (m) {
      if (m.interfaceId && !selectedInterface) selectedInterface = m.interfaceId;
      if (m.color) $('setup-color').value = m.color;
    }
    renderInterfaces();
    renderPool();
    renderHand();
    renderOrder();
    const step = currentStep();
    showStep(step);
    if (step === 'step-map') renderEditorMap();
    if (step === 'step-deploy') renderDeployMap();
    // статус
    const status = $('setup-status');
    if (NET.state.setupStage === 'deploy') {
      status.textContent = m && m.pos
        ? '✔ Вы на карте. Ожидание остальных...'
        : (spawnCellsLocal().length ? 'Поставьте персонажа на пиксель спауна (⦿).' : 'Поставьте персонажа на карту.');
    } else if (submitted()) {
      status.textContent = 'Сборка принята. Ожидание остальных игроков...';
    } else if (localStep !== 'class' && !NET.state.mapDone) {
      status.textContent = isHost()
        ? 'Вы — хост. Настройте карту и нажмите «КАРТА ГОТОВА».'
        : 'Хост настраивает карту сектора...';
    } else {
      status.textContent = 'Выберите интерфейс, затем соберите руку программ.';
    }
    if (NET.debug) status.textContent += ' ◈DEBUG';
  }

  // ---------- инициализация ----------
  function init() {
    // Шаг 1 -> шаг 2
    $('to-hand-btn').addEventListener('click', () => {
      if (!selectedInterface) { FX.errorBeep(); return FX.toast('Сначала выберите интерфейс.'); }
      localStep = 'hand';
      render();
    });
    $('back-class-btn').addEventListener('click', () => { localStep = 'class'; render(); });
    $('rebuild-btn').addEventListener('click', () => { localStep = 'hand'; showStep('step-hand'); });

    $('setup-color').addEventListener('change', (e) => socket.emit('player:color', { color: e.target.value }));

    // Клик по секретной кнопке отладки подключается в main.js (она на экране входа)
    socket.on('debug:enabled', () => {
      NET.debug = true;
      $('debug-all-btn').classList.remove('hidden');
      FX.toast('◈ РЕЖИМ ОТЛАДКИ АКТИВЕН: доступны все программы, соло-игра, панель DEBUG.');
      FX.sfx.win();
      render();
    });
    $('debug-all-btn').addEventListener('click', () => {
      picked = draftablePrograms().map(p => p.id);
      FX.sfx.success();
      renderPool(); renderHand();
    });

    // Сборка руки -> сервер
    $('setup-submit').addEventListener('click', () => {
      if (!selectedInterface) { FX.errorBeep(); return FX.toast('Выберите интерфейс.'); }
      if (!NET.debug && picked.length !== maxPrograms()) {
        FX.errorBeep(); return FX.toast(`Нужно ровно ${maxPrograms()} программ.`);
      }
      if (NET.debug && picked.length < 1) { FX.errorBeep(); return FX.toast('Рука пуста.'); }
      socket.emit('setup:submit', {
        interfaceId: selectedInterface,
        programs: picked,
      });
    });
    socket.on('setup:accepted', () => { FX.toast('Сборка принята сервером.'); FX.sfx.success(); render(); });

    // Инструменты карты
    const TOOL_DESCS = {
      wall: 'Битый пиксель: непроходимая стена. Блокирует движение и линию видимости. Глитчит и мерцает — так и задумано.',
      zone: 'Зона: окрашенная клетка с эффектом. Можно сделать непроходимой. Эффект срабатывает, когда игрок вступает на клетку.',
      mine: 'Мина: скрытая ловушка. Взрывается, когда кто-то наступает, нанося урон, и исчезает.',
      portal: 'Телепорт: вступивший переносится на случайную свободную клетку В ПРЕДЕЛАХ РАДИУСА от портала (0 — вся карта).',
      portal2: 'Парный телепорт: порталы с ОДИНАКОВЫМ номером пары связаны — вступивший в один переносится к ближайшей свободной клетке второго. Каждую пару ставьте РОВНО из двух штук (номер пары — в параметрах объекта). Порталы разных пар между собой не связаны.',
      point: 'Точка контроля: клетка режима «Захват территории». Стоящий на ней получает программу КодШифр — розыгрыш даёт очко захвата. «Чья точка» — принадлежность команде: в командном режиме чужую точку захватить нельзя (ставьте, например, свою точку на базе врагов — они должны прорваться к ней). «Любая» — нейтральная.',
      rift: 'Разлом данных: вступивший на клетку игрок может ОДИН раз поместить в разлом программу из руки — она станет сломанной (минус выбранный бит потребления, но −2 ХП при каждом использовании). Для каждого игрока разлом срабатывает отдельно.',
      spawn: 'Пиксель спауна: если на карте есть хотя бы один, в начале матча игроки ставят пешки ТОЛЬКО на такие клетки (одна клетка — один игрок; спаунов должно быть не меньше, чем игроков). Без спаунов расстановка свободная.',
      erase: 'Ластик: стирает объект с клетки. Работает и с зажатой ЛКМ — ведите по карте, чтобы снести серию объектов.',
    };
    const EFFECT_DESCS = {
      none: '',
      heal: 'Лечение: вступивший на зону восстанавливает указанное число ХП.',
      damage: 'Урон: вступивший на зону теряет указанное число ХП.',
      power: 'Мощность: вступивший получает дополнительную мощность (временно, до своего следующего хода).',
      teleport: 'Телепорт: вступившего переносит на случайную свободную клетку карты.',
    };
    function updateToolDesc() {
      const t = currentTool();
      $('tool-desc').textContent = TOOL_DESCS[t] || '';
      $('obj-zone-fields').classList.toggle('hidden', t !== 'zone');
      $('obj-mine-fields').classList.toggle('hidden', t !== 'mine');
      $('obj-portal-fields').classList.toggle('hidden', t !== 'portal');
      $('obj-portal2-fields').classList.toggle('hidden', t !== 'portal2');
      $('obj-point-fields').classList.toggle('hidden', t !== 'point');
      // ластику параметры объекта не нужны
      const cfg = document.querySelector('#map-tools-body .obj-config');
      if (cfg) cfg.classList.toggle('hidden', t === 'erase');
      $('zone-effect-desc').textContent = t === 'zone' ? (EFFECT_DESCS[$('zone-effect').value] || '') : '';
    }
    $('tool-select').addEventListener('change', () => {
      const t = currentTool();
      const defaults = { wall: '#ff2244', zone: '#00ff66', mine: '#ff8800', portal: '#b388ff', portal2: '#ff6e40', point: '#00e5ff', erase: '#666666' };
      $('obj-color').value = defaults[t];
      rectAnchor = null;
      updateToolDesc();
    });
    $('zone-effect').addEventListener('change', updateToolDesc);
    updateToolDesc();
    $('map-undo-btn').addEventListener('click', () => socket.emit('map:undo'));
    bindDragPaint();
    // Рамка из битых пикселей по краю карты
    $('map-border-btn').addEventListener('click', () => {
      const { w, h } = NET.state.map;
      const cells = [];
      for (let x = 0; x < w; x++) { cells.push({ x, y: 0 }); cells.push({ x, y: h - 1 }); }
      for (let y = 1; y < h - 1; y++) { cells.push({ x: 0, y }); cells.push({ x: w - 1, y }); }
      socket.emit('map:paintCells', { cells, obj: { type: 'wall', name: 'битый пиксель', color: '#ff2244', roundsLeft: 0 } });
      FX.sfx.walls();
      FX.toast('Край сектора окружён битыми пикселями.');
    });
    // Пресеты карты
    document.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        socket.emit('map:preset', { name: btn.dataset.preset, density: +$('preset-density').value });
        FX.sfx.walls();
        FX.toast('Пресет применён.');
      });
    });
    $('preset-density').addEventListener('input', (e) => {
      $('preset-density-val').textContent = e.target.value + '%';
    });
    // Шаблоны карты (localStorage браузера хоста)
    const TPL_KEY = 'shifro-map-templates';
    const loadTpls = () => { try { return JSON.parse(localStorage.getItem(TPL_KEY)) || {}; } catch (e) { return {}; } };
    const saveTpls = (t) => localStorage.setItem(TPL_KEY, JSON.stringify(t));
    function renderTpls() {
      const box = $('tpl-list');
      box.innerHTML = '';
      const tpls = loadTpls();
      const names = Object.keys(tpls);
      if (!names.length) { box.innerHTML = '<span class="dim" style="font-size:10px">— нет сохранённых шаблонов —</span>'; return; }
      for (const name of names) {
        const row = document.createElement('div');
        row.className = 'tpl-row';
        row.innerHTML = `<span class="tpl-name">${esc(name)}</span>`;
        const loadBtn = document.createElement('button');
        loadBtn.className = 'btn small';
        loadBtn.textContent = 'ЗАГРУЗИТЬ';
        loadBtn.addEventListener('click', () => {
          socket.emit('map:import', { objects: tpls[name] });
          FX.toast(`Шаблон «${name}» загружен на карту.`);
        });
        const delBtn = document.createElement('button');
        delBtn.className = 'btn small danger';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', () => {
          const t = loadTpls(); delete t[name]; saveTpls(t); renderTpls();
        });
        row.appendChild(loadBtn); row.appendChild(delBtn);
        box.appendChild(row);
      }
    }
    $('tpl-save-btn').addEventListener('click', () => {
      const name = $('tpl-name').value.trim();
      if (!name) { FX.errorBeep(); return FX.toast('Введите имя шаблона.'); }
      if (!NET.state) return;
      const tpls = loadTpls();
      tpls[name] = NET.state.map.objects;
      saveTpls(tpls);
      $('tpl-name').value = '';
      FX.toast(`Шаблон «${name}» сохранён.`);
      renderTpls();
    });
    renderTpls();
    // Перетаскиваемое окно инструментов карты
    const mtWin = $('map-tools-window');
    $('map-tools-open-btn').addEventListener('click', () => {
      mtWin.classList.toggle('hidden');
      FX.sfx.click();
    });
    $('map-tools-close-btn').addEventListener('click', () => mtWin.classList.add('hidden'));
    let mtDrag = null;
    $('map-tools-title').addEventListener('mousedown', (e) => {
      if (e.target.closest('#map-tools-close-btn')) return;
      const r = mtWin.getBoundingClientRect();
      mtDrag = { dx: e.clientX - r.x, dy: e.clientY - r.y };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!mtDrag) return;
      mtWin.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - mtDrag.dx)) + 'px';
      mtWin.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - mtDrag.dy)) + 'px';
      mtWin.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { mtDrag = null; });
    $('tool-rect').addEventListener('change', () => { rectAnchor = null; });
    $('map-clear-btn').addEventListener('click', () => {
      socket.emit('map:clear');
      FX.toast('Карта очищена.');
    });
    $('map-done-btn').addEventListener('click', () => socket.emit('setup:mapDone'));

    window.addEventListener('resize', () => {
      if (NET.phase !== 'setup' || !NET.state) return;
      const step = currentStep();
      if (step === 'step-map') renderEditorMap();
      if (step === 'step-deploy') renderDeployMap();
    });
  }

  function reset() {
    selectedInterface = null;
    picked = [];
    localStep = 'class';
    rectAnchor = null;
    stopLoading();
    for (const k of Object.keys(drawnGrids)) delete drawnGrids[k];
  }

  return { render, init, reset };
})();
