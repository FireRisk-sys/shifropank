// ============================================================================
// ШИФРОПАНК — сервер (Express + Socket.IO).
// Запуск:  npm install && npm start
// Игроки открывают в браузере:  http://<IP-из-Radmin>:3000
// ============================================================================

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');

const { PROGRAMS, PROGRAM_MAP, INTERFACES } = require('./game/programs');
const engine = require('./game/engine');

const PORT = process.env.PORT || 3000;
const MUSIC_DIR = path.join(__dirname, 'music');
const NEWS_DIR = path.join(__dirname, 'news');
for (const d of [MUSIC_DIR, NEWS_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/music', express.static(MUSIC_DIR));
app.use('/news', express.static(NEWS_DIR));

// ---------------------------------------------------------------------------
// Мета-данные для клиента (список программ и интерфейсов)
// ---------------------------------------------------------------------------
app.get('/api/meta', (req, res) => res.json({ programs: PROGRAMS, interfaces: INTERFACES }));

// ---------------------------------------------------------------------------
// Загрузка музыки (mp3) — файлы слышны всем игрокам
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: MUSIC_DIR,
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^\wа-яА-ЯёЁ .-]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp3|ogg|wav|m4a|flac|opus|webm|aac)$/i.test(file.originalname);
    cb(ok ? null : new Error('Только аудио-файлы (mp3/ogg/wav/m4a/flac/opus/webm/aac)'), ok);
  },
});

const listAudio = (dir) => fs.readdirSync(dir).filter(f => /\.(mp3|ogg|wav|m4a)$/i.test(f));

app.post('/upload', upload.single('track'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  music.playlist = listAudio(MUSIC_DIR);
  broadcastMusic();
  res.json({ ok: true, playlist: music.playlist });
});

// Ошибки загрузки (multer) — возвращаем JSON, чтобы клиент показал причину.
app.use('/upload', (err, req, res, next) => {
  const msg = err && err.code === 'LIMIT_FILE_SIZE'
    ? 'Файл слишком большой (максимум 80 МБ).'
    : (err && err.message) || 'Ошибка загрузки.';
  res.status(400).json({ error: msg });
});

app.get('/api/playlist', (req, res) => res.json({ playlist: listAudio(MUSIC_DIR) }));

// ---------------------------------------------------------------------------
// Комнаты: на одном сервере может идти НЕСКОЛЬКО игр сразу.
// Каждая комната — по короткому коду (его хост диктует друзьям в Radmin-чате).
// Создавший комнату — её хост (первый в списке лобби).
// ---------------------------------------------------------------------------
const COLORS = ['#00ff9c', '#ff3860', '#29b6f6', '#ffd740', '#b388ff', '#ff6e40', '#69f0ae', '#f48fb1'];

const rooms = new Map(); // code -> room

function createRoom(code) {
  return {
    code,
    phase: 'lobby',             // 'lobby' | 'setup' | 'game'
    settings: defaultSettings(),
    lobbyPlayers: [],           // [{ id, name, color, ready, team, debug }]
    game: null,
    turnTimer: null,
    turnEndsAt: 0,
    turnPaused: false,
    turnRemaining: 0,
    mapHistory: [],
    lastPaintAt: 0,
    snakePlaying: new Set(),    // id игроков с открытым окном змейки (цели для PvP)
    bannedNames: new Set(), // «чёрный список» кикнутых позывных (живёт до возврата в лобби)
    emptyTimer: null,       // отложенное удаление опустевшей комнаты (см. ниже)
    // Плеер — ОТДЕЛЬНЫЙ на каждую комнату: что крутится у одних, не мешает другим.
    // Плейлист общий (файлы на диске), состояние воспроизведения — своё.
    music: { index: 0, playing: false, startedAt: 0, pausedAt: 0 },
  };
}

// Комната опустела (все отключились) — НЕ удаляем сразу: телефон мог просто
// уснуть или моргнула сеть. Даём 10 минут на возвращение, вход в комнату
// отменяет таймер (см. обработчик 'join').
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
function scheduleRoomCleanup(room) {
  clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    if (room.lobbyPlayers.length) return; // кто-то уже вернулся
    clearTimeout(room.turnTimer);
    rooms.delete(room.code);
  }, EMPTY_ROOM_TTL_MS);
}

// Код комнаты: 4 символа без похожих (без 0/O, 1/I/L) — удобно продиктовать.
function makeRoomCode() {
  const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 100; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += ABC[Math.floor(Math.random() * ABC.length)];
    if (!rooms.has(code)) return code;
  }
  return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}

const roomOf = (socket) => rooms.get(socket.data.roomCode) || null;

const music = { playlist: listAudio(MUSIC_DIR), index: 0, playing: false, startedAt: 0, pausedAt: 0 };

// Настройки сессии по умолчанию. turnSeconds = 0 — таймер отключён совсем.
// mode: 'deathmatch' (последний выживший) | 'capture' (захват территории).
function defaultSettings() {
  return {
    startHP: 20, startPower: 9, maxPrograms: 9, turnSeconds: 60, mapW: 30, mapH: 30,
    mode: 'deathmatch', teamsEnabled: false,
    capturePoints: 3, captureLenMin: 3, captureLenMax: 5,
    cipherGrow: 0, cipherStep: 2, // рост КодШифра: +N бит за каждые K очков (0 — выкл)
    antivirusRound: 5,          // раунд появления антивируса (0 — выключен)
    antivirusType: 'random',    // 'random' | 'shuffle' | 'damage' | 'ban' | 'teleport'
  };
}

function sanitizeSettings(s) {
  const num = (v, min, max, dflt) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  const lenMin = num(s.captureLenMin, 1, 8, 3);
  return {
    startHP: num(s.startHP, 1, 99, 20),
    startPower: num(s.startPower, 1, 20, 9),
    maxPrograms: num(s.maxPrograms, 1, PROGRAMS.filter(p => !p.hidden).length, 9),
    turnSeconds: num(s.turnSeconds, 0, 300, 60), // 0 = без таймера
    mapW: num(s.mapW, 10, 40, 30),
    mapH: num(s.mapH, 10, 40, 30),
    mode: s.mode === 'capture' ? 'capture' : 'deathmatch',
    teamsEnabled: !!s.teamsEnabled,
    capturePoints: num(s.capturePoints, 1, 20, 3),
    captureLenMin: lenMin,
    captureLenMax: Math.max(lenMin, num(s.captureLenMax, 1, 10, 5)),
    cipherGrow: num(s.cipherGrow, 0, 10, 0),   // +N бит к КодШифру...
    cipherStep: num(s.cipherStep, 1, 10, 2),   // ...за каждые K набранных очков
    antivirusRound: num(s.antivirusRound, 0, 50, 5), // 0 — антивирус отключён
    antivirusType: ['random', 'shuffle', 'damage', 'ban', 'teleport'].includes(s.antivirusType) ? s.antivirusType : 'random',
  };
}

// ---------------------------------------------------------------------------
// Рассылка состояния
// ---------------------------------------------------------------------------
function broadcastLobby(room) {
  io.to(room.code).emit('lobby', { phase: room.phase, settings: room.settings, players: room.lobbyPlayers, code: room.code });
}

function broadcastGame(room, fx) {
  if (fx && fx.length) io.to(room.code).emit('fx', fx);
  for (const lp of room.lobbyPlayers) {
    const sock = io.sockets.sockets.get(lp.id);
    if (sock) sock.emit('state', engine.serialize(room.game, lp.id));
  }
  // Матч окончен — музыка ЭТОЙ комнаты останавливается (эфир «глохнет» вместе с сессией).
  if (room.game && room.game.over && room.music.playing) {
    room.music.playing = false;
    room.music.pausedAt = Date.now() - room.music.startedAt;
    broadcastMusic(room);
  }
}

// Состояние плеера — на комнату; плейлист (файлы) — общий.
function broadcastMusic(room) {
  io.to(room.code).emit('music:state', { playlist: music.playlist, ...room.music });
}

function sendTurnInfo(room) {
  io.to(room.code).emit('turn:timer', {
    endsAt: room.turnEndsAt,
    seconds: room.settings.turnSeconds,
    paused: room.turnPaused,
    remaining: room.turnRemaining,
  });
}

// ---------------------------------------------------------------------------
// Таймер хода (с ручной паузой — на случай AFK)
// ---------------------------------------------------------------------------
function onTurnTimeout(room) {
  const cur = engine.currentPlayer(room.game);
  if (cur && room.phase === 'game' && !room.game.over) {
    const { fx } = engine.endTurn(room.game, cur.id);
    afterTurnChange(room, fx);
  }
}

function resetTurnTimer(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.turnPaused = false;
  // turnSeconds = 0 — таймер отключён в настройках: ход длится бесконечно.
  if (!room.settings.turnSeconds) {
    room.turnRemaining = 0;
    room.turnEndsAt = 0;
    sendTurnInfo(room);
    return;
  }
  room.turnRemaining = room.settings.turnSeconds * 1000;
  room.turnEndsAt = Date.now() + room.turnRemaining;
  room.turnTimer = setTimeout(() => onTurnTimeout(room), room.turnRemaining);
  sendTurnInfo(room);
}

function toggleTimerPause(room) {
  if (!room.settings.turnSeconds) return; // таймер выключен — паузить нечего
  if (room.phase !== 'game' || !room.game || room.game.over) return;
  if (room.turnPaused) {
    room.turnPaused = false;
    room.turnEndsAt = Date.now() + room.turnRemaining;
    room.turnTimer = setTimeout(() => onTurnTimeout(room), room.turnRemaining);
  } else {
    room.turnRemaining = Math.max(0, room.turnEndsAt - Date.now());
    room.turnPaused = true;
    clearTimeout(room.turnTimer);
  }
  sendTurnInfo(room);
}

// Ноль мощности посреди хода («ОБВАЛ СЕТИ» задел самого ходящего, дебаг и т.п.) —
// ход завершается автоматически: иначе он «висит» — ни слотов, ни действий,
// а кнопка конца хода может быть скрыта экраном перезагрузки.
function autoPassIfNoPower(room) {
  const g = room.game;
  if (!g || room.phase !== 'game' || g.over) return;
  const cur = engine.currentPlayer(g);
  if (cur && cur.alive && engine.powerOf(cur) === 0) {
    g.slots = []; // перезагрузка: слоты сгорают БЕЗ урона за незакрытые
    const { fx } = engine.endTurn(g, cur.id);
    fx.unshift({ type: 'reboot', playerId: cur.id });
    afterTurnChange(room, fx);
  }
}

function afterTurnChange(room, fx) {
  if (room.game.over) {
    clearTimeout(room.turnTimer);
    broadcastGame(room, fx);
    return;
  }
  broadcastGame(room, fx);
  resetTurnTimer(room);
}

// ---------------------------------------------------------------------------
// Переходы фаз
// ---------------------------------------------------------------------------
// Хост (админ) — первый игрок в списке лобби. Только он редактирует карту.
const isHost = (room, id) => room.lobbyPlayers.length > 0 && room.lobbyPlayers[0].id === id;
const anyDebug = (room) => room.lobbyPlayers.some(p => p.debug);

function enterSetup(room) {
  room.phase = 'setup';
  room.game = engine.createGame(room.settings);
  room.mapHistory = [];
  room.game.setupStage = 'build'; // 'build' (класс -> карта у хоста -> рука) -> 'deploy' (расстановка)
  room.game.mapDone = false;      // хост закончил карту (теперь ДО сбора рук)
  // Режим захвата: первое потребление КодШифра бросается сразу.
  if (room.settings.mode === 'capture') {
    room.game.cipherConsumption = engine.rollCipherConsumption(room.settings);
  }
  for (const lp of room.lobbyPlayers) {
    const p = engine.createPlayer(lp.id, lp.name, lp.color);
    p.hp = room.settings.startHP;
    p.basePower = room.settings.startPower;
    p.debug = !!lp.debug;
    p.team = room.settings.teamsEnabled ? lp.team : null; // команда из лобби
    room.game.players.push(p);
    room.game.order.push(p.id);
  }
  broadcastLobby(room);
  broadcastGame(room, []);
}

// Проверка командного режима перед стартом: у всех должна быть команда,
// и команд должно быть минимум две (иначе играть не с кем).
function teamsValid(room) {
  if (!room.settings.teamsEnabled) return true;
  if (room.lobbyPlayers.some(p => p.team == null)) return false;
  return new Set(room.lobbyPlayers.map(p => p.team)).size >= 2;
}

// Все ли игроки собрали сборку (интерфейс + рука)?
function allSubmitted(room) {
  return room.game && room.game.players.every(p => p.interfaceId && p.hand.length >= 1);
}

function startMatch(room) {
  room.phase = 'game';
  room.game.turnIndex = 0;
  const fx = engine.startTurn(room.game);
  broadcastLobby(room);
  broadcastGame(room, fx);
  resetTurnTimer(room);
}

function backToLobby(room) {
  clearTimeout(room.turnTimer);
  room.phase = 'lobby';
  room.game = null;
  for (const lp of room.lobbyPlayers) lp.ready = false;
  room.bannedNames.clear(); // «чёрный список» киков живёт один матч
  broadcastLobby(room);
}

// Исключение игрока по позывному (команда /kick в чате и кнопка ✕ у хоста).
// Работает в любой фазе: лобби, подготовка, матч. Позывной попадает в
// bannedNames — повторный вход с ним закрыт до возврата всех в лобби.
function kickPlayer(room, bySocket, rawName) {
  const name = String(rawName || '').trim();
  const target = room.lobbyPlayers.find(p => p.id !== bySocket.id && p.name.toLowerCase() === name.toLowerCase());
  if (!target) return { error: `Игрок «${name}» не найден (себя кикнуть нельзя).` };
  room.bannedNames.add(target.name);
  io.to(room.code).emit('chat:message', { from: 'СЕРВЕР', color: '#ff5555', text: `⛔ ${target.name} исключён из сессии хостом.`, at: Date.now() });
  const tSock = io.sockets.sockets.get(target.id);
  if (tSock) {
    tSock.emit('kicked', {});
    // Небольшая пауза, чтобы событие 'kicked' гарантированно ушло клиенту
    // до разрыва; дальше срабатывает обычный обработчик disconnect.
    setTimeout(() => tSock.disconnect(true), 250);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Новости: примерно раз в 2 минуты поверх музыки
// ---------------------------------------------------------------------------
function scheduleNews() {
  const delay = (90 + Math.random() * 60) * 1000; // 1.5–2.5 минуты
  setTimeout(() => {
    try {
      const news = listAudio(NEWS_DIR);
      if (news.length) {
        const file = news[Math.floor(Math.random() * news.length)];
        const url = '/news/' + encodeURIComponent(file);
        for (const room of rooms.values()) {
          if (room.music && room.music.playing) io.to(room.code).emit('news:play', { url });
        }
      }
    } catch (e) { /* новости не критичны */ }
    scheduleNews();
  }, delay);
}
scheduleNews();

// ---------------------------------------------------------------------------
// ЗМЕЙКА PvP: красный пиксель (5% после 20 очков в одиночной змейке)
// «проваливает» игрока в змейку случайного соседа по комнате. Дальше поле
// ОБЩЕЕ и арбитр — сервер: у каждого своя змейка, столкновение со стеной
// или ЛЮБОЙ змейкой — смерть. Клиенты только шлют повороты и рисуют кадры.
// ---------------------------------------------------------------------------
const SNAKE_GRID = 16, SNAKE_TICK = 130;
const snakeSessions = new Map(); // socket.id -> session

function snakeFood(sess) {
  const busy = new Set();
  for (const id of sess.players) for (const s of sess.snakes[id]) busy.add(s.x + ',' + s.y);
  let f;
  do { f = { x: Math.floor(Math.random() * SNAKE_GRID), y: Math.floor(Math.random() * SNAKE_GRID) }; }
  while (busy.has(f.x + ',' + f.y));
  return f;
}

function snakeSnapshot(sess) {
  return {
    players: sess.players,
    names: sess.names, colors: sess.colors,
    snakes: sess.snakes, alive: sess.alive, scores: sess.scores, food: sess.food,
  };
}

function snakeEnd(sess, reason) {
  clearInterval(sess.timer);
  for (const id of sess.players) {
    snakeSessions.delete(id);
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.emit('snake:pvpOver', { reason, names: sess.names, scores: sess.scores, alive: sess.alive, players: sess.players });
  }
}

function snakeTick(sess) {
  const [a, b] = sess.players;
  const heads = {};
  for (const id of sess.players) {
    if (!sess.alive[id]) continue;
    const q = sess.queues[id];
    if (q.length) sess.dirs[id] = q.shift();
    const d = sess.dirs[id];
    const h = sess.snakes[id][0];
    heads[id] = { x: h.x + d.x, y: h.y + d.y };
  }
  // Столкновения: стены, тела змей (обеих), лоб в лоб.
  const eating = {};
  for (const id of sess.players) {
    if (!sess.alive[id]) continue;
    eating[id] = heads[id].x === sess.food.x && heads[id].y === sess.food.y;
  }
  const bodyHas = (x, y, skipTailFor) => sess.players.some(pid => {
    const body = sess.snakes[pid];
    // Хвост, который сейчас отползёт (не ест), — не препятствие.
    const lim = (sess.alive[pid] && !eating[pid]) ? body.length - 1 : body.length;
    for (let i = 0; i < lim; i++) if (body[i].x === x && body[i].y === y) return true;
    return false;
  });
  for (const id of sess.players) {
    if (!sess.alive[id]) continue;
    const hd = heads[id];
    if (hd.x < 0 || hd.y < 0 || hd.x >= SNAKE_GRID || hd.y >= SNAKE_GRID || bodyHas(hd.x, hd.y)) sess.alive[id] = false;
  }
  // Лоб в лоб: головы сошлись на одной клетке или прошли друг сквозь друга.
  if (sess.alive[a] && sess.alive[b] &&
      ((heads[a].x === heads[b].x && heads[a].y === heads[b].y) ||
       (heads[a].x === sess.snakes[b][0].x && heads[a].y === sess.snakes[b][0].y &&
        heads[b].x === sess.snakes[a][0].x && heads[b].y === sess.snakes[a][0].y))) {
    sess.alive[a] = false; sess.alive[b] = false;
  }
  for (const id of sess.players) {
    if (!sess.alive[id]) continue;
    sess.snakes[id].unshift(heads[id]);
    if (eating[id]) { sess.scores[id]++; sess.food = snakeFood(sess); }
    else sess.snakes[id].pop();
  }
  if (!sess.alive[a] && !sess.alive[b]) { snakeEnd(sess, 'draw'); return; }
  if (!sess.alive[a] || !sess.alive[b]) { snakeEnd(sess, 'crash'); return; }
  for (const id of sess.players) {
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.emit('snake:pvpState', snakeSnapshot(sess));
  }
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // --- вход в лобби ---
  // ВАЖНО: игрок подключается только по своей кнопке «ПОДКЛЮЧИТЬСЯ К СЕТИ».
  // Клиенты, сидящие на экране ввода имени, в lobbyPlayers НЕ попадают
  // и экраны у них не переключаются (см. main.js) — никого не тянем в матч.
  socket.on('join', ({ name, mode, code } = {}) => {
    const clean = String(name || '').trim().slice(0, 16) || `runner_${socket.id.slice(0, 4)}`;
    // --- КОМНАТА: «Создать игру» (создатель = хост) или «Подключиться» по коду ---
    let room;
    if (mode === 'create') {
      const c = makeRoomCode();
      room = createRoom(c);
      rooms.set(c, room);
    } else {
      const c = String(code || '').trim().toUpperCase();
      room = rooms.get(c);
      if (!room) {
        return socket.emit('join:rejected', { reason: `Комната «${c || '????'}» не найдена. Проверьте код — или создайте свою игру.` });
      }
      clearTimeout(room.emptyTimer); // комнату «уносили на помойку» — отменяем
    }
    // Позывной в «чёрном списке» (кик) — вход закрыт до возврата всех в лобби.
    if (room.bannedNames.has(clean)) {
      return socket.emit('join:rejected', { reason: `Позывной «${clean}» исключён из этой сессии. Вход откроется, когда все вернутся в лобби.` });
    }
    // Матч уже идёт: вход только для переподключения «сироты» (тот же позывной).
    if (room.phase === 'game' && room.game) {
      const orphan = room.game.players.find(p =>
        p.name === clean && !room.lobbyPlayers.some(lp => lp.id === p.id));
      if (!orphan) {
        return socket.emit('join:rejected', { reason: 'В этой комнате матч уже идёт. Вернуться можно только под своим прежним позывным.' });
      }
    }
    const usedColors = room.lobbyPlayers.map(p => p.color);
    const color = COLORS.find(c => !usedColors.includes(c)) || COLORS[room.lobbyPlayers.length % COLORS.length];
    room.lobbyPlayers.push({ id: socket.id, name: clean, color, ready: false, team: null, debug: false });
    socket.data.roomCode = room.code;
    socket.join(room.code);
    socket.emit('joined', { id: socket.id, phase: room.phase, code: room.code });
    broadcastLobby(room);
    socket.emit('music:state', { playlist: music.playlist, ...room.music });
    if (room.game) {
      // --- ПЕРЕПОДКЛЮЧЕНИЕ ---
      // Если игрок с таким позывным уже есть в матче, а его старое
      // соединение оборвалось (id нет среди подключённых) — это «сирота».
      // Возвращаем игроку его персонажа: переписываем старый id на новый
      // ВЕЗДЕ, где движок хранит id (игроки, очередь, статусы, объекты).
      const orphan = room.game.players.find(p =>
        p.name === clean && !room.lobbyPlayers.some(lp => lp.id === p.id));
      let migrated = false;
      if (orphan) {
        const oldId = orphan.id, newId = socket.id;
        orphan.id = newId;
        migrated = true;
        const order = room.game.order;
        for (let i = 0; i < order.length; i++) if (order[i] === oldId) order[i] = newId;
        for (const p of room.game.players) {
          const st = p.statuses || {};
          if (st.p2pTarget === oldId) st.p2pTarget = newId;
          if (st.thirdPartyIp === oldId) st.thirdPartyIp = newId;
        }
        // (p2pPending больше не существует: выбора цели подключённым нет,
        //  переписывать тут нечего. statuses.p2pTarget переписан выше.)
        for (const o of Object.values(room.game.map.objects)) {
          if (o.ownerId === oldId) o.ownerId = newId;
        }
        for (const c of Object.values(room.game.copies || {})) {
          if (c.ownerId === oldId) c.ownerId = newId;
        }
        io.to(room.code).emit('chat:message', { from: 'СЕРВЕР', color: '#888888', text: `⟳ ${clean} переподключился к матчу.`, at: Date.now() });
        broadcastGame(room, []); // всем разослать состояние с новым id
      }
      // Новичок в фазе подготовки: создаём ему игрока и (если все уже на шаге
      // расстановки) возвращаем всех на шаг сборки — он успеет собрать руку.
      if (room.phase === 'setup' && !migrated) {
        const p = engine.createPlayer(socket.id, clean, color);
        p.hp = room.settings.startHP;
        p.basePower = room.settings.startPower;
        // В командном режиме садим новичка в самую малочисленную команду.
        if (room.settings.teamsEnabled) {
          const counts = [0, 1, 2, 3].map(t => room.game.players.filter(pl => pl.team === t).length);
          p.team = counts.indexOf(Math.min(...counts));
          const lp = room.lobbyPlayers.find(pl => pl.id === socket.id);
          if (lp) lp.team = p.team;
        }
        room.game.players.push(p);
        room.game.order.push(p.id);
        if (room.game.setupStage === 'deploy') room.game.setupStage = 'build';
        broadcastGame(room, []);
      }
      socket.emit('state', engine.serialize(room.game, socket.id));
      if (room.phase === 'game' && !room.game.over) sendTurnInfo(room);
    }
  });

  // --- настройки (общее согласие: любое изменение сбрасывает готовность) ---
  socket.on('settings:update', (s) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'lobby') return;
    room.settings = sanitizeSettings(s);
    for (const lp of room.lobbyPlayers) lp.ready = false;
    broadcastLobby(room);
  });

  socket.on('player:color', ({ color } = {}) => {
    const room = roomOf(socket); if (!room) return;
    const lp = room.lobbyPlayers.find(p => p.id === socket.id);
    if (!lp || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
    if (room.lobbyPlayers.some(p => p.id !== socket.id && p.color === color)) return; // цвета не повторяются
    lp.color = color;
    const gp = room.game && engine.getPlayer(room.game, socket.id);
    if (gp) gp.color = color;
    broadcastLobby(room);
    if (room.game) broadcastGame(room, []);
  });

  // --- выбор команды (командный режим включается в настройках) ---
  socket.on('player:team', ({ team } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'lobby') return;
    const lp = room.lobbyPlayers.find(p => p.id === socket.id);
    if (!lp) return;
    const t = team === null || team === undefined ? null : parseInt(team, 10);
    lp.team = (t === null || (t >= 0 && t <= 3)) ? t : lp.team;
    lp.ready = false; // сменил команду — подтверди готовность заново
    broadcastLobby(room);
  });

  socket.on('player:ready', ({ ready } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'lobby') return;
    const lp = room.lobbyPlayers.find(p => p.id === socket.id);
    if (!lp) return;
    lp.ready = !!ready;
    broadcastLobby(room);
    // В отладочном режиме можно играть в одиночку.
    const minPlayers = anyDebug(room) ? 1 : 2;
    if (room.lobbyPlayers.length >= minPlayers && room.lobbyPlayers.every(p => p.ready)) {
      if (!teamsValid(room)) {
        // Командный режим без двух команд — не стартуем, сбрасываем готовность.
        for (const p of room.lobbyPlayers) p.ready = false;
        broadcastLobby(room);
        io.to(room.code).emit('game:error', { msg: 'Командный режим: каждому нужна команда, и команд должно быть минимум ДВЕ.' });
        return;
      }
      enterSetup(room);
    }
  });

  // --- секретный режим отладки ---
  socket.on('debug:enable', () => {
    const room = roomOf(socket); if (!room) return;
    const lp = room.lobbyPlayers.find(p => p.id === socket.id);
    if (!lp) return;
    lp.debug = true;
    const gp = room.game && engine.getPlayer(room.game, socket.id);
    if (gp) gp.debug = true;
    socket.emit('debug:enabled', { ok: true });
    broadcastLobby(room);
    if (room.game) broadcastGame(room, []);
  });

  // --- чат ---
  socket.on('chat:send', ({ text } = {}) => {
    const room = roomOf(socket); if (!room) return;
    const lp = room.lobbyPlayers.find(p => p.id === socket.id);
    const clean = String(text || '').slice(0, 300);
    if (!lp || !clean.trim()) return;
    // Команда хоста: «/kick позывной» — исключить игрока из сессии.
    // Регистр не важен, позывной может содержать пробелы.
    const cmd = clean.trim().match(/^\/kick\s+(.+)$/i);
    if (cmd) {
      if (!isHost(room, socket.id)) {
        return socket.emit('game:error', { msg: 'Команда /kick доступна только хосту (админу).' });
      }
      const r = kickPlayer(room, socket, cmd[1]);
      if (r.error) socket.emit('game:error', { msg: r.error });
      return; // сама команда в общий чат не уходит
    }
    io.to(room.code).emit('chat:message', { from: lp.name, color: lp.color, text: clean, at: Date.now() });
  });

  // --- кик кнопкой (✕ в списках игроков, только у хоста) ---
  socket.on('player:kick', ({ name } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (!isHost(room, socket.id)) return socket.emit('game:error', { msg: 'Кикать может только хост (админ).' });
    const r = kickPlayer(room, socket, name);
    if (r.error) socket.emit('game:error', { msg: r.error });
  });

  // ============================ ФАЗА ПОДГОТОВКИ ============================
  socket.on('setup:submit', ({ interfaceId, programs } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup') return;
    const p = engine.getPlayer(room.game, socket.id);
    if (!p) return;
    if (!INTERFACES.some(i => i.id === interfaceId)) return socket.emit('game:error', { msg: 'Выберите интерфейс.' });
    const lp = room.lobbyPlayers.find(pl => pl.id === socket.id);
    const isDebug = !!(lp && lp.debug);
    if (!Array.isArray(programs)) return socket.emit('game:error', { msg: 'Некорректная рука.' });
    // В отладке разрешена любая рука (вплоть до всех программ сразу).
    if (isDebug ? (programs.length < 1 || programs.length > PROGRAMS.length)
                : programs.length !== room.settings.maxPrograms) {
      return socket.emit('game:error', { msg: `Нужно выбрать ровно ${room.settings.maxPrograms} программ.` });
    }
    if (!programs.every(id => PROGRAM_MAP[id] && !PROGRAM_MAP[id].hidden)) {
      return socket.emit('game:error', { msg: 'Неизвестная программа.' });
    }
    if (new Set(programs).size !== programs.length) {
      return socket.emit('game:error', { msg: 'Дубликаты программ запрещены.' });
    }

    p.interfaceId = interfaceId;
    p.hand = programs.map((progId, i) => ({
      uid: `${socket.id.slice(0, 4)}_${i}_${progId}`,
      progId,
      broken: false,
      consumption: PROGRAM_MAP[progId].consumption,
    }));

    // Кустарный интерфейс больше НЕ ломает программы при сборке: его
    // особенность — переворот одного бита слота раз в ход (game:flipBit).
    // Сломанные программы теперь делает «Разлом данных» на карте (game:riftUse).
    // Карта хостом уже готова и все собрали руки — переходим к расстановке.
    if (room.game.mapDone && allSubmitted(room)) room.game.setupStage = 'deploy';
    broadcastGame(room, []);
    socket.emit('setup:accepted', { ok: true });
  });

  // Обмен местами в очереди — по обоюдному согласию.
  socket.on('setup:swapRequest', ({ targetId }) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup') return;
    const target = io.sockets.sockets.get(targetId);
    const me = room.lobbyPlayers.find(p => p.id === socket.id);
    if (target && me) target.emit('setup:swapOffer', { fromId: socket.id, fromName: me.name });
  });

  socket.on('setup:swapAnswer', ({ fromId, accept }) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup' || !accept) return;
    const g = room.game;
    const i = g.order.indexOf(socket.id), j = g.order.indexOf(fromId);
    if (i < 0 || j < 0) return;
    [g.order[i], g.order[j]] = [g.order[j], g.order[i]];
    broadcastGame(room, []);
  });

  // ===================== РЕДАКТОР КАРТЫ (только хост) =====================
  const OBJ_DEFAULTS = {
    wall:    { name: 'Битый пиксель',   color: '#ff2244' },
    zone:    { name: 'Зона',            color: '#00ff66' },
    mine:    { name: 'Мина',            color: '#ff8800' },
    portal:  { name: 'Телепорт',        color: '#b388ff' },
    portal2: { name: 'Парный телепорт', color: '#ff6e40' },
    point:   { name: 'Точка контроля',  color: '#00e5ff' },
    rift:    { name: 'Разлом данных',   color: '#ff2fd6' },
    spawn:   { name: 'Пиксель спауна',  color: '#e8ffe8' },
  };

  function sanitizeObject(obj) {
    obj = obj || {};
    const type = OBJ_DEFAULTS[obj.type] ? obj.type : 'wall';
    const effectKinds = ['none', 'heal', 'damage', 'power', 'teleport'];
    const amount = Math.min(20, Math.max(0, parseInt(obj.effect && obj.effect.amount, 10) || (type === 'mine' ? 5 : 0)));
    return {
      type,
      name: String(obj.name || OBJ_DEFAULTS[type].name).slice(0, 24),
      color: /^#[0-9a-fA-F]{6}$/.test(obj.color) ? obj.color : OBJ_DEFAULTS[type].color,
      walkable: type === 'wall' ? false : (type === 'zone' ? !!obj.walkable : true),
      // Радиус телепортации обычного портала (0 = вся карта, как раньше).
      radius: type === 'portal' ? Math.min(99, Math.max(0, parseInt(obj.radius, 10) || 0)) : 0,
      // Номер пары парного портала: портал №N связан только с порталом №N.
      pair: type === 'portal2' ? Math.min(99, Math.max(1, parseInt(obj.pair, 10) || 1)) : 0,
      // Принадлежность точки контроля команде: null — нейтральная (для всех),
      // 0..3 — захватывать её может только команда А/Б/В/Г (командный режим).
      team: type === 'point'
        ? (obj.team === null || obj.team === undefined || obj.team === '' ? null
          : Math.min(3, Math.max(0, parseInt(obj.team, 10) || 0)))
        : null,
      effect: {
        kind: type === 'zone' ? (effectKinds.includes(obj.effect && obj.effect.kind) ? obj.effect.kind : 'none')
            : type === 'mine' ? 'damage' : 'none',
        amount,
      },
      roundsLeft: Math.min(99, Math.max(0, parseInt(obj.roundsLeft, 10) || 0)), // 0 = постоянный
      temp: false, ownerId: null,
    };
  }

  // Снимок карты перед изменением — для кнопки «отмена» у хоста.
  function pushMapHistory(room) {
    room.mapHistory.push(JSON.stringify(room.game.map.objects));
    if (room.mapHistory.length > 50) room.mapHistory.shift();
  }

  socket.on('map:setObject', ({ x, y, obj }) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup' || !isHost(room, socket.id)) return;
    const g = room.game;
    if (!engine.inBounds(g, x, y) || engine.playerAt(g, x, y)) return;
    pushMapHistory(room);
    g.map.objects[engine.key(x, y)] = sanitizeObject(obj);
    broadcastGame(room, []);
  });

  socket.on('map:removeObject', ({ x, y }) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup' || !isHost(room, socket.id)) return;
    pushMapHistory(room);
    delete room.game.map.objects[engine.key(x, y)];
    broadcastGame(room, []);
  });

  // Пакетная покраска клеток: drag-paint, зеркальная установка, ластик (obj=null),
  // рамка из стен. Серия быстрых событий (рисование с зажатой ЛКМ) — одна отмена.
  socket.on('map:paintCells', ({ cells, obj } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup' || !isHost(room, socket.id)) return;
    const g = room.game;
    if (!Array.isArray(cells) || !cells.length) return;
    const now = Date.now();
    if (now - (room.lastPaintAt || 0) > 700) pushMapHistory(room);
    room.lastPaintAt = now;
    for (const c of cells.slice(0, 2000)) {
      const x = c && c.x | 0, y = c && c.y | 0;
      if (!engine.inBounds(g, x, y) || engine.playerAt(g, x, y)) continue;
      if (obj) {
        const clean = sanitizeObject(obj);
        clean.effect = { ...clean.effect }; // у каждой клетки — своя копия
        g.map.objects[engine.key(x, y)] = clean;
      } else {
        delete g.map.objects[engine.key(x, y)];
      }
    }
    broadcastGame(room, []);
  });

  // Заливка прямоугольника выбранным объектом.
  socket.on('map:fillRect', ({ x1, y1, x2, y2, obj }) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup' || !isHost(room, socket.id)) return;
    const g = room.game;
    pushMapHistory(room);
    const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)];
    const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)];
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
      if (!engine.inBounds(g, x, y) || engine.playerAt(g, x, y)) continue;
      const clean = sanitizeObject(obj);
      clean.effect = { ...clean.effect }; // у каждой клетки — своя копия
      g.map.objects[engine.key(x, y)] = clean;
    }
    broadcastGame(room, []);
  });

  socket.on('map:clear', () => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup' || !isHost(room, socket.id)) return;
    pushMapHistory(room);
    room.game.map.objects = {};
    broadcastGame(room, []);
  });

  // Отмена последнего изменения карты.
  socket.on('map:undo', () => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup' || !isHost(room, socket.id)) return;
    const prev = room.mapHistory.pop();
    if (prev === undefined) return socket.emit('game:error', { msg: 'Отменять нечего.' });
    room.game.map.objects = JSON.parse(prev);
    broadcastGame(room, []);
  });

  // Готовые пресеты карты.
  socket.on('map:preset', ({ name, density } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup' || !isHost(room, socket.id)) return;
    const g = room.game;
    const { w, h } = g.map;
    pushMapHistory(room);
    const put = (x, y, obj) => {
      if (engine.inBounds(g, x, y) && !engine.playerAt(g, x, y)) g.map.objects[engine.key(x, y)] = sanitizeObject(obj);
    };
    const dens = Math.min(40, Math.max(5, parseInt(density, 10) || 15)) / 100;
    const rnd = (n) => Math.floor(Math.random() * n);
    g.map.objects = {};
    if (name === 'scatter') {
      // Случайные битые пиксели + пара мин и телепортов.
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (Math.random() < dens) put(x, y, { type: 'wall' });
      }
      for (let i = 0; i < Math.max(1, Math.round(w * h * 0.01)); i++) put(rnd(w), rnd(h), { type: 'mine' });
      for (let i = 0; i < 2; i++) put(rnd(w), rnd(h), { type: 'portal' });
    } else if (name === 'arena') {
      // Стены по периметру с четырьмя проходами.
      for (let x = 0; x < w; x++) { put(x, 0, { type: 'wall' }); put(x, h - 1, { type: 'wall' }); }
      for (let y = 0; y < h; y++) { put(0, y, { type: 'wall' }); put(w - 1, y, { type: 'wall' }); }
      const gaps = [[Math.floor(w / 2), 0], [Math.floor(w / 2), h - 1], [0, Math.floor(h / 2)], [w - 1, Math.floor(h / 2)]];
      for (const [gx, gy] of gaps) { delete g.map.objects[engine.key(gx, gy)]; delete g.map.objects[engine.key(gx, Math.max(0, gy - 1))]; }
      for (let i = 0; i < Math.round(w * h * dens * 0.3); i++) put(rnd(w), rnd(h), { type: 'wall' });
    } else if (name === 'maze') {
      // Колонны через одну со случайными проходами — «лабиринт».
      for (let x = 1; x < w - 1; x += 2) {
        const gap1 = rnd(h), gap2 = rnd(h);
        for (let y = 0; y < h; y++) {
          if (y === gap1 || y === gap2 || Math.random() < 0.12) continue;
          put(x, y, { type: 'wall' });
        }
      }
      for (let i = 0; i < 2; i++) put(rnd(w), rnd(h), { type: 'portal' });
    } else if (name === 'islands') {
      // «Острова»: несколько компактных блоков стен, зоны и мины между ними.
      const blobs = 3 + rnd(3);
      for (let i = 0; i < blobs; i++) {
        const cx = 2 + rnd(w - 5), cy = 2 + rnd(h - 5), bw = 2 + rnd(2), bh = 1 + rnd(2);
        for (let y = cy; y < cy + bh; y++) for (let x = cx; x < cx + bw; x++) put(x, y, { type: 'wall' });
      }
      for (let i = 0; i < Math.max(2, Math.round(w * h * 0.02)); i++) put(rnd(w), rnd(h), { type: 'mine' });
      for (let i = 0; i < 2; i++) put(rnd(w), rnd(h), { type: 'zone', walkable: true, effect: { kind: 'heal', amount: 3 } });
      for (let i = 0; i < 2; i++) put(rnd(w), rnd(h), { type: 'zone', walkable: true, effect: { kind: 'power', amount: 2 } });
    } else {
      return socket.emit('game:error', { msg: 'Неизвестный пресет.' });
    }
    broadcastGame(room, []);
  });

  // Импорт шаблона карты (сохранённого ранее в браузере хоста).
  socket.on('map:import', ({ objects } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup' || !isHost(room, socket.id)) return;
    if (!objects || typeof objects !== 'object') return;
    pushMapHistory(room);
    const g = room.game;
    g.map.objects = {};
    let count = 0;
    for (const k of Object.keys(objects)) {
      if (count >= 400) break;
      const [x, y] = k.split(',').map(Number);
      if (!engine.inBounds(g, x, y) || engine.playerAt(g, x, y)) continue;
      g.map.objects[engine.key(x, y)] = sanitizeObject(objects[k]);
      count++;
    }
    broadcastGame(room, []);
  });

  // Хост закончил настройку карты -> игроки собирают руки (карта — ДО программ).
  socket.on('setup:mapDone', () => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup' || !isHost(room, socket.id)) return;
    // Режим захвата: без точек контроля играть не во что.
    if (room.settings.mode === 'capture') {
      const points = Object.values(room.game.map.objects).filter(o => o.type === 'point');
      if (!points.length) {
        return socket.emit('game:error', { msg: 'Режим «Захват территории»: поставьте на карту хотя бы одну ТОЧКУ КОНТРОЛЯ.' });
      }
      // Командный режим: у каждой участвующей команды должна быть ХОТЯ БЫ ОДНА
      // доступная точка (собственная или нейтральная) — иначе она не сможет
      // набирать очки в принципе.
      if (room.settings.teamsEnabled) {
        const TEAM_NAMES = ['А', 'Б', 'В', 'Г'];
        const teams = [...new Set(room.game.players.map(p => p.team).filter(t => t != null))];
        for (const t of teams) {
          const capturable = points.some(o => o.team == null || o.team === t);
          if (!capturable) {
            return socket.emit('game:error', { msg: `Команда ${TEAM_NAMES[t]} не сможет набирать очки: на карте нет её точки контроля (или нейтральной). Поставьте точку для команды ${TEAM_NAMES[t]}.` });
          }
        }
      }
    }
    // Парные телепорты: каждый номер пары обязан быть ровно в двух экземплярах —
    // иначе непонятно, куда переносить вступившего.
    const pairCount = {};
    for (const o of Object.values(room.game.map.objects)) {
      if (o.type === 'portal2') pairCount[o.pair || 1] = (pairCount[o.pair || 1] || 0) + 1;
    }
    for (const [pair, count] of Object.entries(pairCount)) {
      if (count !== 2) {
        return socket.emit('game:error', { msg: `Парный телепорт №${pair}: на карте ${count} шт., а нужно ровно 2. Добавьте или удалите лишние.` });
      }
    }
    // Пиксели спауна: необязательны, но если хост их поставил — каждому
    // игроку нужна своя клетка спауна (на одну клетку встаёт один игрок).
    const spawnCount = engine.spawnCells(room.game).length;
    if (spawnCount > 0 && spawnCount < room.game.players.length) {
      return socket.emit('game:error', { msg: `Пикселей спауна ${spawnCount}, а игроков ${room.game.players.length}. Добавьте спауны или уберите их совсем (тогда расстановка свободная).` });
    }
    room.game.mapDone = true;
    // Если к этому моменту все уже собрали руки — сразу к расстановке.
    if (allSubmitted(room)) room.game.setupStage = 'deploy';
    broadcastGame(room, []);
  });

  // Расстановка персонажа. Когда все на карте — матч начинается сам.
  socket.on('setup:place', ({ x, y } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'setup') return;
    const g = room.game;
    const p = engine.getPlayer(g, socket.id);
    if (!p || !engine.isFree(g, x, y)) return;
    // Если на карте есть пиксели спауна — ставиться можно только на них.
    const spawns = engine.spawnCells(g);
    if (spawns.length) {
      const onSpawn = spawns.some(s => s.x === x && s.y === y);
      if (!onSpawn) return socket.emit('game:error', { msg: 'На этой карте расстановка только по пикселям спауна (белые ⦿).' });
    }
    p.pos = { x, y };
    p.setupReady = true;
    broadcastGame(room, []);
    if (g.setupStage === 'deploy' && allSubmitted(room) && g.players.every(pl => pl.pos)) startMatch(room);
  });

  // ============================ ИГРОВАЯ ФАЗА ============================
  socket.on('game:useProgram', (payload) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'game') return;
    const res = engine.useProgram(room.game, socket.id, payload || {});
    if (!res.ok) {
      // Ошибка с fx (например, ревнивый ИИ при повторной AI-защите) —
      // fx всё равно рассылаем, чтобы чат увидел реплику.
      if (res.fx && res.fx.length) io.to(room.code).emit('fx', res.fx);
      return socket.emit('game:error', { msg: res.error });
    }
    broadcastGame(room, res.fx);
    if (room.game.over) clearTimeout(room.turnTimer);
    else autoPassIfNoPower(room); // программа могла обнулить мощность самого ходящего
  });

  // Подключённый по peer-to-peer игрок выбрал цель за активного.
  // (Обработчик game:p2pResolve удалён: цель через peer-to-peer теперь
  //  выбирает владелец карты обычным game:useProgram — дальность и эффекты
  //  считаются от подключённого игрока.)

  socket.on('game:endTurn', () => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'game') return;
    const { ok, fx } = engine.endTurn(room.game, socket.id);
    if (ok) afterTurnChange(room, fx);
  });

  socket.on('game:overheat', () => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'game') return;
    const res = engine.toggleOverheat(room.game, socket.id);
    if (!res.ok) return socket.emit('game:error', { msg: res.error });
    broadcastGame(room, res.fx);
  });

  // Кустарный интерфейс: переворот одного открытого бита слота раз в ход
  // (цена — 1 ХП). Перевёрнутый слот глитчит до конца хода.
  socket.on('game:flipBit', ({ index } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'game') return;
    const res = engine.flipSlotBit(room.game, socket.id, index | 0);
    if (!res.ok) return socket.emit('game:error', { msg: res.error });
    broadcastGame(room, res.fx);
    if (room.game.over) clearTimeout(room.turnTimer);
  });

  // Разлом данных: стоящий на нём игрок кладёт программу из руки в разлом —
  // она становится сломанной (минус выбранный бит потребления). Раз в игру
  // на игрока для каждого конкретного разлома.
  socket.on('game:riftUse', (payload = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'game') return;
    const res = engine.useRift(room.game, socket.id, payload);
    if (!res.ok) return socket.emit('game:error', { msg: res.error });
    broadcastGame(room, res.fx);
  });

  // Матричный интерфейс: ставка программой — перегенерация слотов.
  socket.on('game:bet', ({ uid } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'game') return;
    const res = engine.matrixBet(room.game, socket.id, uid);
    if (!res.ok) return socket.emit('game:error', { msg: res.error });
    if (res.crash && !room.game.over) {
      // Критический провал: питание в нуле — ход сгорает немедленно.
      // ВАЖНО: сначала завершаем ход и только потом рассылаем fx ОДНИМ
      // пакетом — иначе состояние «ещё мой ход», ушедшее вместе со ставкой,
      // мгновенно закроет на клиенте экран перезагрузки (render скрывает её
      // в свой ход).
      const cur = engine.currentPlayer(room.game);
      if (cur && cur.id === socket.id) {
        const { fx } = engine.endTurn(room.game, socket.id);
        afterTurnChange(room, res.fx.concat(fx));
      } else {
        broadcastGame(room, res.fx);
      }
      return;
    }
    broadcastGame(room, res.fx);
    if (room.game.over) clearTimeout(room.turnTimer);
  });

  // Сканер сети: перехват программы из окна сканирования.
  socket.on('game:scanSteal', ({ targetId, uid } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'game') return;
    const res = engine.scanSteal(room.game, socket.id, targetId, uid);
    if (!res.ok) return socket.emit('game:error', { msg: res.error });
    broadcastGame(room, res.fx);
    if (room.game.over) clearTimeout(room.turnTimer);
  });

  // Красный пиксель съеден: провалиться в змейку случайного соседа по комнате.
  // PvP возможно ТОЛЬКО с теми, у кого сейчас запущена змейка (snakePlaying),
  // и НИКОГДА с игроком, чей ход идёт прямо сейчас, — его партию не сбиваем.
  socket.on('snake:pvp', () => {
    const room = roomOf(socket); if (!room) return;
    if (!room.snakePlaying.has(socket.id)) return; // сам едок — только из открытой змейки
    if (snakeSessions.has(socket.id)) return; // уже в PvP
    const curId = room.phase === 'game' && room.game && !room.game.over
      ? room.game.order[room.game.turnIndex] : null;
    const others = room.lobbyPlayers.filter(lp =>
      lp.id !== socket.id && !snakeSessions.has(lp.id) &&
      room.snakePlaying.has(lp.id) && lp.id !== curId);
    if (!others.length) return socket.emit('snake:pvpFail', { reason: 'Сейчас никто не играет в змейку — красный пиксель рассеялся.' });
    const target = others[Math.floor(Math.random() * others.length)];
    const meLp = room.lobbyPlayers.find(lp => lp.id === socket.id);
    const A = socket.id, B = target.id;
    const sess = {
      roomCode: room.code,
      players: [A, B],
      names: { [A]: meLp ? meLp.name : '???', [B]: target.name },
      colors: { [A]: meLp ? meLp.color : '#00ff9c', [B]: target.color },
      snakes: {
        [A]: [{ x: 4, y: 12 }, { x: 3, y: 12 }, { x: 2, y: 12 }],
        [B]: [{ x: 11, y: 3 }, { x: 12, y: 3 }, { x: 13, y: 3 }],
      },
      dirs: { [A]: { x: 1, y: 0 }, [B]: { x: -1, y: 0 } },
      queues: { [A]: [], [B]: [] },
      alive: { [A]: true, [B]: true },
      scores: { [A]: 0, [B]: 0 },
      food: null, timer: null,
    };
    sess.food = snakeFood(sess);
    snakeSessions.set(A, sess); snakeSessions.set(B, sess);
    for (const id of sess.players) {
      const sock = io.sockets.sockets.get(id);
      if (sock) sock.emit('snake:pvpStart', snakeSnapshot(sess));
    }
    sess.timer = setInterval(() => snakeTick(sess), SNAKE_TICK);
  });

  // Окно змейки открыто/закрыто — так сервер знает, кого можно дёргать в PvP.
  socket.on('snake:playing', () => { const room = roomOf(socket); if (room) room.snakePlaying.add(socket.id); });
  socket.on('snake:idle', () => { const room = roomOf(socket); if (room) room.snakePlaying.delete(socket.id); });

  // Поворот в PvP-змейке (та же очередь, что и в одиночной).
  socket.on('snake:dir', (d = {}) => {
    const sess = snakeSessions.get(socket.id);
    if (!sess || !sess.alive[socket.id]) return;
    const nd = { x: Math.sign(d.x | 0), y: Math.sign(d.y | 0) };
    if (!nd.x && !nd.y) return;
    if (nd.x && nd.y) return; // только одна ось
    const q = sess.queues[socket.id];
    const last = q.length ? q[q.length - 1] : sess.dirs[socket.id];
    if (nd.x === -last.x && nd.y === -last.y) return; // разворот на 180° запрещён
    if (q.length < 3) q.push(nd);
  });

  // Закрыл окно — змейка погибает (второму засчитывается победа).
  socket.on('snake:leave', () => {
    const sess = snakeSessions.get(socket.id);
    if (!sess) return;
    sess.alive[socket.id] = false;
    const otherAlive = sess.players.some(id => sess.alive[id]);
    snakeEnd(sess, otherAlive ? 'crash' : 'draw');
  });

  socket.on('game:pauseTimer', () => {
    const room = roomOf(socket); if (!room) return;
    toggleTimerPause(room);
  });

  // ============================ ОТЛАДКА ============================
  const debugAllowed = (room, id) => {
    const lp = room.lobbyPlayers.find(p => p.id === id);
    return !!(lp && lp.debug) && room.phase === 'game' && room.game && !room.game.over;
  };

  // Управление своими ХП и мощностью.
  socket.on('debug:set', ({ hp, power } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (!debugAllowed(room, socket.id)) return;
    const p = engine.getPlayer(room.game, socket.id);
    if (!p) return;
    if (hp !== undefined) {
      p.hp = Math.min(99, Math.max(1, parseInt(hp, 10) || 1));
      if (!p.alive) p.alive = true; // отладочное воскрешение
    }
    if (power !== undefined) {
      p.basePower = Math.min(20, Math.max(0, parseInt(power, 10) || 0));
      p.powerDelta = 0;
    }
    broadcastGame(room, []);
    autoPassIfNoPower(room); // мощность опустили в ноль — ход сразу пропускается
  });

  // Управление слотами: перегенерация / переворот бита.
  socket.on('debug:slots', ({ action, index } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (!debugAllowed(room, socket.id)) return;
    const g = room.game;
    const cur = engine.currentPlayer(g);
    if (!cur) return;
    if (action === 'reroll') {
      const n = Math.max(1, engine.powerOf(cur));
      g.slots = Array.from({ length: n }, () => ({ value: Math.random() < 0.5 ? 0 : 1, closed: false }));
    } else if (action === 'flip' && g.slots && g.slots[index] && !g.slots[index].closed) {
      g.slots[index].value = g.slots[index].value ? 0 : 1;
    }
    broadcastGame(room, []);
  });

  // Принудительное завершение текущего хода (любого игрока).
  socket.on('debug:endTurn', () => {
    const room = roomOf(socket); if (!room) return;
    if (!debugAllowed(room, socket.id)) return;
    const cur = engine.currentPlayer(room.game);
    if (!cur) return;
    const r = engine.endTurn(room.game, cur.id);
    afterTurnChange(room, r.fx);
  });

  // ============================ МУЗЫКА ============================
  socket.on('music:control', ({ action, index } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (!music.playlist.length) return;
    const rm = room.music; // плеер комнаты
    if (action === 'play') {
      if (!rm.playing) { rm.playing = true; rm.startedAt = Date.now() - (rm.pausedAt || 0); }
    } else if (action === 'pause') {
      if (rm.playing) { rm.playing = false; rm.pausedAt = Date.now() - rm.startedAt; }
    } else if (action === 'next') {
      rm.index = (rm.index + 1) % music.playlist.length;
      rm.playing = true; rm.startedAt = Date.now(); rm.pausedAt = 0;
    } else if (action === 'prev') {
      rm.playing = true; rm.startedAt = Date.now(); rm.pausedAt = 0; // перемотка в начало
    } else if (action === 'select' && Number.isInteger(index) && music.playlist[index]) {
      rm.index = index; rm.playing = true; rm.startedAt = Date.now(); rm.pausedAt = 0;
    }
    broadcastMusic(room);
  });

  // Удаление трека из плейлиста (кнопка ✕ у трека, доступна всем).
  socket.on('music:remove', ({ index } = {}) => {
    if (!Number.isInteger(index) || !music.playlist[index]) return;
    const file = music.playlist[index];
    // Файл удаляем только из каталога музыки (никаких путей от клиента —
    // берём имя строго из нашего же плейлиста).
    try { fs.unlinkSync(path.join(MUSIC_DIR, file)); } catch (e) { /* уже нет — не страшно */ }
    music.playlist = listAudio(MUSIC_DIR);
    // Плейлист общий — сдвигаем индексы плееров ВСЕХ комнат.
    for (const room of rooms.values()) {
      const rm = room.music;
      if (!music.playlist.length) {
        rm.index = 0; rm.playing = false; rm.pausedAt = 0;
      } else if (index < rm.index) {
        rm.index--; // удалённый трек был перед текущим — индекс сдвигается
      } else if (index === rm.index) {
        rm.index = rm.index % music.playlist.length; // играл удалённый — следующий
        rm.startedAt = Date.now(); rm.pausedAt = 0;
      }
      broadcastMusic(room);
    }
  });

  // ============================ ПРОЧЕЕ ============================
  socket.on('lobby:reset', () => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase === 'game' && room.game && room.game.over) backToLobby(room);
  });

  // Хост пересоздаёт игру: вся комната сразу уходит в новую подготовку,
  // минуя круг нажатий «ГОТОВ» (все уже в комнате).
  socket.on('lobby:recreate', () => {
    const room = roomOf(socket); if (!room) return;
    if (room.phase !== 'lobby') return;
    if (!isHost(room, socket.id)) return socket.emit('game:error', { msg: 'Пересоздать игру может только хост.' });
    if (room.lobbyPlayers.length < (anyDebug(room) ? 1 : 2)) {
      return socket.emit('game:error', { msg: 'Для пересоздания нужно минимум 2 игрока.' });
    }
    if (!teamsValid(room)) {
      return socket.emit('game:error', { msg: 'Командный режим: у всех должна быть команда, и команд — минимум две.' });
    }
    room.bannedNames.clear(); // новый матч — «чёрный список» киков обнуляется
    enterSetup(room);
  });

  socket.on('disconnect', () => {
    // PvP-змейка: отключившийся погибает, второму — победа.
    const sess = snakeSessions.get(socket.id);
    if (sess) {
      sess.alive[socket.id] = false;
      const otherAlive = sess.players.some(id => sess.alive[id]);
      snakeEnd(sess, otherAlive ? 'crash' : 'draw');
    }
    const room = roomOf(socket);
    if (!room) return; // сокет так и не вошёл ни в одну комнату
    room.snakePlaying.delete(socket.id); // больше не цель для PvP-змейки
    const idx = room.lobbyPlayers.findIndex(p => p.id === socket.id);
    if (idx >= 0) room.lobbyPlayers.splice(idx, 1);
    if (room.phase === 'lobby') {
      broadcastLobby(room);
    } else if (room.phase === 'setup' && room.game) {
      // В фазе подготовки удаляем вышедшего, чтобы не блокировать старт.
      const g = room.game;
      g.players = g.players.filter(p => p.id !== socket.id);
      g.order = g.order.filter(id => id !== socket.id);
      const minPlayers = anyDebug(room) ? 1 : 2;
      if (g.players.length < minPlayers) { backToLobby(room); }
      else {
        broadcastGame(room, []);
        // Если остальные уже на карте — стартуем без вышедшего.
        if (g.setupStage === 'deploy' && allSubmitted(room) && g.players.every(pl => pl.pos)) startMatch(room);
      }
    } else if (room.game) {
      // В матче игрок остаётся (его ход завершит таймер). Вышли ВСЕ — матч не
      // стираем: вдруг все разом переподключатся (сеть локальной сети моргнула).
      if (room.lobbyPlayers.length > 0) broadcastGame(room, []);
    }
    // Комната опустела — отложенное удаление: 10 минут на возвращение
    // (телефон уснул, F5, сеть моргнула). Вход отменяет таймер.
    if (!room.lobbyPlayers.length) scheduleRoomCleanup(room);
  });
});

// Понятное сообщение, если порт уже занят (запущена вторая копия сервера).
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  Порт ${PORT} уже занят — похоже, сервер УЖЕ запущен в другом окне.`);
    console.error('  Закройте старое окно сервера или запустите на другом порту:');
    console.error('    Windows:  set PORT=8080 && npm start');
    console.error('    Linux:    PORT=8080 npm start');
    console.error('');
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log('=================================================');
  console.log('  ШИФРОПАНК запущен!');
  console.log(`  Локально:   http://localhost:${PORT}`);
  console.log(`  Для друзей: http://<ваш IP в Radmin>:${PORT}`);
  console.log('=================================================');
});
