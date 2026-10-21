// ============================================================================
// ШИФРОПАНК — точка входа клиента
// ============================================================================

// ── ЛОКАЛЬНЫЕ НАСТРОЙКИ ВИДА ─────────────────────────────────────────────
// Живут ТОЛЬКО в этом браузере (localStorage): цветовая тема, размер
// интерфейса, дизайн руки, ширина окна карты. На сервер и других игроков
// не влияют — вид у каждого свой. game.js читает PREFS.hand при отрисовке
// руки, поэтому объект объявлен ЗДЕСЬ, до IIFE (глобальная видимость).
const PREFS = {
  theme: 'green',   // green | amber | ice | ultra | terminal
  ui: 'standard',   // compact | standard | large
  hand: 'fan',      // fan (веер-дуга) | classic (ряд+стрелки) | list (список)
  mapscale: 100,    // масштаб КЛЕТОК карты в бою, % (100 = влезает в окно)
  load() {
    const g = (k, d) => localStorage.getItem(k) || d;
    this.theme = g('shifro-theme', this.theme);
    this.ui = g('shifro-ui', this.ui);
    this.hand = g('shifro-hand', this.hand);
    // Быстрый выбор темы через ?theme=... в ссылке (старое поведение)
    const urlTheme = new URLSearchParams(location.search).get('theme');
    if (urlTheme) this.theme = urlTheme;
    // Валидация: старые/удалённые значения откатываются на дефолт
    // (например, тему «КРОВЬ» убрали — красный зарезервирован под перегрев).
    if (!['green', 'amber', 'ice', 'ultra', 'terminal'].includes(this.theme)) this.theme = 'green';
    if (!['compact', 'standard', 'large'].includes(this.ui)) this.ui = 'standard';
    if (!['fan', 'classic', 'list'].includes(this.hand)) this.hand = 'fan';
    const s = parseInt(localStorage.getItem('shifro-mapscale'), 10);
    if (s >= 50 && s <= 200) this.mapscale = s;
  },
  save() {
    localStorage.setItem('shifro-theme', this.theme);
    localStorage.setItem('shifro-ui', this.ui);
    localStorage.setItem('shifro-hand', this.hand);
    localStorage.setItem('shifro-mapscale', String(this.mapscale));
  },
};
PREFS.load();

(async function main() {
  // Мета-данные (программы, интерфейсы)
  try {
    NET.meta = await (await fetch('/api/meta')).json();
  } catch (e) {
    $('join-status').textContent = 'Не удалось получить данные сервера.';
    return;
  }

  LOBBY.init();
  SETUP.init();
  GAME.init();
  SNAKE.init(); // змейка на время долгого ожидания хода
  wireChat('chat-text', 'chat-send');
  wireChat('chat-text-game', 'chat-send-game');

  // Секретная кнопка отладки: невидимая, в правом нижнем углу экрана входа.
  // Сервер принимает debug:enable только от игрока в лобби, поэтому если
  // кнопку нажали до входа — запоминаем и включаем сразу после подключения.
  let wantDebug = false;
  $('debug-btn').addEventListener('click', () => {
    wantDebug = true;
    if (NET.myId) {
      socket.emit('debug:enable');
    } else {
      FX.toast('◈ режим отладки включится при подключении');
    }
  });

  // ── Авто-восстановление сессии ───────────────────────────────────────
  // Телефон уснул / сеть моргнула — сокет оборвался. Socket.io сам поднимет
  // соединение, а мы молча вернём игрока в его комнату: позывной и код
  // храним локально (6 часов). Сервер отдаст персонажа обратно, если матч
  // ещё идёт (механика «сироты»), или посадит в лобби/подготовку.
  const SESSION_KEY = 'shifro-session';
  let lastJoinName = '';      // позывной текущей попытки входа
  let autoRejoining = false;  // сейчас идёт молчаливое восстановление
  const saveSession = (code) => {
    if (!lastJoinName || !code) return;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ name: lastJoinName, code, at: Date.now() }));
  };
  const loadSession = () => {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (s && s.name && s.code && Date.now() - s.at < 6 * 3600 * 1000) return s;
    } catch (e) { /* битая запись — считаем, что сессии нет */ }
    return null;
  };
  const dropSession = () => localStorage.removeItem(SESSION_KEY);
  const rejoin = (saved) => {
    autoRejoining = true;
    $('join-status').textContent = `Восстанавливаю связь с комнатой ${saved.code}...`;
    socket.emit('join', { name: saved.name, mode: 'join', code: saved.code });
  };

  // ---------- вход ----------
  // «Создать игру» — новая комната, вы её хост. «Подключиться» — по коду комнаты.
  const tryJoin = (mode) => {
    const name = $('join-name').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    lastJoinName = name; autoRejoining = false; // ручной вход перекрывает авто-восстановление
    if (mode !== 'create' && !code) {
      $('join-status').textContent = 'Введите код комнаты (его скажет хост) — или создайте свою игру.';
      return;
    }
    socket.emit('join', { name, mode, code });
    $('rules-modal').classList.add('hidden'); // при подключении окно правил закрывается
    AUDIO.init(); // инициализируем звук по жесту пользователя
  };
  $('join-create').addEventListener('click', () => tryJoin('create'));
  // Выход из комнаты (лобби): забываем сессию — иначе F5 вернёт обратно.
  $('leave-btn').addEventListener('click', () => {
    dropSession();
    location.reload();
  });
  $('join-btn').addEventListener('click', () => tryJoin('join'));
  $('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') tryJoin($('join-code').value.trim() ? 'join' : 'create'); });
  $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') tryJoin('join'); });

  // ---------- окно правил (содержимое — отдельный файл rules.html) ----------
  $('rules-btn').addEventListener('click', () => $('rules-modal').classList.remove('hidden'));
  $('rules-close').addEventListener('click', () => $('rules-modal').classList.add('hidden'));
  // Клик по тёмному фону вокруг окна — тоже закрыть.
  $('rules-modal').addEventListener('click', (e) => {
    if (e.target === $('rules-modal')) $('rules-modal').classList.add('hidden');
  });

  socket.on('joined', ({ id, code }) => {
    NET.myId = id;
    saveSession(code); // запоминаем комнату — при обрыве вернёмся сами
    $('join-status').textContent = 'Подключено. Открываю канал...';
    if (autoRejoining) {
      autoRejoining = false;
      FX.toast('⟳ связь восстановлена — вы снова в комнате');
      FX.sfx.turn();
    }
    if (wantDebug) socket.emit('debug:enable'); // отладка заказана на экране входа
  });

  // Сервер отказал во входе (например, позывной в «чёрном списке» после кика).
  socket.on('join:rejected', ({ reason } = {}) => {
    $('join-status').textContent = reason || 'Вход отклонён.';
    if (autoRejoining) { autoRejoining = false; dropSession(); } // комнаты больше нет — забываем её
  });

  // Нас исключили из сессии (кик хоста) — сообщение и перезагрузка на экран входа.
  socket.on('kicked', () => {
    dropSession(); // исключены — авто-возврат после перезагрузки не нужен
    alert('Вас исключили из сессии хостом.');
    location.reload();
  });

  // ---------- переключение экранов ----------
  function showScreen(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    $(`screen-${name}`).classList.add('active');
  }

  socket.on('lobby', (l) => {
    const prevPhase = NET.phase;
    NET.lobby = l;
    NET.phase = l.phase;
    // Страховка от «призраков»: тот, кто ещё НЕ подключился (сидит на экране
    // ввода позывного), не должен проваливаться в подготовку/матч, когда
    // остальные нажали «ГОТОВ». Он остаётся на экране входа и сам решает,
    // когда подключаться. В фазу лобби пускаем всех — там и ввод имени.
    const inLobby = NET.myId && l.players.some(p => p.id === NET.myId);
    if (!inLobby) {
      if (l.phase !== 'lobby') {
        $('join-status').textContent = 'Матч уже собирается — вы подключитесь к нему, как только введёте позывной (в подготовке) или когда все вернутся в лобби.';
      }
      return;
    }
    if (l.phase === 'lobby') {
      showScreen('lobby');
      LOBBY.render();
      FX.hideOverlays();
      GAME.reset();
      SETUP.reset();
    } else if (l.phase === 'setup') {
      showScreen('setup');
      AUDIO.hideRadioWindow(); // окно радио не должно висеть поверх загрузки
      if (prevPhase !== 'setup') { SETUP.reset(); GAME.reset(); } // новый матч — старая рука карт не должна висеть
    } else if (l.phase === 'game') {
      showScreen('game');
      if (prevPhase !== 'game') { GAME.reset(); FX.hideOverlays(); }
    }
  });

  socket.on('state', (s) => {
    NET.state = s;
    if (NET.phase === 'setup') SETUP.render();
    if (NET.phase === 'game') GAME.render();
  });

  // ---------- обмен местами в очереди ----------
  let swapFromId = null;
  socket.on('setup:swapOffer', ({ fromId, fromName }) => {
    swapFromId = fromId;
    $('swap-text').textContent = `${fromName} предлагает обменяться местами в очереди.`;
    $('swap-modal').classList.add('show');
  });
  $('swap-accept').addEventListener('click', () => {
    socket.emit('setup:swapAnswer', { fromId: swapFromId, accept: true });
    $('swap-modal').classList.remove('show');
  });
  $('swap-decline').addEventListener('click', () => {
    socket.emit('setup:swapAnswer', { fromId: swapFromId, accept: false });
    $('swap-modal').classList.remove('show');
  });

  // ---------- прочее ----------
  // Затемнение (режим для уставших глаз) — живёт в поповере 🎨 ВИД.
  $('eye-btn').addEventListener('click', () => {
    const on = document.body.classList.toggle('eye-calm');
    $('eye-state').textContent = on ? 'ВКЛ' : 'ВЫКЛ';
  });
  if (document.body.classList.contains('eye-calm')) $('eye-state').textContent = 'ВКЛ';

  // Таблица ставок Матрицы: открывается кнопкой (выбор класса / топбар боя),
  // сама НЕ закрывается — только крестиком или Esc.
  window.openMatrixHelp = () => { $('matrix-help').classList.remove('hidden'); FX.sfx.click(); };
  $('matrix-help-close').addEventListener('click', () => $('matrix-help').classList.add('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('matrix-help').classList.contains('hidden')) {
      $('matrix-help').classList.add('hidden');
    }
  });
  $('back-lobby-btn').addEventListener('click', () => socket.emit('lobby:reset'));

  // Кнопка на экране смерти: убрать оверлей и смотреть бой дальше.
  // Чисто клиентское действие — сервер и так шлёт состояние всем в комнате.
  $('death-spectate-btn').addEventListener('click', () => {
    $('overlay-death').classList.remove('show');
    FX.toast('РЕЖИМ НАБЛЮДАТЕЛЯ — вы следите за боем');
  });

  // Пауза таймера (на случай AFK)
  $('timer-pause-btn').addEventListener('click', () => socket.emit('game:pauseTimer'));

  // Звук клика на всех кнопках интерфейса
  document.addEventListener('click', (e) => {
    if (e.target.closest('.btn')) FX.sfx.click();
  });

  // ---------- настройки вида (поповер 🎨 ВИД) ----------
  // Применяет PREFS к <body>: классы темы/размера/руки + ширина карты.
  // После смены: карта пересчитывает клетки (событие resize), рука
  // перерисовывается (событие prefs:hand ловит game.js).
  function applyPrefs() {
    const b = document.body;
    b.classList.remove('theme-amber', 'theme-ice', 'theme-red', 'theme-ultra', 'theme-terminal');
    if (PREFS.theme !== 'green') b.classList.add('theme-' + PREFS.theme);
    b.classList.toggle('ui-compact', PREFS.ui === 'compact');
    b.classList.toggle('ui-large', PREFS.ui === 'large');
    b.classList.toggle('hand-classic', PREFS.hand === 'classic');
    b.classList.toggle('hand-list', PREFS.hand === 'list');
    // синхронизируем контролы поповера
    $('pref-theme').value = PREFS.theme;
    $('pref-ui').value = PREFS.ui;
    $('pref-hand').value = PREFS.hand;
    $('pref-mapscale').value = PREFS.mapscale;
    $('pref-mapscale-val').textContent = PREFS.mapscale + '%';
    PREFS.save();
    window.dispatchEvent(new Event('resize'));           // пересчёт клеток карты
    document.dispatchEvent(new CustomEvent('prefs:hand')); // перерисовка руки
  }
  applyPrefs();

  // Открытие/закрытие поповера (кнопки на экране входа и в шапке боя)
  const prefsPop = $('prefs-pop');
  const togglePrefs = (e) => { e.stopPropagation(); prefsPop.classList.toggle('hidden'); };
  $('prefs-btn').addEventListener('click', togglePrefs);
  $('prefs-btn-join').addEventListener('click', togglePrefs);
  prefsPop.addEventListener('click', (e) => e.stopPropagation()); // клик внутри не закрывает
  document.addEventListener('click', () => prefsPop.classList.add('hidden'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') prefsPop.classList.add('hidden'); });

  // Контролы: тема / размер интерфейса / дизайн руки / размер карты
  $('pref-theme').addEventListener('change', (e) => { PREFS.theme = e.target.value; applyPrefs(); });
  $('pref-ui').addEventListener('change', (e) => { PREFS.ui = e.target.value; applyPrefs(); });
  $('pref-hand').addEventListener('change', (e) => { PREFS.hand = e.target.value; applyPrefs(); });
  $('pref-mapscale').addEventListener('input', (e) => {
    PREFS.mapscale = Math.max(50, Math.min(200, parseInt(e.target.value, 10) || 100));
    applyPrefs();
  });

  // ---------- мобильный режим ----------
  // Телефон = сенсорный указатель ИЛИ узкое окно. Класс body.mobile включает
  // компактный лэйаут (style.css) и тап-управление картами (game.js).
  function detectMobile() {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    document.body.classList.toggle('mobile', !!(coarse || window.innerWidth <= 900));
  }
  detectMobile();
  window.addEventListener('resize', detectMobile);

  socket.on('connect', () => {
    $('join-status').textContent = 'Канал открыт.';
    // Socket.io восстановил соединение прозрачно (короткий обрыв до 2 мин):
    // сервер и не заметил разрыва — повторный вход дал бы ДУБЛЬ в лобби.
    if (socket.recovered) return;
    // Возврат в комнату: (а) переподключение после долгого обрыва,
    // (б) свежее открытие страницы с живой сессией.
    // Ссылка ?autojoin= имеет приоритет — тогда не вмешиваемся.
    if (new URLSearchParams(location.search).get('autojoin')) return;
    const saved = loadSession();
    if (saved) rejoin(saved);
  });
  socket.on('disconnect', () => {
    $('join-status').textContent = 'Соединение потеряно. Восстанавливаю сам — перезагружать страницу НЕ нужно...';
    if (NET.phase === 'game') FX.toast('!! связь потеряна — восстанавливаю...');
  });

  // Свежее открытие страницы: событие 'connect' могло пройти ДО регистрации
  // обработчиков (socket создаётся в net.js при загрузке скрипта, а этот код —
  // после await fetch /api/meta) — тогда авто-вход по сессии запускаем явно.
  const qs = new URLSearchParams(location.search);
  const auto = qs.get('autojoin');
  if (!auto && socket.connected && !NET.myId) {
    const saved = loadSession();
    if (saved) rejoin(saved);
  }

  // Быстрый вход по ссылке: http://<сервер>:3000/?autojoin=ИМЯ&room=КОД
  if (auto) {
    $('join-name').value = auto;
    const roomCode = (qs.get('room') || '').toUpperCase();
    if (roomCode) $('join-code').value = roomCode;
    socket.emit('join', { name: auto, mode: roomCode ? 'join' : 'create', code: roomCode });
    AUDIO.init();
  }
})();
