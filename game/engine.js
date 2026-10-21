// ============================================================================
// ШИФРОПАНК — игровой движок (серверная логика матча).
// Все функции чистые от сети: принимают state, возвращают { ok, error, fx }.
// fx — массив событий для визуальных эффектов на клиентах.
//
// ОГЛАВЛЕНИЕ:
//   1. Создание состояния (createGame/createPlayer)
//   2. Карта: объекты, BFS, линия видимости, порталы
//   3. Слоты (проверка комбинации потребления)
//   4. Урон/лечение/смерть + проверка победы (в т.ч. командной)
//   5. Передвижение (мины, порталы, АИМбот)
//   6. Цифровые копии («Разделение сигнала»)
//   7. EFFECTS — эффекты всех программ
//   8. Валидация целей (validateTarget)
//   9. Розыгрыш программы (useProgram), включая peer-to-peer
//  10. Ходы: startTurn/endTurn, таймеры объектов, перегрев
//  11. Режим «Захват территории» (КодШифр, очки)
//  12. Сериализация состояния для клиента
// ============================================================================

const { PROGRAM_MAP } = require('./programs');

const key = (x, y) => `${x},${y}`;
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

// uid виртуальной карты «КодШифр» (её нет в руке — она живёт на точке контроля)
const CIPHER_UID = '__cipher__';

// Имена и реплики ИИ-ботов для «AI защиты» (выбираются случайно на сервере,
// чтобы у всех игроков сообщение в чате было одинаковым).
const AI_NAMES = ['Н.Е.М.Е.З.И.Д.А', 'ГЛАДОСЬ', 'VENOM-7', 'Патруль-9000', 'А.И.РИНА', 'СТРАЖ-α', 'К-9 «Мотив»'];
const AI_MOCKS = [
  'Попытка взлома отклонена. Записываю в дневник неудач.',
  'Ха. Ха. Ха. Это была атака? Я даже не проснулась.',
  'Доступ запрещён. Советую больше так не делать.',
  'Я посчитала твои шансы. Их нет.',
  'Сканирую входящий пакет… смешно. Удаляю.',
  'Твой эксплойт устарел на 14 лет. Поздравляю.',
];
const AI_JEALOUS = [
  'Ты уже вызывал ИИ в этом раунде. Я РЕВНУЮ. Отказано.',
  'Второй ИИ за раунд? Серьёзно? Нет.',
  'Один защитник на раунд. Работай с тем, что есть.',
  'Нет. Я не делю тебя с другими ИИ.',
];

// ---------------------------------------------------------------------------
// 1. Создание состояния
// ---------------------------------------------------------------------------
function createMap(w, h) {
  // objects: "x,y" -> { type: 'wall'|'zone'|'mine'|'portal'|'portal2'|'point'|
  //   'rift'|'spawn',
  //   color, walkable, effect: {kind, amount}, temp, ownerId, name,
  //   roundsLeft (0 = постоянный), radius (порталы),
  //   usedBy (разлом данных: id игроков, уже сломавших в нём программу) }
  // Цифровые копии («Разделение сигнала») живут ОТДЕЛЬНО от объектов — в
  // state.copies: копия — «аналог игрока», она СТОИТ НА клетке, а не заменяет
  // объект на ней (зона/портал под копией сохраняются).
  return { w, h, objects: {} };
}

function createPlayer(id, name, color) {
  return {
    id, name, color,
    interfaceId: null,          // 'corp' | 'mil' | 'home'
    team: null,                 // null | 0..3 (команды А/Б/В/Г) — задаётся в лобби
    hp: 0, basePower: 0, powerDelta: 0,
    alive: true,
    pos: null,                  // {x, y}
    hand: [],                   // [{ uid, progId, broken, consumption }]
    capturePoints: 0,           // очки в режиме «Захват территории»
    statuses: {
      firewall: 0, aiDefense: false, incognito: false, reverseFlow: false,
      torrent: 0,             // Торрент: стаки; чужой эффект проходит, но даёт +мощность (см. torrentTick)
      aimbot: false, thirdPartyIp: false, violence: false,
      backupPower: false, overheat: false,
      overheatBonus: 0,       // сколько слотов следующего хода будут ПЕРЕГРЕТЫМИ (перегрев бесконечен)
      tpiBlocked: false,        // получил бонус от чужого «Стороннего айпи» — свой заблокирован
      undervoltPenalty: 0,      // мощность, пожертвованная «Андервольтингом» — бьёт по СЛЕДУЮЩЕМУ ходу
      aiDefenseRound: 0,        // в каком раунде последний раз включали AI-защиту
      aiDefenseName: null,      // имя ИИ-бота, закреплённое на текущую активацию
      p2pTarget: null,          // id игрока, исполняющего мои карты (peer-to-peer)
      homeFlipUsed: false,      // кустарный интерфейс уже переворачивал бит в этом ходу
      // --- Матричный интерфейс (ставка): все эффекты живут один ход ---
      matrixBetDone: false,     // ставка в этом ходу уже сделана
      moveGhost: false,         // удача(2): первое движение проходит сквозь препятствия
      moveMinus: false,         // провал(5+): дальность карт движения −1
      dmgMinus: false,          // провал(5+): урон карт урона −1 (0 — карта заблокирована)
      corpOnceUid: null,        // удача(3): эта карта закрывает слоты как КОРП (раз)
      matrixDouble: false,      // удача(4): первая атакующая программа бьёт вдвойне
      matrixSplash: false,      // провал(4): свои атаки бьют и тебя (половина, округл. вверх)
    },
    setupReady: false,
  };
}

function createGame(settings) {
  return {
    settings,
    players: [],                // порядок входа = базовый порядок хода
    order: [],                  // playerId[]
    turnIndex: 0,
    round: 1,
    slots: null,                // [{ value: 0|1, closed: bool, ideal?: bool }]
    slotsUsed: false,           // слоты тронуты в этом ходу (ставка Матрицы — только ДО)
    pendingScan: null,          // { playerId, targetId } — открытое окно сканера (перехват карты)
    map: createMap(settings.mapW, settings.mapH),
    copies: {},                 // "x,y" -> { ownerId, hp, color, name } — цифровые копии
    over: false,
    winnerId: null,
    winnerTeam: null,           // номер команды-победителя (командный режим)
    cipherConsumption: null,    // потребление КодШифра в этом раунде (режим захвата)
    // Антивирус — анти-затягивание: просыпается на заданном раунде (0 = выключен)
    // и мешает ВСЕМ до конца матча. Тип 'random' выбирается в момент пробуждения.
    antivirus: {
      round: Number(settings.antivirusRound) > 0 ? Number(settings.antivirusRound) : 0,
      type: settings.antivirusType || 'random',
      active: false,
      resolved: null,           // фактический тип после пробуждения
    },
  };
}

const powerOf = (p) => Math.max(0, p.basePower + p.powerDelta);
const getPlayer = (state, id) => state.players.find(p => p.id === id);
const currentPlayer = (state) => getPlayer(state, state.order[state.turnIndex]);

// ---------------------------------------------------------------------------
// 2. Карта
// ---------------------------------------------------------------------------
function objectAt(state, x, y) { return state.map.objects[key(x, y)] || null; }
function playerAt(state, x, y) {
  return state.players.find(p => p.alive && p.pos && p.pos.x === x && p.pos.y === y) || null;
}
function inBounds(state, x, y) { return x >= 0 && y >= 0 && x < state.map.w && y < state.map.h; }

function copyAt(state, x, y) { return state.copies[key(x, y)] || null; }

function isFree(state, x, y) {
  if (!inBounds(state, x, y)) return false;
  const obj = objectAt(state, x, y);
  if (obj && !obj.walkable) return false;
  if (copyAt(state, x, y)) return false; // копия — как пешка: клетку занимает
  return !playerAt(state, x, y);
}

// Клетки с пикселями спауна. Если на карте есть хотя бы одна — в начале
// матча пешки ставятся ТОЛЬКО на них; если ни одной — расстановка свободная.
function spawnCells(state) {
  const out = [];
  for (const k of Object.keys(state.map.objects)) {
    if (state.map.objects[k].type !== 'spawn') continue;
    const [x, y] = k.split(',').map(Number);
    out.push({ x, y });
  }
  return out;
}

// BFS — клетки, достижимые за maxSteps шагов (4 направления: вверх/вниз/влево/вправо).
function bfsReachable(state, from, maxSteps) {
  const seen = new Set([key(from.x, from.y)]);
  const out = new Set();
  let frontier = [from];
  for (let step = 0; step < maxSteps; step++) {
    const next = [];
    for (const c of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = c.x + dx, ny = c.y + dy, k = key(nx, ny);
        if (seen.has(k) || !isFree(state, nx, ny)) continue;
        seen.add(k); out.add(k); next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
  }
  return out;
}

// Путь BFS от from до to (без стартовой клетки, конечная — включительно).
// ghost=true — «сквозное» движение Матрицы: сквозь объекты можно ПРОХОДИТЬ.
function bfsPath(state, from, to, ghost) {
  const startK = key(from.x, from.y), goalK = key(to.x, to.y);
  const prev = { [startK]: null };
  const passable = (x, y) => ghost
    ? (inBounds(state, x, y) && !playerAt(state, x, y) && !copyAt(state, x, y))
    : isFree(state, x, y);
  let frontier = [from];
  const maxSteps = state.map.w + state.map.h; // реальный путь заведомо короче
  for (let step = 0; step < maxSteps; step++) {
    const next = [];
    for (const c of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = c.x + dx, ny = c.y + dy, k = key(nx, ny);
        if (k in prev || !passable(nx, ny)) continue;
        prev[k] = key(c.x, c.y);
        if (k === goalK) {
          const path = [];
          let cur = k;
          while (cur !== startK) {
            const [px, py] = cur.split(',').map(Number);
            path.unshift({ x: px, y: py });
            cur = prev[cur];
          }
          return path;
        }
        next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
  }
  return null;
}

// Досягаемость «сквозного» движения (Матрица, удача ставки на 2 бита):
// сквозь битые пиксели можно ПРОХОДИТЬ, но встать — только на свободную клетку.
function ghostReachable(state, from, maxSteps) {
  const seen = new Set([key(from.x, from.y)]);
  const out = new Set();
  let frontier = [from];
  for (let step = 0; step < maxSteps; step++) {
    const next = [];
    for (const c of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = c.x + dx, ny = c.y + dy, k = key(nx, ny);
        if (seen.has(k) || !inBounds(state, nx, ny) || playerAt(state, nx, ny) || copyAt(state, nx, ny)) continue;
        seen.add(k);
        next.push({ x: nx, y: ny });
        if (isFree(state, nx, ny)) out.add(k); // встать — только на свободную
      }
    }
    frontier = next;
  }
  return out;
}

// Ближайшая свободная клетка к (x, y) — BFS-волна наружу. Сама (x, y) тоже проверяется.
function nearestFreeCell(state, x, y) {
  if (isFree(state, x, y)) return { x, y };
  const seen = new Set([key(x, y)]);
  let frontier = [{ x, y }];
  while (frontier.length) {
    const next = [];
    for (const c of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = c.x + dx, ny = c.y + dy, k = key(nx, ny);
        if (!inBounds(state, nx, ny) || seen.has(k)) continue;
        if (isFree(state, nx, ny)) return { x: nx, y: ny };
        seen.add(k); next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
  }
  return null; // свободных клеток нет вообще (почти нереально)
}

// Линия видимости (Брезенхем): битые пиксели блокируют атаки.
function hasLineOfSight(state, a, b) {
  let x0 = a.x, y0 = a.y;
  const x1 = b.x, y1 = b.y;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (!(x0 === x1 && y0 === y1)) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
    if (x0 === x1 && y0 === y1) break;
    const obj = objectAt(state, x0, y0);
    if (obj && !obj.walkable) return false;
  }
  return true;
}

// Случайная свободная клетка: в радиусе (Манхэттен) от точки, либо по всей карте,
// если radius <= 0. Если в радиусе пусто — берём всю карту (портал не должен «не сработать»).
function randomFreeCell(state, from = null, radius = 0) {
  let free = [];
  if (from && radius > 0) {
    for (let y = 0; y < state.map.h; y++) for (let x = 0; x < state.map.w; x++) {
      if (manhattan(from, { x, y }) <= radius && isFree(state, x, y)) free.push({ x, y });
    }
  }
  if (!free.length) {
    for (let y = 0; y < state.map.h; y++) for (let x = 0; x < state.map.w; x++) {
      if (isFree(state, x, y)) free.push({ x, y });
    }
  }
  return free.length ? free[Math.floor(Math.random() * free.length)] : null;
}

// Узоры «Сломанной системы»: 3 битых пикселя, выбранная клетка — ЦЕНТР узора.
// Углы смотрят во все 4 стороны (уголок узора и есть его центр).
const BROKEN_PATTERNS = {
  h:  [[-1, 0], [0, 0], [1, 0]],     // ─ горизонталь
  v:  [[0, -1], [0, 0], [0, 1]],     // │ вертикаль
  d1: [[-1, -1], [0, 0], [1, 1]],    // ╲ диагональ
  d2: [[-1, 1], [0, 0], [1, -1]],    // ╱ диагональ
  cornerTL: [[0, 0], [1, 0], [0, 1]],    // ┌ угол вправо-вниз
  cornerTR: [[0, 0], [-1, 0], [0, 1]],   // ┐ угол влево-вниз
  cornerBL: [[0, 0], [1, 0], [0, -1]],   // └ угол вправо-вверх
  cornerBR: [[0, 0], [-1, 0], [0, -1]],  // ┘ угол влево-вверх
};

// ---------------------------------------------------------------------------
// 3. Слоты
// ---------------------------------------------------------------------------
// Проверка, что выбранные индексы образуют комбинацию потребления.
// corp: закрытые слоты «прозрачны» — последовательность идёт по открытым.
function validateSlotChoice(slots, indices, consumption, corp) {
  if (!Array.isArray(indices)) return false;
  if (indices.length !== consumption.length) return false;
  if (new Set(indices).size !== indices.length) return false;
  const sorted = [...indices].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const s = slots[sorted[i]];
    if (!s || s.closed) return false;
    if (!s.ideal && String(s.value) !== consumption[i]) return false; // идеальный слот = и 0, и 1
  }
  if (corp) {
    const openIdx = slots.map((s, i) => (s.closed ? -1 : i)).filter(i => i >= 0);
    const pos = sorted.map(i => openIdx.indexOf(i));
    for (let i = 1; i < pos.length; i++) if (pos[i] !== pos[i - 1] + 1) return false;
  } else {
    for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 4. Урон / лечение / смерть / победа
// ---------------------------------------------------------------------------
// Защиты: AI-защита глушит ВСЁ (даже помощь и зоны), Брандмауэр — любое ОДНО
// негативное воздействие (и расходуется), Инкогнито — точечные атаки,
// Реверсивный поток — превращает первый урон в лечение.
// opts.self  — урон самому себе (перегрузка, сломанная программа): защиты молчат.
// opts.env   — среда (мины, зоны): Инкогнито не спасает, остальные защиты работают.
// opts.mass  — массовая атака: Инкогнито не спасает.
function dealDamage(state, target, amount, source, opts = {}) {
  const fx = [];
  if (!target || !target.alive || amount <= 0) return fx;
  const st = target.statuses;
  if (!opts.self) {
    if (st.aiDefense) {
      fx.push({ type: 'blocked', targetId: target.id, reason: 'ai-defense' });
      fx.push(aiChatFx(AI_MOCKS, st.aiDefenseName)); // имя закреплено на активацию
      return fx;
    }
    if (st.incognito && !opts.mass && !opts.env) { fx.push({ type: 'blocked', targetId: target.id, reason: 'incognito' }); return fx; }
    if (st.firewall) {
      st.firewall--;
      fx.push({ type: 'blocked', targetId: target.id, reason: 'firewall' });
      return fx;
    }
    if (st.reverseFlow) {
      st.reverseFlow = false;
      fx.push({ type: 'reverse', targetId: target.id, amount });
      return fx.concat(heal(state, target, amount, { self: true })); // свой статус — лечит всегда
    }
  }
  // Матрица (удача ставки на 4 бита): первая атакующая программа бьёт вдвойне.
  if (source && source.statuses && source.statuses.matrixDouble && !opts.self && !opts.env) {
    amount *= 2;
    source.statuses.matrixDouble = false;
  }
  // Матрица (провал ставки 5+ бит): урон программы срезан на 1.
  if (state._dmgCut && !opts.self && !opts.env) amount -= 1;
  // Торрент: урон проходит как обычно, но цель получает +мощность,
  // равную потреблению применённой по ней программы.
  if (!opts.self && !opts.env) torrentTick(state, target, fx, source);
  target.hp -= amount;
  fx.push({ type: 'damage', targetId: target.id, amount, sourceId: source ? source.id : null });
  // Матрица (провал ставки на 4 бита): отдача — половина урона прилетает и себе.
  if (source && source.statuses && source.statuses.matrixSplash && !opts.self && !opts.env && source.alive && source.id !== target.id) {
    fx.push(...dealDamage(state, source, Math.ceil(amount / 2), null, { self: true }));
  }
  // Боевой лог в чат: удары игрока по игроку. Действия под Инкогнито анонимны,
  // защитные программы сюда не попадают (урона они не наносят).
  if (source && source.id && source.id !== target.id && !source.statuses.incognito) {
    fx.push({ type: 'log', text: `${source.name} → ${target.name}: −${amount} ХП` });
  }
  if (target.hp <= 0) {
    if (opts.clampToOne) {
      target.hp = 1;
    } else if (st.backupPower) {
      st.backupPower = false;
      target.hp = 10;
      fx.push({ type: 'revive', targetId: target.id });
    } else {
      killPlayer(state, target, fx, source);
    }
  }
  return fx;
}

// Кража мощности (Спам вирус, ОБВАЛ СЕТИ) — тоже воздействие: защиты работают.
// Возвращает fx; реально снижает powerDelta, только если не заблокировано.
function drainPower(state, target, amount, source, opts = {}) {
  const fx = [];
  if (!target || !target.alive || amount <= 0) return fx;
  const st = target.statuses;
  if (!opts.self) {
    if (st.aiDefense) {
      fx.push({ type: 'blocked', targetId: target.id, reason: 'ai-defense' });
      fx.push(aiChatFx(AI_MOCKS, st.aiDefenseName)); // имя закреплено на активацию
      return fx;
    }
    if (st.firewall) {
      st.firewall--;
      fx.push({ type: 'blocked', targetId: target.id, reason: 'firewall' });
      return fx;
    }
  }
  // Торрент: кража мощности проходит, но цель получает +мощность за программу.
  if (!opts.self && !opts.env) torrentTick(state, target, fx, source);
  target.powerDelta -= amount;
  fx.push({ type: 'powerSteal', targetId: target.id, amount, sourceId: source ? source.id : null });
  return fx;
}

// ---------------------------------------------------------------------------
// Торрент: чужой эффект, который заденет носителя (урон, кража мощности,
// лечение, отталкивание — точечный или по площади), применяется как обычно,
// НО носитель получает +мощность, равную потреблению применённой по нему
// программы. Розыгрыши стакаются: каждое срабатывание снимает один стак,
// несработавшие стаки сгорают в начале хода носителя (как у Брандмауэра).
// Вызывается ТОЛЬКО из точек реального применения эффекта (после защит) —
// если эффект съели Брандмауэр/AI-защита, Торрент не тратится.
// state._torrentProg — программа, исполняемая прямо сейчас (ставит useProgram);
// без неё (мины, зоны, перегрев, слоты) бонуса нет — это не программы.
// ---------------------------------------------------------------------------
function torrentTick(state, target, fx, source) {
  if (!target || !target.alive || !target.statuses || !target.statuses.torrent) return;
  const prog = state._torrentProg;
  if (!prog) return;                              // воздействие не от программы (среда)
  if (source && source.id === target.id) return;  // своя программа бонуса не даёт
  target.statuses.torrent--;                   // одно срабатывание снимает один стак
  const amount = prog.consumption.length;
  target.powerDelta += amount;                    // бонус ляжет на ближайший ход носителя
  fx.push({ type: 'torrent', targetId: target.id, amount, progName: prog.name });
}

// Лечение. opts.fromOther / opts.env — внешняя помощь: AI-защита её ОТКЛОНЯЕТ
// («блокирует даже помощь»). Самолечение (Мозговая передышка, Реверс, Андервольтинг)
// идёт с opts.self и защитой не режется.
function heal(state, target, amount, opts = {}) {
  if (!target || !target.alive || amount <= 0) return [];
  if (!opts.self && target.statuses.aiDefense) {
    return [{ type: 'blocked', targetId: target.id, reason: 'ai-defense' }, aiChatFx(AI_MOCKS, target.statuses.aiDefenseName)];
  }
  // Торрент: даже ЧУЖОЕ лечение («Домашнее подключение») — это эффект
  // программы по носителю: лечит как обычно и даёт +мощность за потребление.
  const fx = [];
  if (!opts.self && !opts.env) torrentTick(state, target, fx, opts.source || null);
  target.hp += amount;
  fx.push({ type: 'heal', targetId: target.id, amount });
  return fx;
}

// Случайная реплика ИИ-бота в чат (имя + фраза выбираются на сервере — у всех одинаково).
// ИМЯ бота фиксируется на одну активацию «AI защиты» (statuses.aiDefenseName):
// все его издёвки до конца действия идут от одного имени, при следующей
// активации (в другом раунде) имя перебрасывается заново.
function aiChatFx(phrases, name) {
  return {
    type: 'aiChat',
    from: name || AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)],
    text: phrases[Math.floor(Math.random() * phrases.length)],
  };
}

function killPlayer(state, target, fx, source) {
  const killer = source && source.id && source.id !== target.id && !source.statuses.incognito ? source : null;
  fx.push({ type: 'log', text: killer ? `☠ ${killer.name} отключил ${target.name}` : `☠ ${target.name} отключён` });
  target.alive = false;
  target.hp = 0;
  removeCopyOf(state, target.id); // цифровая копия умирает вместе с владельцем
  fx.push({ type: 'death', targetId: target.id });
  checkWin(state, fx);
}

// Победа: в командном режиме выживание считается по командам (игрок без
// команды — сам себе команда). «Дружественный огонь» нигде не отключён:
// массовые атаки бьют и по своим.
function aliveTeamKeys(state) {
  const keys = new Set();
  for (const p of state.players) if (p.alive) keys.add(p.team == null ? 'solo:' + p.id : 'team:' + p.team);
  return [...keys];
}

function endGame(state, fx, winner, reason) {
  state.over = true;
  state.winnerId = winner ? winner.id : null;
  state.winnerTeam = winner && state.settings.teamsEnabled ? winner.team : null;
  fx.push({ type: 'gameOver', winnerId: state.winnerId, winnerTeam: state.winnerTeam, reason: reason || null });
}

function checkWin(state, fx) {
  if (state.over) return;
  const alive = state.players.filter(p => p.alive);
  if (alive.length === 0) {
    // Все мертвы (возможно в отладочной одиночной игре).
    endGame(state, fx, null);
  } else if (state.players.length > 1) {
    if (state.settings.teamsEnabled) {
      if (aliveTeamKeys(state).length <= 1) endGame(state, fx, alive[0], 'elimination');
    } else if (alive.length <= 1) {
      endGame(state, fx, alive[0], 'elimination');
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Передвижение (срабатывают мины, порталы и АИМбот)
// ---------------------------------------------------------------------------
// Реакция АИМботов на перемещение игрока.
function triggerAimbots(state, player, fx) {
  if (player.statuses.incognito) return; // невидимку АИМбот не захватывает
  for (const other of state.players) {
    if (!other.alive || other.id === player.id || !other.statuses.aimbot) continue;
    if (other.pos && manhattan(other.pos, player.pos) <= 6) {
      fx.push({ type: 'aimbot', sourceId: other.id, targetId: player.id });
      fx.push(...dealDamage(state, player, 3, other));
    }
  }
}

// Высадка из парного портала: случайная свободная клетка в радиусе 1
// (по Чебышёву, 8 соседних) вокруг портала-партнёра — прямо НА портал
// не встаём. null = высадиться некуда (все клетки заняты).
function portal2Landing(state, px, py) {
  const ring = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    if (isFree(state, px + dx, py + dy)) ring.push({ x: px + dx, y: py + dy });
  }
  return ring.length ? ring[Math.floor(Math.random() * ring.length)] : null;
}

// «Шагающие» карты (Побитное/Многобитное соединение): мина взрывается не
// только под точкой приземления, но и на КАЖДОЙ клетке пути — «прошёл через
// мину» = подорвался. Телепорты (Смена провайдера, Проход сквозь баги) пути
// не имеют и срабатывают только в точке высадки (movePlayer).
function walkPlayer(state, player, x, y, fx) {
  const path = bfsPath(state, player.pos, { x, y }, !!player.statuses.moveGhost);
  if (!path) { movePlayer(state, player, x, y, fx); return; } // страховка: валидация уже пропустила
  for (let i = 0; i < path.length - 1; i++) {
    const c = path[i];
    const obj = objectAt(state, c.x, c.y);
    if (obj && obj.type === 'mine') {
      delete state.map.objects[key(c.x, c.y)];
      fx.push({ type: 'mine', playerId: player.id, x: c.x, y: c.y });
      fx.push(...dealDamage(state, player, obj.effect.amount || 5, null, { env: true }));
      if (!player.alive) { // подорвался по дороге — дальше не идёт
        player.pos = { x: c.x, y: c.y };
        fx.push({ type: 'move', playerId: player.id, x: c.x, y: c.y });
        return;
      }
    }
  }
  const last = path[path.length - 1];
  movePlayer(state, player, last.x, last.y, fx);
}

function movePlayer(state, player, x, y, fx) {
  const from = player.pos ? { ...player.pos } : null; // для отката, если портал заблокирован
  player.pos = { x, y };
  fx.push({ type: 'move', playerId: player.id, x, y });

  // Объекты, реагирующие на вход в клетку.
  const obj = objectAt(state, x, y);
  if (obj && obj.type === 'mine') {
    delete state.map.objects[key(x, y)];
    fx.push({ type: 'mine', playerId: player.id, x, y });
    fx.push(...dealDamage(state, player, obj.effect.amount || 5, null, { env: true }));
  } else if (obj && obj.type === 'portal') {
    // Обычный портал: случайная клетка в РАДИУСЕ от портала (0 = вся карта).
    const dest = randomFreeCell(state, { x, y }, obj.radius || 0);
    if (dest) {
      player.pos = dest;
      fx.push({ type: 'teleport', playerId: player.id, x: dest.x, y: dest.y });
    }
  } else if (obj && obj.type === 'portal2') {
    // Парный портал: переносит к порталу ТОЛЬКО своей пары (obj.pair).
    // Хост обязан ставить каждую пару ровно из двух порталов — это
    // проверяется сервером при нажатии «КАРТА ГОТОВА».
    const pair = obj.pair || 1;
    const others = [];
    for (const k of Object.keys(state.map.objects)) {
      const o = state.map.objects[k];
      if (o.type !== 'portal2' || (o.pair || 1) !== pair) continue;
      const [ox, oy] = k.split(',').map(Number);
      if (ox === x && oy === y) continue;
      others.push({ x: ox, y: oy });
    }
    if (others.length) {
      // В валидной карте партнёр ровно один; если вдруг больше — ближайший.
      others.sort((a, b) => manhattan(a, { x, y }) - manhattan(b, { x, y }));
      const best = others.filter(o => manhattan(o, { x, y }) === manhattan(others[0], { x, y }));
      const target = best[Math.floor(Math.random() * best.length)];
      const dest = portal2Landing(state, target.x, target.y);
      if (!dest) {
        // Высадиться некуда: все 8 клеток вокруг парного портала заняты
        // (битые пиксели, игроки, копии). Вход в портал ОТКЛОНЯЕТСЯ —
        // игрок остаётся на своей клетке и получает ошибку.
        player.pos = from;
        fx.push({ type: 'portalBlocked', playerId: player.id, x, y });
        return; // без срабатывания АИМботов: перемещения не было
      }
      player.pos = dest;
      fx.push({ type: 'teleport', playerId: player.id, x: dest.x, y: dest.y });
    }
  } else if (obj && obj.type === 'rift') {
    // Разлом данных: вступивший МОЖЕТ один раз сломать в нём свою программу
    // (окно открывается на клиенте по этому fx). Разлом не расходуется сам —
    // он помечается использованным только по факту (useRift, поле usedBy).
    const usedBy = obj.usedBy || [];
    if (player.alive && !usedBy.includes(player.id)) {
      fx.push({ type: 'rift', playerId: player.id, x, y });
    }
  }

  triggerAimbots(state, player, fx);
}

// ---------------------------------------------------------------------------
// 6. Цифровые копии («Разделение сигнала»)
// ---------------------------------------------------------------------------
function copyOf(state, ownerId) {
  for (const k of Object.keys(state.copies)) {
    if (state.copies[k].ownerId === ownerId) return { key: k, obj: state.copies[k] };
  }
  return null;
}

function removeCopyOf(state, ownerId) {
  const c = copyOf(state, ownerId);
  if (c) delete state.copies[c.key];
}

// Урон по копии: личные защиты ВЛАДЕЛЬЦА на копию не распространяются.
function damageCopy(state, copyKey, amount, source, fx) {
  const obj = state.copies[copyKey];
  if (!obj || amount <= 0) return;
  obj.hp -= amount;
  fx.push({ type: 'copyHit', key: copyKey, amount, hp: obj.hp });
  if (obj.hp <= 0) {
    delete state.copies[copyKey];
    fx.push({ type: 'copyDown', key: copyKey, ownerId: obj.ownerId });
    const victim = getPlayer(state, obj.ownerId);
    if (victim) fx.push({ type: 'log', text: `⌗ копия ${victim.name} рассеялась` });
  }
}

// Перемещение копии на новую клетку (копия — оверлей, объекты под ней живы).
function moveCopy(state, fromKey, x, y, fx) {
  const c = state.copies[fromKey];
  if (!c) return;
  delete state.copies[fromKey];
  state.copies[key(x, y)] = c;
  fx.push({ type: 'teleport', x, y });
  resolveCopyCell(state, key(x, y), fx);
}

// Копия — «аналог игрока»: клетка под ней СРАБАТЫВАЕТ, как под игроком,
// но зоны на копию не действуют (она просто стоит в зоне, эффекта нет).
// Мина взрывается (урон копии), порталы переносят копию.
function resolveCopyCell(state, k, fx) {
  const c = state.copies[k];
  if (!c) return;
  const [x, y] = k.split(',').map(Number);
  const obj = objectAt(state, x, y);
  if (!obj) return;
  if (obj.type === 'mine') {
    delete state.map.objects[k];
    fx.push({ type: 'mine', x, y });
    damageCopy(state, k, obj.effect.amount || 5, null, fx);
  } else if (obj.type === 'portal') {
    const dest = randomFreeCell(state, { x, y }, obj.radius || 0);
    if (dest) moveCopy(state, k, dest.x, dest.y, fx);
  } else if (obj.type === 'portal2') {
    const pair = obj.pair || 1;
    const others = [];
    for (const ok2 of Object.keys(state.map.objects)) {
      const o = state.map.objects[ok2];
      if (o.type !== 'portal2' || (o.pair || 1) !== pair || ok2 === k) continue;
      const [ox, oy] = ok2.split(',').map(Number);
      others.push({ x: ox, y: oy });
    }
    if (others.length) {
      others.sort((a, b) => manhattan(a, { x, y }) - manhattan(b, { x, y }));
      const best = others.filter(o => manhattan(o, { x, y }) === manhattan(others[0], { x, y }));
      const target = best[Math.floor(Math.random() * best.length)];
      const dest = portal2Landing(state, target.x, target.y);
      // Если высадиться некуда — копия просто остаётся стоять на портале.
      if (dest) moveCopy(state, k, dest.x, dest.y, fx);
    }
  }
  // zone / point / стена (копию на них не поставить) — без эффекта.
}

// ---------------------------------------------------------------------------
// 7. Эффекты программ. Чтобы добавить программу — добавьте обработчик сюда
// и запись в game/programs.js.
// Обработчик: (state, player, target, fx, payload).
//   target  — {x,y} | {playerId} | {copyKey} | {};
//   payload — исходный пакет от клиента (там, напр., payload.amount).
// ---------------------------------------------------------------------------
const EFFECTS = {
  // --- передвижение ---
  'bit-connect': (s, p, t, fx) => walkPlayer(s, p, t.x, t.y, fx),
  'multi-connect': (s, p, t, fx) => walkPlayer(s, p, t.x, t.y, fx),
  'change-provider': (s, p, t, fx) => movePlayer(s, p, t.x, t.y, fx),
  'bug-pass': (s, p, t, fx) => movePlayer(s, p, t.x, t.y, fx),

  // --- точечный урон ---
  'small-ddos': (s, p, t, fx) => fx.push(...dealDamage(s, getPlayer(s, t.playerId), 2, p)),
  'server-ddos': (s, p, t, fx) => fx.push(...dealDamage(s, getPlayer(s, t.playerId), 4, p)),
  'remote-connect': (s, p, t, fx) => fx.push(...dealDamage(s, getPlayer(s, t.playerId), 1, p)),

  // Пинг-понг: отталкивание на 4 клетки прочь от атакующего.
  // Урон не наносится; Брандмауэр/AI-защита блокируют само отталкивание.
  'ping-pong': (s, p, t, fx) => {
    const victim = getPlayer(s, t.playerId);
    if (!victim || !victim.pos) return;
    const st = victim.statuses;
    if (st.aiDefense) {
      fx.push({ type: 'blocked', targetId: victim.id, reason: 'ai-defense' });
      fx.push(aiChatFx(AI_MOCKS, st.aiDefenseName));
      return;
    }
    if (st.firewall) {
      st.firewall--;
      fx.push({ type: 'blocked', targetId: victim.id, reason: 'firewall' });
      return;
    }
    // Торрент: отталкивание проходит, но жертва получает +мощность за программу.
    torrentTick(s, victim, fx, p);
    // Направление: от атакующего к жертве (цель всегда в соседней клетке).
    const dx = Math.sign(victim.pos.x - p.pos.x), dy = Math.sign(victim.pos.y - p.pos.y);
    let cx = victim.pos.x, cy = victim.pos.y;
    for (let i = 0; i < 4; i++) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(s, nx, ny)) break;                 // край карты
      const o = objectAt(s, nx, ny);
      if (o && !o.walkable) break;                     // битый пиксель — стоп
      if (copyAt(s, nx, ny)) break;                    // копия — стоп
      if (playerAt(s, nx, ny)) break;                  // другой игрок — стоп
      cx = nx; cy = ny;
      // Отброс — тоже движение: мина на пути отлёта взрывается.
      const mo = objectAt(s, nx, ny);
      if (mo && mo.type === 'mine') {
        delete s.map.objects[key(nx, ny)];
        fx.push({ type: 'mine', playerId: victim.id, x: nx, y: ny });
        fx.push(...dealDamage(s, victim, mo.effect.amount || 5, null, { env: true }));
        if (!victim.alive) break; // подорвался в полёте — дальше не летит
      }
    }
    victim.pos = { x: cx, y: cy };
    fx.push({ type: 'pushed', playerId: victim.id, x: cx, y: cy, sourceId: p.id });
    if (victim.alive) triggerAimbots(s, victim, fx); // перемещение — АИМботы реагируют
  },

  // --- утилиты ---
  'spam-virus': (s, p, t, fx) => fx.push(...drainPower(s, getPlayer(s, t.playerId), 1, p)),

  'broken-system': (s, p, t, fx) => {
    const offsets = BROKEN_PATTERNS[t.pattern] || BROKEN_PATTERNS.h;
    for (const [dx, dy] of offsets) {
      const x = t.x + dx, y = t.y + dy;
      if (!inBounds(s, x, y) || objectAt(s, x, y) || playerAt(s, x, y)) continue;
      s.map.objects[key(x, y)] = {
        type: 'wall', color: '#ff2244', walkable: false,
        effect: { kind: 'none', amount: 0 }, temp: true, ownerId: p.id, name: 'Битый пиксель',
      };
    }
    fx.push({ type: 'walls', ownerId: p.id });
  },

  'sleep-mode': (s, p, t, fx) => {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      const x = p.pos.x + dx, y = p.pos.y + dy;
      if (!inBounds(s, x, y) || objectAt(s, x, y) || playerAt(s, x, y)) continue;
      s.map.objects[key(x, y)] = {
        type: 'wall', color: '#ff2244', walkable: false,
        effect: { kind: 'none', amount: 0 }, temp: true, ownerId: p.id, name: 'Битый пиксель',
      };
    }
    fx.push({ type: 'walls', ownerId: p.id });
  },

  // Разделение сигнала: цифровая копия на выбранной клетке (7 ХП, неподвижна).
  // Копия — оверлей: объект под ней (зона, портал, мина) НЕ уничтожается.
  // Мина/портал под копией срабатывают сразу — как под игроком.
  'signal-split': (s, p, t, fx) => {
    const k = key(t.x, t.y);
    s.copies[k] = { name: `Копия: ${p.name}`, color: p.color, ownerId: p.id, hp: 7 };
    fx.push({ type: 'copySpawn', playerId: p.id, x: t.x, y: t.y });
    resolveCopyCell(s, k, fx);
  },

  // Сканер сети: вы (и только вы) видите руку цели и можете ПЕРЕХВАТИТЬ
  // одну целую программу — она блокируется у врага до конца следующего
  // раунда, а вы разыгрываете её со своих слотов в этот же ход (окно выбора
  // открывается на клиенте, Esc — отказаться). Если ваши открытые слоты не
  // покрывают потребление карты — перехват не состоится и блока не будет.
  // Защита: AI защита глушит сканер полностью, Брандмауэр поглощает один скан.
  'net-scanner': (s, p, t, fx) => {
    const victim = getPlayer(s, t.playerId);
    if (!victim) return;
    if (victim.statuses.aiDefense) {
      fx.push({ type: 'blocked', targetId: victim.id, reason: 'ai-defense' });
      fx.push(aiChatFx(AI_MOCKS, victim.statuses.aiDefenseName));
      return;
    }
    if (victim.statuses.firewall) {
      victim.statuses.firewall--;
      fx.push({ type: 'blocked', targetId: victim.id, reason: 'firewall' });
      return;
    }
    // Метка «рука открыта»: перехват возможен только до конца этого хода.
    s.pendingScan = { playerId: p.id, targetId: victim.id };
    fx.push({
      type: 'scan', playerId: p.id, targetId: victim.id, targetName: victim.name,
      hand: victim.hand.map(c => ({
        uid: c.uid,
        name: ((PROGRAM_MAP[c.progId] || {}).name || c.progId) + (c.broken ? ' [сломана]' : ''),
        consumption: c.consumption, broken: !!c.broken,
        blocked: !!(c.blockedUntilRound && s.round <= c.blockedUntilRound),
      })),
    });
  },

  // Закладка: мина (5 урона) на свободной клетке. Видна всем, живёт до взрыва.
  'mine-plant': (s, p, t, fx) => {
    s.map.objects[key(t.x, t.y)] = { type: 'mine', color: '#ff2222', walkable: true, effect: { kind: 'damage', amount: 5 } };
    fx.push({ type: 'mineSet', x: t.x, y: t.y, playerId: p.id });
  },

  // Data_Error: куб битых пикселей 4×4 на 2 раунда. Выбранная клетка —
  // ЦЕНТР куба (ближайшая к центру клетка: куб уходит на 1 клетку влево-вверх
  // и на 2 вправо-вниз от клика). Клетки с объектами и копиями пропускаются;
  // игроки внутри получают 5 урона (защиты глушат урон) и сбрасываются на
  // ближайшую свободную клетку (защиты НЕ глушат сброс).
  'data-error': (s, p, t, fx) => {
    const x0 = t.x - 1, y0 = t.y - 1; // клик = центр куба 4×4
    const victims = [];
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (!inBounds(s, x, y)) continue;
      if (objectAt(s, x, y) || copyAt(s, x, y)) continue; // на объектах/копиях не появляется
      const victim = playerAt(s, x, y);
      if (victim) { victims.push(victim); continue; } // клетку займёт пиксель после сброса
      s.map.objects[key(x, y)] = {
        type: 'wall', color: '#ff2244', walkable: false,
        effect: { kind: 'none', amount: 0 }, temp: false, ownerId: p.id,
        name: 'Битый пиксель', roundsLeft: 2, // живёт 2 раунда
      };
    }
    for (const v of victims) {
      fx.push(...dealDamage(s, v, 5, p));
      const dest = nearestFreeCell(s, v.pos.x, v.pos.y);
      if (dest && (dest.x !== v.pos.x || dest.y !== v.pos.y)) {
        v.pos = dest;
        fx.push({ type: 'teleport', playerId: v.id, x: dest.x, y: dest.y });
      }
    }
    // Докидываем пиксели на клетки, откуда сбросили игроков.
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (!inBounds(s, x, y) || objectAt(s, x, y) || copyAt(s, x, y) || playerAt(s, x, y)) continue;
      s.map.objects[key(x, y)] = {
        type: 'wall', color: '#ff2244', walkable: false,
        effect: { kind: 'none', amount: 0 }, temp: false, ownerId: p.id,
        name: 'Битый пиксель', roundsLeft: 2,
      };
    }
    fx.push({ type: 'walls', ownerId: p.id });
  },

  // --- массовые ---
  'overload': (s, p, t, fx) => {
    fx.push(...dealDamage(s, p, 3, p, { self: true, clampToOne: true }));
    for (const other of s.players) {
      if (!other.alive || other.id === p.id) continue;
      if (manhattan(p.pos, other.pos) <= 5) {
        fx.push(...dealDamage(s, other, 5, p, { mass: true }));
      }
    }
    // Копии тоже страдают от перегрузки.
    for (const k of Object.keys(s.map.objects)) {
      const o = s.map.objects[k];
      if (o.type !== 'copy') continue;
      const [cx, cy] = k.split(',').map(Number);
      if (manhattan(p.pos, { x: cx, y: cy }) <= 5) damageCopy(s, k, 5, p, fx);
    }
  },

  'net-collapse': (s, p, t, fx) => {
    for (const pl of s.players) {
      if (!pl.alive) continue;
      fx.push(...drainPower(s, pl, 5, p, { self: pl.id === p.id })); // себе — без защит
    }
  },

  // --- защита ---
  'firewall': (s, p, t, fx) => { p.statuses.firewall++; fx.push({ type: 'status', playerId: p.id, status: 'firewall' }); },

  // Торрент: как брандмауэр, но вместо блока — «качалка»: первый чужой
  // эффект по носителю проходит как обычно и даёт +мощность, равную
  // потреблению той программы (срабатывание — в torrentTick).
  'torrent': (s, p, t, fx) => { p.statuses.torrent++; fx.push({ type: 'status', playerId: p.id, status: 'torrent' }); },

  // AI защита: блокирует ВСЁ (даже помощь). Максимум раз в раунд —
  // повторный вызов отклонён ревнивым ИИ (проверка в useProgram).
  'ai-defense': (s, p, t, fx) => {
    p.statuses.aiDefense = true;
    p.statuses.aiDefenseRound = s.round;
    // Имя бота закрепляется на эту активацию: весь раунд он пишет под ним.
    p.statuses.aiDefenseName = AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)];
    fx.push({ type: 'status', playerId: p.id, status: 'aiDefense' });
    fx.push({ type: 'aiDefenseOn', playerId: p.id, from: p.statuses.aiDefenseName });
  },

  // Сторонний айпи: запоминаем ВЫБРАННОГО при активации игрока (одного из
  // ближайших — проверка в validateTarget). В конце хода урона от незакрытых
  // слотов нет; вместо него цель получает +мощность на свой следующий ход.
  'third-party-ip': (s, p, t, fx) => {
    p.statuses.thirdPartyIp = t.playerId;
    fx.push({ type: 'status', playerId: p.id, status: 'thirdPartyIp' });
  },
  'incognito': (s, p, t, fx) => { p.statuses.incognito = true; fx.push({ type: 'status', playerId: p.id, status: 'incognito' }); },
  'reverse-flow': (s, p, t, fx) => { p.statuses.reverseFlow = true; fx.push({ type: 'status', playerId: p.id, status: 'reverseFlow' }); },
  'aimbot': (s, p, t, fx) => { p.statuses.aimbot = true; fx.push({ type: 'status', playerId: p.id, status: 'aimbot' }); },
  'violence-mode': (s, p, t, fx) => { p.statuses.violence = true; fx.push({ type: 'status', playerId: p.id, status: 'violence' }); },
  'backup-power': (s, p, t, fx) => { p.statuses.backupPower = true; fx.push({ type: 'status', playerId: p.id, status: 'backupPower' }); },

  // --- поддержка ---
  'brain-rest': (s, p, t, fx) => fx.push(...heal(s, p, 5, { self: true })),
  'home-connection': (s, p, t, fx) => fx.push(...heal(s, getPlayer(s, t.playerId), 2, { fromOther: true, source: p })),

  // Андервольтинг: +X ХП сейчас, −X мощности на СЛЕДУЮЩИЙ свой ход
  // (X = payload.amount, 1..5, не больше текущей). Жертва откладывается в
  // statuses.undervoltPenalty и применяется в endTurn ПОСЛЕ сброса powerDelta —
  // иначе конец текущего хода обнуляет минус, и обмен выходит бесплатным.
  // Как украденная мощность у врага: один свой ход с меньшим числом слотов,
  // потом мощность возвращается.
  'undervolt': (s, p, t, fx, payload) => {
    let amount = Math.min(5, Math.max(1, parseInt(payload && payload.amount, 10) || 1));
    amount = Math.min(amount, powerOf(p));
    if (amount <= 0) return;
    p.statuses.undervoltPenalty = (p.statuses.undervoltPenalty || 0) + amount;
    fx.push({ type: 'powerSteal', targetId: p.id, amount, sourceId: p.id });
    fx.push(...heal(s, p, amount, { self: true }));
  },

  // peer-to-peer: до конца хода карты игрока исполняет выбранный игрок.
  // Цели по-прежнему выбирает ВЛАДЕЛЕЦ карты — просто дальность, видимость
  // и эффекты считаются от пешки ПОДКЛЮЧЁННОГО (см. useProgram).
  'peer-to-peer': (s, p, t, fx) => {
    // Подключение — внешнее воздействие: AI-защита глушит его, брандмауэр
    // сгорает, отражая попытку (карта при этом всё равно потрачена).
    const linked = getPlayer(s, t.playerId);
    if (!linked) return;
    const st = linked.statuses;
    if (st.aiDefense) {
      fx.push({ type: 'blocked', targetId: linked.id, reason: 'ai-defense' });
      fx.push(aiChatFx(AI_MOCKS, st.aiDefenseName));
      return;
    }
    if (st.firewall) {
      st.firewall--;
      fx.push({ type: 'blocked', targetId: linked.id, reason: 'firewall' });
      return;
    }
    p.statuses.p2pTarget = t.playerId;
    fx.push({ type: 'p2pLink', playerId: p.id, targetId: t.playerId, targetName: linked.name });
  },
};

// ---------------------------------------------------------------------------
// 8. Валидация цели программы
// ---------------------------------------------------------------------------
function validateTarget(state, player, prog, target) {
  if (prog.target === 'none') return { ok: true };
  if (!target) return { ok: false, error: 'Нужно выбрать цель на карте.' };

  // Обмен местами со своей копией — особый случай карт передвижения.
  if (target.swapCopy) {
    if (prog.kind !== 'move') return { ok: false, error: 'Меняться местами можно только картой передвижения.' };
    const c = copyOf(state, player.id);
    if (!c) return { ok: false, error: 'У вас нет цифровой копии.' };
    return { ok: true };
  }

  // Цель — цифровая копия (бить её можно только атакующими программами с уроном).
  if (target.copyKey) {
    if (prog.kind !== 'damage' || (prog.damage || 0) <= 0) return { ok: false, error: 'Копию можно только атаковать.' };
    if (!state.copies[target.copyKey]) return { ok: false, error: 'Копия уже уничтожена.' };
    const [cx, cy] = target.copyKey.split(',').map(Number);
    if (manhattan(player.pos, { x: cx, y: cy }) > prog.range) return { ok: false, error: 'Цель вне дальности.' };
    if (!hasLineOfSight(state, player.pos, { x: cx, y: cy })) return { ok: false, error: 'Битый пиксель блокирует атаку.' };
    return { ok: true };
  }

  if (prog.target === 'enemy') {
    const victim = getPlayer(state, target.playerId);
    if (!victim || !victim.alive || victim.id === player.id) return { ok: false, error: 'Недопустимая цель.' };
    // Инкогнито: точечные программы (атаки, отброс, сканер...) не могут
    // НАВЕСТИСЬ на невидимку. Массовые и зональные эффекты работают как раньше.
    if (victim.statuses.incognito) return { ok: false, error: 'Цель в инкогнито — точечные программы её не захватывают.' };
    if (manhattan(player.pos, victim.pos) > prog.range) return { ok: false, error: 'Цель вне дальности.' };
    if (!prog.noLos && !hasLineOfSight(state, player.pos, victim.pos)) return { ok: false, error: 'Битый пиксель блокирует атаку.' };
    // Сторонний айпи: бонус уходит только одному из БЛИЖАЙШИХ живых игроков
    // (при равном расстоянии активирующий сам выбирает кликом по клетке).
    if (prog.id === 'third-party-ip') {
      const others = state.players.filter(q => q.alive && q.id !== player.id && q.pos);
      if (others.length) {
        const minD = Math.min(...others.map(q => manhattan(q.pos, player.pos)));
        if (manhattan(victim.pos, player.pos) !== minD) {
          return { ok: false, error: 'Бонус может получить только БЛИЖАЙШИЙ к вам игрок (их может быть несколько — выбирайте).' };
        }
      }
    }
    return { ok: true };
  }

  // target === 'cell'
  const { x, y } = target;
  if (!inBounds(state, x, y)) return { ok: false, error: 'Вне карты.' };

  if (prog.id === 'broken-system') {
    const offsets = BROKEN_PATTERNS[target.pattern] || BROKEN_PATTERNS.h;
    for (const [dx, dy] of offsets) {
      if (!inBounds(state, x + dx, y + dy) || objectAt(state, x + dx, y + dy) || playerAt(state, x + dx, y + dy)) {
        return { ok: false, error: 'Узор не помещается: нужны 3 свободные клетки по выбранной фигуре.' };
      }
    }
    return { ok: true };
  }
  if (prog.id === 'change-provider') {
    return isFree(state, x, y) ? { ok: true } : { ok: false, error: 'Клетка занята.' };
  }
  if (prog.id === 'bug-pass') {
    if (!isFree(state, x, y)) return { ok: false, error: 'Клетка занята.' };
    const nearBroken = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].some(([dx, dy]) => {
      const o = objectAt(state, x + dx, y + dy);
      return o && !o.walkable;
    });
    return nearBroken ? { ok: true } : { ok: false, error: 'Рядом нет битого пикселя.' };
  }
  if (prog.id === 'mine-plant') {
    // Нужна совсем пустая клетка: мины/зоны проходимы, isFree их пропускает.
    if (objectAt(state, x, y) || playerAt(state, x, y) || copyAt(state, x, y)) return { ok: false, error: 'Клетка занята.' };
    if (manhattan(player.pos, { x, y }) > prog.range) return { ok: false, error: 'Клетка вне дальности.' };
    return { ok: true };
  }
  if (prog.id === 'signal-split') {
    if (copyOf(state, player.id)) return { ok: false, error: 'У вас уже есть цифровая копия (максимум одна).' };
    if (!isFree(state, x, y)) return { ok: false, error: 'Клетка занята.' };
    if (manhattan(player.pos, { x, y }) > prog.range) return { ok: false, error: 'Клетка вне дальности.' };
    return { ok: true };
  }
  if (prog.id === 'data-error') {
    if (manhattan(player.pos, { x, y }) > prog.range) return { ok: false, error: 'Клетка вне дальности.' };
    return { ok: true };
  }
  // Обычное передвижение: BFS на prog.range клеток.
  let moveRange = prog.range;
  if (player.statuses.moveMinus) { // провал ставки Матрицы: дальность −1
    moveRange -= 1;
    if (moveRange <= 0) return { ok: false, error: 'МАТРИЦА: дальность передвижения срезана до нуля — ход картами движения заблокирован.' };
  }
  const reach = player.statuses.moveGhost
    ? ghostReachable(state, player.pos, moveRange)  // удача Матрицы: сквозь препятствия
    : bfsReachable(state, player.pos, moveRange);
  return reach.has(key(x, y)) ? { ok: true } : { ok: false, error: 'Туда не добраться.' };
}

// ---------------------------------------------------------------------------
// 9. Использование программы
// payload: { uid, indices: number[], target?: {x,y}|{playerId}|{copyKey}|{swapCopy},
//            violenceMode?, amount? }
// ---------------------------------------------------------------------------
function useProgram(state, playerId, payload) {
  const fx = [];
  if (state.over) return { ok: false, error: 'Игра окончена.', fx };
  const player = currentPlayer(state);
  if (!player || player.id !== playerId) return { ok: false, error: 'Сейчас не ваш ход.', fx };

  // КодШифр — виртуальная карта режима «Захват территории».
  if (payload.uid === CIPHER_UID) return useCipher(state, player, payload);

  const card = player.hand.find(c => c.uid === payload.uid);
  if (!card) return { ok: false, error: 'Программа не найдена в руке.', fx };
  const prog = PROGRAM_MAP[card.progId];
  if (!prog) return { ok: false, error: 'Неизвестная программа.', fx };

  // AI защита — раз в раунд: ИИ ревнует и отказывает.
  if (prog.id === 'ai-defense' && player.statuses.aiDefenseRound === state.round) {
    const jealous = aiChatFx(AI_JEALOUS, player.statuses.aiDefenseName);
    return { ok: false, error: 'AI защита уже использовалась в этом раунде.', fx: [jealous], aiJealous: true };
  }

  // Анти-накопление: получив бонус мощности от чужого «Стороннего айпи»,
  // игрок не может разыграть СВОЙ «Сторонний айпи» до конца своего хода.
  if (prog.id === 'third-party-ip' && player.statuses.tpiBlocked) {
    return { ok: false, error: 'Сторонний айпи заблокирован: вы получили бонус мощности от чужого Стороннего айпи. Разблокируется после вашего хода.', fx };
  }

  // Перехват сканером / провал ставки Матрицы: карта заблокирована на раунд.
  if (card.blockedUntilRound && state.round <= card.blockedUntilRound) {
    return { ok: false, error: `«${prog.name}» заблокирована до конца следующего раунда.`, fx };
  }

  // Матрица (удача на 3 бита): поставленная карта один раз закрывает слоты как КОРП.
  const corp = player.interfaceId === 'corp' || player.statuses.corpOnceUid === card.uid;
  if (!validateSlotChoice(state.slots, payload.indices, card.consumption, corp)) {
    return { ok: false, error: 'Слоты не совпадают с потреблением программы.', fx };
  }

  // peer-to-peer: цель выбирает ВЛАДЕЛЕЦ карты, но карта исполняется
  // ПОДКЛЮЧЁННЫМ игроком — дальность/видимость от его пешки, эффекты на него.
  const linked = player.statuses.p2pTarget && getPlayer(state, player.statuses.p2pTarget);
  const viaP2p = !!(linked && linked.alive && prog.id !== 'peer-to-peer');

  // Режим Насилия: damage <-> move взаимозаменяемы (при p2p не действует —
  // подключённый игрок играет карту «как есть»).
  let effectiveProg = prog;
  if (!viaP2p && player.statuses.violence && payload.violenceMode) {
    effectiveProg = Object.assign({}, prog, payload.violenceMode === 'asMove'
      ? { target: 'cell', kind: 'move', range: prog.damage || prog.range }
      : { target: 'enemy', kind: 'damage', damage: prog.range });
    if (payload.violenceMode === 'asMove') {
      // Провал Матрицы (5+ бит): срезает и дальность «движения из атаки».
      if (player.statuses.moveMinus) {
        effectiveProg.range -= 1;
        if (effectiveProg.range <= 0) return { ok: false, error: 'МАТРИЦА: дальность срезана до нуля — передвижение заблокировано.', fx };
      }
      const reach = bfsReachable(state, player.pos, effectiveProg.range);
      if (!payload.target || !reach.has(key(payload.target.x, payload.target.y))) {
        return { ok: false, error: 'Туда не добраться.', fx };
      }
    } else {
      const v = validateTarget(state, player, effectiveProg, payload.target);
      if (!v.ok) return { ok: false, error: v.error, fx };
    }
  } else if (viaP2p) {
    // peer-to-peer: цель уже выбрал владелец карты — проверяем её от
    // позиции ПОДКЛЮЧЁННОГО игрока (дальность и линия видимости от него).
    const v = validateTarget(state, linked, prog, payload.target);
    if (!v.ok) return { ok: false, error: v.error, fx };
  } else {
    const v = validateTarget(state, player, prog, payload.target);
    if (!v.ok) return { ok: false, error: v.error, fx };
  }

  // Матрица (провал 5+ бит): урон программы −1; если урон срезан до нуля —
  // программа заблокирована (урон 0 у Пинг-понга не считается: он толкает).
  const dmgCut = player.statuses.dmgMinus && effectiveProg.kind === 'damage' && (effectiveProg.damage || 0) > 0;
  if (dmgCut && effectiveProg.damage - 1 <= 0) {
    return { ok: false, error: 'МАТРИЦА: урон срезан до нуля — программа заблокирована.', fx };
  }

  // Закрываем слоты.
  for (const i of payload.indices) state.slots[i].closed = true;
  state.slotsUsed = true; // слоты пошли в дело — ставка Матрицы больше недоступна
  if (player.statuses.corpOnceUid === card.uid) player.statuses.corpOnceUid = null; // разовый КОРП израсходован
  fx.push({ type: 'slotsClosed', indices: payload.indices, playerId: player.id });

  // Применяем эффект. При p2p «исполнитель» — подключённый игрок.
  // _torrentProg — контекст для Торрента: какая программа сейчас исполняется
  // (бонус носителю считается от её потребления; вне программы контекста нет).
  const actor = viaP2p ? linked : player;
  state._torrentProg = prog;
  state._dmgCut = dmgCut; // контекст для dealDamage: срезка урона от провала Матрицы
  applyEffect(state, actor, prog, effectiveProg, payload, fx, player, card);
  state._torrentProg = null;
  state._dmgCut = false;

  // Парный портал оказался заблокирован — перемещение ИСПОЛНИТЕЛЯ не
  // состоялось: программа считается несработавшей, потраченные слоты
  // возвращаются (открываются обратно). Запись о закрытии слотов и
  // шаг на портал выкидываем из fx, чтобы клиенты не показывали лишнего.
  // (portalBlocked постороннего — напр. толкнули врага — слоты НЕ возвращает.
  // При p2p исполнитель — подключённый игрок: сравниваем с actor, а не owner.)
  if (fx.some(f => f.type === 'portalBlocked' && f.playerId === actor.id)) {
    for (const i of payload.indices) state.slots[i].closed = false;
    const kept = fx.filter(f =>
      !(f.type === 'slotsClosed' && f.playerId === player.id) &&
      !(f.type === 'move' && f.playerId === actor.id));
    fx.length = 0; fx.push(...kept);
  }

  // Матрица (удача на 2 бита): «сквозное» движение тратится первой картой передвижения.
  if (player.statuses.moveGhost && prog.kind === 'move') player.statuses.moveGhost = false;

  return { ok: true, fx };
}

// Общее применение эффекта + пост-эффекты (сломанная программа, сгорание).
// actor — кто «исполняет» программу; owner/card — чья карта (для сгорания).
function applyEffect(state, actor, prog, effectiveProg, payload, fx, owner, card) {
  if (payload.violenceMode === 'asMove' && actor.statuses.violence) {
    movePlayer(state, actor, payload.target.x, payload.target.y, fx);
  } else if (payload.violenceMode === 'asDamage' && actor.statuses.violence) {
    const t = payload.target;
    // По игроку срезку урона (провал Матрицы 5+) делает dealDamage по _dmgCut;
    // копия через dealDamage не проходит — срезаем вручную.
    if (t.copyKey) damageCopy(state, t.copyKey, effectiveProg.damage - (state._dmgCut ? 1 : 0), actor, fx);
    else fx.push(...dealDamage(state, getPlayer(state, t.playerId), effectiveProg.damage, actor));
  } else if (payload.target && payload.target.copyKey) {
    // Провал Матрицы (5+) срезает и урон по копии (1 уже заблокирован в useProgram).
    const dmg = (prog.damage || 0) - (state._dmgCut ? 1 : 0);
    damageCopy(state, payload.target.copyKey, dmg, actor, fx);
  } else if (payload.target && payload.target.swapCopy) {
    // Обмен местами с копией: дальность не ограничена.
    const c = copyOf(state, actor.id);
    if (c) {
      const [cx, cy] = c.key.split(',').map(Number);
      delete state.copies[c.key];
      const from = { ...actor.pos };
      state.copies[key(from.x, from.y)] = c.obj;
      actor.pos = { x: cx, y: cy };
      fx.push({ type: 'swapCopy', playerId: actor.id, x: cx, y: cy });
      // Клетка, откуда ушёл игрок, могла быть порталом — копия реагирует.
      resolveCopyCell(state, key(from.x, from.y), fx);
      triggerAimbots(state, actor, fx);
    }
  } else {
    EFFECTS[prog.id](state, actor, payload.target || {}, fx, payload);
  }
  fx.push({ type: 'programUsed', playerId: actor.id, progId: prog.id });

  // Кустарный интерфейс: сломанная программа бьёт ИСПОЛНИТЕЛЯ ПОСЛЕ эффекта.
  if (card.broken && actor.alive) {
    fx.push(...dealDamage(state, actor, 2, actor, { self: true }));
  }

  // Резервное питание сгорает после использования.
  if (prog.burns) {
    owner.hand = owner.hand.filter(c => c.uid !== card.uid);
    fx.push({ type: 'burned', playerId: owner.id, uid: card.uid });
  }
}

// Ответ подключённого по peer-to-peer игрока: он выбрал цель за активного.
// (Старый resolveP2p удалён: цель теперь всегда выбирает владелец карты,
// а дальность/видимость считаются от подключённого — прямо в useProgram.)

// ---------------------------------------------------------------------------
// 9.5. Кустарный интерфейс и разлом данных
// ---------------------------------------------------------------------------
// Кустарный интерфейс: раз за СВОЙ ход игрок может перевернуть один открытый
// бит слота (0↔1), заплатив 1 ХП. Перевёрнутый слот помечается glitched —
// на клиенте он глитчит, как сломанные программы. Флаг сбрасывается в endTurn.
function flipSlotBit(state, playerId, index) {
  const fx = [];
  const player = currentPlayer(state);
  if (!player || player.id !== playerId || state.over) return { ok: false, error: 'Сейчас не ваш ход.', fx };
  if (player.interfaceId !== 'home') return { ok: false, error: 'Переворачивать биты умеет только кустарный интерфейс.', fx };
  if (player.statuses.homeFlipUsed) return { ok: false, error: 'Бит уже перевёрнут в этом ходу — только раз за ход.', fx };
  const s = state.slots && state.slots[index];
  if (!s || s.closed) return { ok: false, error: 'Этот слот недоступен.', fx };
  s.value = s.value ? 0 : 1;
  s.glitched = true; // визуальный глитч слота до конца хода (слоты перегенерируются)
  player.statuses.homeFlipUsed = true;
  state.slotsUsed = true; // бит тронут — ставка Матрицы уже недоступна
  fx.push({ type: 'bitFlip', playerId, index, value: s.value });
  // Цена — 1 ХП: это самоуровн, защиты молчат (как у сломанных программ).
  fx.push(...dealDamage(state, player, 1, player, { self: true }));
  return { ok: true, fx };
}

// Разлом данных: стоящий на нём игрок кладёт в разлом одну ЦЕЛУЮ программу —
// она становится сломанной (минус один выбранный бит потребления, -2 ХП при
// использовании — как обычная сломанная). Каждый разлом срабатывает ОДИН раз
// на игрока (usedBy), для остальных он остаётся рабочим.
function useRift(state, playerId, { uid, removeIndex } = {}) {
  const fx = [];
  const player = getPlayer(state, playerId);
  if (!player || !player.alive || !player.pos || state.over) return { ok: false, error: 'Разлом недоступен.', fx };
  const obj = objectAt(state, player.pos.x, player.pos.y);
  if (!obj || obj.type !== 'rift') return { ok: false, error: 'Вы не стоите на разломе данных.', fx };
  obj.usedBy = obj.usedBy || [];
  if (obj.usedBy.includes(playerId)) return { ok: false, error: 'Этот разлом для вас уже исчерпан.', fx };
  const card = player.hand.find(c => c.uid === uid);
  if (!card) return { ok: false, error: 'Программа не найдена в руке.', fx };
  if (card.broken) return { ok: false, error: 'Программа уже сломана — разлом её не возьмёт.', fx };
  if (card.consumption.length < 2) return { ok: false, error: 'У программы и так минимальное потребление.', fx };
  const idx = Math.min(Math.max(0, removeIndex | 0), card.consumption.length - 1);
  card.consumption = card.consumption.slice(0, idx) + card.consumption.slice(idx + 1);
  card.broken = true;
  obj.usedBy.push(playerId);
  const prog = PROGRAM_MAP[card.progId];
  fx.push({ type: 'riftUsed', playerId, progName: prog ? prog.name : card.progId, consumption: card.consumption });
  return { ok: true, fx };
}

// ---------------------------------------------------------------------------
// 10. Ходы
// ---------------------------------------------------------------------------
// Переход очереди к следующему живому игроку (без начала его хода).
function advanceTurnIndex(state, fx) {
  const total = state.order.length;
  for (let i = 0; i < total; i++) {
    state.turnIndex = (state.turnIndex + 1) % total;
    if (state.turnIndex === 0) {
      state.round++;
      expireTimedObjects(state, fx);
      tickAntivirus(state, fx);
      // Режим захвата: каждый раунд у КодШифра новое случайное потребление.
      if (state.settings.mode === 'capture') {
        state.cipherConsumption = rollCipherConsumption(state.settings);
        fx.push({ type: 'cipherReroll', consumption: state.cipherConsumption });
      }
    }
    const p = currentPlayer(state);
    if (p && p.alive) break;
  }
}

function startTurn(state) {
  const fx = [];
  let rebootSkips = 0; // защита от вечного цикла перезагрузок
  for (;;) {
    const player = currentPlayer(state);
    if (!player) return fx;

    // Эффект зоны под ногами срабатывает ДО истечения защитных статусов:
    // «AI защита» действует до начала хода, а старт хода — это и есть
    // клетка под ногами. Так AI-защита реально глушит лечащие/наносящие
    // зоны («блокирует даже помощь»), а Брандмауэр может поглотить урон зоны.
    const zone = player.pos && objectAt(state, player.pos.x, player.pos.y);
    if (zone && zone.walkable && zone.effect && zone.effect.kind !== 'none') {
      if (zone.effect.kind === 'heal') fx.push(...heal(state, player, zone.effect.amount, { env: true }));
      if (zone.effect.kind === 'damage') fx.push(...dealDamage(state, player, zone.effect.amount, null, { env: true }));
      if (zone.effect.kind === 'power') {
        player.powerDelta += zone.effect.amount;
        fx.push({ type: 'powerSteal', targetId: player.id, amount: -zone.effect.amount });
      }
      if (zone.effect.kind === 'teleport') {
        const dest = randomFreeCell(state);
        if (dest) {
          player.pos = dest;
          fx.push({ type: 'teleport', playerId: player.id, x: dest.x, y: dest.y });
        }
      }
    }

    // Истекают статусы «до вашего следующего хода».
    player.statuses.aiDefense = false;
    player.statuses.incognito = false;
    player.statuses.aimbot = false;
    player.statuses.firewall = 0;  // несгоревшие стаки Брандмауэра пропадают
    player.statuses.torrent = 0;   // несработавшие стаки Торрента пропадают

    // Истекают временные битые пиксели этого игрока.
    for (const k of Object.keys(state.map.objects)) {
      const o = state.map.objects[k];
      if (o.temp && o.ownerId === player.id) delete state.map.objects[k];
    }

    // Никого не осталось в живых (например, самоубийство в отладочном режиме).
    if (!state.over && !state.players.some(p => p.alive)) {
      endGame(state, fx, null);
      return fx;
    }

    if (state.over) return fx;
    if (!player.alive) { advanceTurnIndex(state, fx); continue; }

    // 0 мощности — перезагрузка интерфейса, ход пропускается.
    if (powerOf(player) <= 0) {
      player.powerDelta = 0;
      fx.push({ type: 'reboot', playerId: player.id });
      rebootSkips++;
      // Если перезагружаются ВСЕ живые игроки подряд (напр., у всех базовая
      // мощность 0 через отладку) — матч не может продолжаться: ничья.
      if (rebootSkips >= state.players.filter(p => p.alive).length) {
        endGame(state, fx, null);
        return fx;
      }
      advanceTurnIndex(state, fx);
      continue;
    }

    // Генерация слотов. Если прошлый ход закончился в перегреве — часть слотов
    // появляется ПЕРЕГРЕТЫМИ: такой слот живёт один ход, незакрытый бьёт по
    // владельцу двойным уроном и не учитывается повторным перегревом.
    const n = powerOf(player);
    state.slots = Array.from({ length: n }, () => ({ value: Math.random() < 0.5 ? 0 : 1, closed: false }));
    const hot = Math.min(player.statuses.overheatBonus || 0, n);
    if (hot > 0) {
      const idx = state.slots.map((_, i) => i);
      for (let k = 0; k < hot; k++) {
        const j = k + Math.floor(Math.random() * (idx.length - k));
        [idx[k], idx[j]] = [idx[j], idx[k]];
        state.slots[idx[k]].overheated = true;
      }
      fx.push({ type: 'slotsHot', playerId: player.id, amount: hot });
    }
    player.statuses.overheatBonus = 0;
    state.slotsUsed = false;   // слоты свежие — ставка Матрицы снова доступна
    state.pendingScan = null;  // страховка: окно сканера живёт только в свой ход
    fx.push({ type: 'turnStart', playerId: player.id, round: state.round });
    return fx;
  }
}

function endTurn(state, playerId) {
  const fx = [];
  const player = currentPlayer(state);
  if (!player || player.id !== playerId || state.over) return { ok: false, fx };

  // Незакрытые слоты текущего хода: обычные и ПЕРЕГРЕТЫЕ считаются отдельно.
  const unclosed = state.slots ? state.slots.filter(s => !s.closed && !s.overheated).length : 0;
  const hotUnclosed = state.slots ? state.slots.filter(s => !s.closed && s.overheated).length : 0;
  // Перегретые слоты всегда бьют по владельцу двойным уроном (даже в перегреве,
  // даже под «Сторонним айпи» — это собственное горящее железо).
  if (hotUnclosed > 0) {
    fx.push({ type: 'overheatBurn', playerId: player.id, amount: hotUnclosed * 2 });
    fx.push(...dealDamage(state, player, hotUnclosed * 2, player, { self: true }));
  }

  // peer-to-peer действует до конца хода владельца связи.
  player.statuses.p2pTarget = null;

  // Кустарный интерфейс: переворот бита снова доступен в следующий ход.
  player.statuses.homeFlipUsed = false;

  // Украденная/бонусная мощность возвращается после хода игрока...
  player.powerDelta = 0;

  // ...но жертва «Андервольтинга» вступает в силу только теперь: минус
  // ляжет на СЛЕДУЮЩИЙ ход игрока (слотов будет меньше), а в конце того
  // хода эта строка снова обнулит powerDelta — мощность вернётся.
  if (player.statuses.undervoltPenalty) {
    player.powerDelta -= player.statuses.undervoltPenalty;
    player.statuses.undervoltPenalty = 0;
  }

  if (player.statuses.overheat) {
    // ...а перегрев военного интерфейса даёт бонус на следующий ход: незакрытые
    // ОБЫЧНЫЕ слоты превращаются в перегретые слоты следующего хода.
    player.statuses.overheat = false;
    if (unclosed > 0) {
      player.powerDelta += unclosed;
      player.statuses.overheatBonus += unclosed;
      fx.push({ type: 'overheatBoost', playerId: player.id, amount: unclosed });
    }
  } else if (unclosed > 0) {
    if (player.statuses.thirdPartyIp) {
      // Сторонний айпи: урона от незакрытых слотов НЕТ. Вместо него выбранный
      // при активации игрок получает +мощность, равную их числу (на след. ход).
      // Анти-накопление: если у цели в руке есть свой «Сторонний айпи» — он
      // блокируется до конца её следующего хода (цепочки накопления слотов
      // разрываются: получил бонус — сам раздать не можешь).
      const target = getPlayer(state, player.statuses.thirdPartyIp);
      if (target && target.alive) {
        target.powerDelta += unclosed;
        const hadTpi = target.hand.some(c => c.progId === 'third-party-ip');
        if (hadTpi) target.statuses.tpiBlocked = true;
        fx.push({ type: 'powerBoost', targetId: target.id, amount: unclosed, sourceId: player.id, tpiBlocked: hadTpi });
      }
    } else {
      fx.push(...dealDamage(state, player, unclosed, player, { self: true }));
    }
  }

  player.statuses.thirdPartyIp = false;
  player.statuses.tpiBlocked = false; // блок действует ровно один свой ход
  player.statuses.violence = false;

  // Матрица: эффекты ставки живут один ход.
  player.statuses.matrixBetDone = false;
  player.statuses.moveGhost = false;
  player.statuses.moveMinus = false;
  player.statuses.dmgMinus = false;
  player.statuses.corpOnceUid = null;
  player.statuses.matrixDouble = false;
  player.statuses.matrixSplash = false;
  state.pendingScan = null; // перехват сканером — только в ход сканирующего
  // Неразыгранный перехват сгорает в конце хода.
  if (player.hand.some(c => c.stolen)) {
    player.hand = player.hand.filter(c => !c.stolen);
    fx.push({ type: 'log', text: `⛨ неразыгранный перехват ${player.name} рассеялся` });
  }

  state.slots = null;

  if (!state.over) advanceTurn(state, fx);
  return { ok: true, fx };
}

function advanceTurn(state, fx) {
  if (state.over) return;
  // Никого в живых — матч завершён (страховка от бесконечного цикла).
  if (!state.players.some(p => p.alive)) {
    endGame(state, fx, null);
    return;
  }
  advanceTurnIndex(state, fx);
  fx.push(...startTurn(state));
}

// Временные объекты (roundsLeft > 0) живут указанное число раундов.
// Сюда же попадает куб Data_Error (2 раунда).
function expireTimedObjects(state, fx) {
  let changed = false;
  for (const k of Object.keys(state.map.objects)) {
    const o = state.map.objects[k];
    if (o.roundsLeft > 0) {
      o.roundsLeft--;
      if (o.roundsLeft === 0) { delete state.map.objects[k]; changed = true; }
    }
  }
  if (changed) fx.push({ type: 'walls', ownerId: null });
}


// ---------------------------------------------------------------------------
// 10.5 АНТИВИРУС — механика против затягивания матча
// ---------------------------------------------------------------------------
// Просыпается на заданном раунде (настройка лобби, по умолчанию 5) и дальше
// мешает ВСЕМ игрокам каждый раунд. Тип 'random' разрешается при пробуждении.
const ANTIVIRUS_TYPES = ['shuffle', 'damage', 'ban', 'teleport'];
const ANTIVIRUS_NAMES = {
  shuffle: 'ПЕРЕСБОРКА КАРТЫ',
  damage: 'ПЕРЕГРУЗКА СЕТИ',
  ban: 'КАРАНТИН ПРОГРАММ',
  teleport: 'ПРЫЖКИ УЗЛОВ',
};

function tickAntivirus(state, fx) {
  const av = state.antivirus;
  if (!av || !(av.round > 0) || state.over || state.round < av.round) return;
  if (!av.active) {
    // Пробуждение: анонс + первый удар.
    av.active = true;
    av.resolved = av.type === 'random'
      ? ANTIVIRUS_TYPES[Math.floor(Math.random() * ANTIVIRUS_TYPES.length)]
      : av.type;
    fx.push({ type: 'antivirus', text: `⚠ АНТИВИРУС ПРОСНУЛСЯ: ${ANTIVIRUS_NAMES[av.resolved]}` });
    if (av.resolved === 'shuffle') antivirusShuffle(state, fx);
    else if (av.resolved === 'ban') antivirusBan(state, fx);
    else if (av.resolved === 'teleport') antivirusTeleport(state, fx, true);
    else antivirusDamage(state, fx);
    return;
  }
  // Действующий антивирус: повторяющиеся эффекты каждый раунд.
  if (av.resolved === 'damage') antivirusDamage(state, fx);
  else if (av.resolved === 'ban' && (state.round - av.round) % 2 === 0) antivirusBan(state, fx);
  else if (av.resolved === 'teleport') antivirusTeleport(state, fx, false);
  // Пересборка карты — разовое событие при пробуждении.
}

// Перегрузка сети: всем живым по 1 урону каждый раунд (защиты работают).
function antivirusDamage(state, fx) {
  const alive = state.players.filter(p => p.alive);
  if (!alive.length) return;
  fx.push({ type: 'antivirus', text: '⚠ антивирус жжёт сеть: всем −1 ХП' });
  for (const pl of alive) fx.push(...dealDamage(state, pl, 1, null, { env: true }));
}

// Карантин: у каждого живого игрока сгорает случайная программа из руки.
function antivirusBan(state, fx) {
  for (const pl of state.players.filter(p => p.alive && p.hand.length)) {
    const i = Math.floor(Math.random() * pl.hand.length);
    const card = pl.hand.splice(i, 1)[0];
    const prog = PROGRAM_MAP[card.progId];
    fx.push({ type: 'antivirus', text: `⚠ карантин: у ${pl.name} изъята «${prog ? prog.name : card.progId}»` });
  }
}

// Прыжки узлов: при пробуждении разбрасывает всех, дальше — одного случайного.
function antivirusTeleport(state, fx, all) {
  const alive = state.players.filter(p => p.alive && p.pos);
  if (!alive.length) return;
  const victims = all ? alive : [alive[Math.floor(Math.random() * alive.length)]];
  for (const pl of victims) {
    const cell = randomFreeCell(state);
    if (!cell) continue;
    pl.pos = cell;
    fx.push({ type: 'antivirus', text: `⚠ прыжок узла: ${pl.name} перенесён в (${cell.x},${cell.y})` });
  }
}

// Пересборка: стены и мины перетасовываются по карте. Точки захвата, разломы,
// спауны и порталы не трогаем (пары порталов нельзя разрывать). Карта обязана
// остаться играбельной: все живые игроки и точки захвата — в одной связности.
function antivirusShuffle(state, fx) {
  const objs = state.map.objects;
  const movable = Object.entries(objs).filter(([, o]) => o.type === 'wall' || o.type === 'mine');
  if (!movable.length) return;
  const snapshot = JSON.parse(JSON.stringify(objs));
  const items = movable.map(([, o]) => o);
  for (const [k] of movable) delete objs[k];
  for (let attempt = 0; attempt < 80; attempt++) {
    const placed = [];
    let okAll = true;
    for (const o of items) {
      const cell = randomFreeCell(state);
      if (!cell) { okAll = false; break; }
      objs[key(cell.x, cell.y)] = o;
      placed.push(key(cell.x, cell.y));
    }
    if (okAll && mapPlayable(state)) {
      fx.push({ type: 'walls', ownerId: null });
      fx.push({ type: 'antivirus', text: '⚠ пересборка: рельеф карты изменился' });
      return;
    }
    for (const k of placed) delete objs[k];
  }
  state.map.objects = snapshot; // не получилось — оставляем старую карту
}

// (используется общий randomFreeCell(state, from, radius) из раздела карты)

// Проходимость: все живые игроки и все точки захвата связаны проходами.
function mapPlayable(state) {
  const seeds = [];
  for (const pl of state.players) if (pl.alive && pl.pos) seeds.push(pl.pos);
  for (const k of Object.keys(state.map.objects)) {
    const o = state.map.objects[k];
    if (o.type === 'point') { const [x, y] = k.split(',').map(Number); seeds.push({ x, y }); }
  }
  if (seeds.length < 2) return true;
  // BFS только по проходимости объектов (пешки стенами не считаются).
  const walk = (x, y) => {
    if (!inBounds(state, x, y)) return false;
    const o = objectAt(state, x, y);
    return !o || o.walkable;
  };
  const seen = new Set([key(seeds[0].x, seeds[0].y)]);
  let frontier = [seeds[0]];
  while (frontier.length) {
    const next = [];
    for (const c of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = c.x + dx, ny = c.y + dy, k = key(nx, ny);
        if (seen.has(k) || !walk(nx, ny)) continue;
        seen.add(k); next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
  }
  return seeds.every(s => seen.has(key(s.x, s.y)));
}

function toggleOverheat(state, playerId) {
  const player = currentPlayer(state);
  if (!player || player.id !== playerId) return { ok: false, error: 'Сейчас не ваш ход.' };
  if (player.interfaceId !== 'mil') return { ok: false, error: 'Перегрев доступен только военному интерфейсу.' };
  if (player.statuses.overheat) return { ok: false, error: 'Перегрев уже активен.' };
  player.statuses.overheat = true;
  return { ok: true, fx: [{ type: 'overheat', playerId }] };
}

// ---------------------------------------------------------------------------
// 11. Режим «Захват территории»
// ---------------------------------------------------------------------------
// Потребление КодШифра: случайная строка 0/1 случайной длины в заданном
// диапазоне (настраивается в лобби). Перевыпускается каждый раунд.
function rollCipherConsumption(settings) {
  const lo = Math.max(1, settings.captureLenMin || 3);
  const hi = Math.max(lo, settings.captureLenMax || 5);
  const len = lo + Math.floor(Math.random() * (hi - lo + 1));
  let s = '';
  for (let i = 0; i < len; i++) s += Math.random() < 0.5 ? '0' : '1';
  return s;
}

// Очки захвата для роста КодШифра и победы: в командном режиме считается
// СУММА очков всей команды, иначе — личные очки игрока.
function captureScoreOf(state, player) {
  if (state.settings.teamsEnabled && player.team != null) {
    return state.players.filter(p => p.team === player.team)
      .reduce((sum, p) => sum + (p.capturePoints || 0), 0);
  }
  return player.capturePoints || 0;
}

// Эффективное потребление КодШифра для конкретного игрока: базовая строка
// раунда + cipherGrow бит за каждые полные cipherStep уже набранных очков
// (оба числа настраиваются в лобби; 0/0 — рост выключен). Добавочные биты
// генерируются ДЕТЕРМИНИРОВАННО от базовой строки и числа очков, поэтому
// отображение на клиенте и проверка на сервере всегда совпадают.
function cipherFor(state, player) {
  let base = state.cipherConsumption;
  if (!base) base = state.cipherConsumption = rollCipherConsumption(state.settings);
  const grow = Math.max(0, state.settings.cipherGrow || 0);
  const step = Math.max(0, state.settings.cipherStep || 0);
  if (!grow || !step) return base;
  const pts = captureScoreOf(state, player);
  const extra = grow * Math.floor(pts / step);
  if (extra <= 0) return base;
  let seed = (state.round * 2654435761) >>> 0;
  for (let i = 0; i < base.length; i++) seed = (seed * 31 + base.charCodeAt(i)) >>> 0;
  seed = (seed + pts * 97) >>> 0;
  let out = base;
  for (let i = 0; i < extra; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0; // классический LCG
    out += (seed >>> 31) ? '1' : '0';
  }
  return out;
}

// Игрок стоит на ДОСТУПНОЙ ему точке контроля? Нейтральная точка
// (team == null) — для всех; командная (team 0..3) — только для своей
// команды (проверка работает только при включённом командном режиме).
function onControlPoint(state, player) {
  if (!player.pos) return false;
  const o = objectAt(state, player.pos.x, player.pos.y);
  if (!o || o.type !== 'point') return false;
  if (state.settings.teamsEnabled && o.team != null && player.team !== o.team) return false;
  return true;
}

// Розыгрыш КодШифра: +1 очко захвата. Карты в руке нет — она «живёт» на точке.
function useCipher(state, player, payload) {
  const fx = [];
  if (state.settings.mode !== 'capture') return { ok: false, error: 'Режим захвата выключен.', fx };
  if (!onControlPoint(state, player)) {
    // Отдельное сообщение, если игрок стоит на ЧУЖОЙ командной точке.
    const o = player.pos && objectAt(state, player.pos.x, player.pos.y);
    const foreign = o && o.type === 'point' && state.settings.teamsEnabled && o.team != null && o.team !== player.team;
    return { ok: false, error: foreign ? 'Эта точка контроля принадлежит другой команде.' : 'КодШифр доступен только на точке контроля.', fx };
  }
  const need = cipherFor(state, player); // базовая длина + рост от набранных очков
  const corp = player.interfaceId === 'corp';
  if (!validateSlotChoice(state.slots, payload.indices, need, corp)) {
    return { ok: false, error: 'Слоты не совпадают с потреблением КодШифра.', fx };
  }
  for (const i of payload.indices) state.slots[i].closed = true;
  state.slotsUsed = true; // КодШифр закрыл слоты — ставка Матрицы недоступна
  fx.push({ type: 'slotsClosed', indices: payload.indices, playerId: player.id });
  player.capturePoints++;
  const score = captureScoreOf(state, player); // в командном режиме — сумма команды
  fx.push({ type: 'captureScore', playerId: player.id, points: score, need: state.settings.capturePoints });
  fx.push({ type: 'log', text: `◈ ${player.name}: очко захвата (${score}/${state.settings.capturePoints})` });
  fx.push({ type: 'programUsed', playerId: player.id, progId: 'code-cipher' });
  if (score >= (state.settings.capturePoints || 3)) {
    endGame(state, fx, player, 'capture');
  }
  return { ok: true, fx };
}

// ---------------------------------------------------------------------------
// 11.6. Матричный интерфейс (ставка) и перехват сканером сети
// ---------------------------------------------------------------------------
// Есть ли среди ОТКРЫТЫХ слотов комбинация потребления (подряд; corp — по
// открытым подряд; идеальные слоты Матрицы считаются и 0, и 1).
// Возвращает индексы слотов или null. Используется сканером (перехват) —
// сама по себе слоты НЕ закрывает.
function findSlotRun(slots, consumption, corp) {
  if (!slots || !slots.length || !consumption) return null;
  const L = consumption.length;
  const fits = (idx) => idx.every((si, j) => {
    const s = slots[si];
    return s && !s.closed && (s.ideal || String(s.value) === consumption[j]);
  });
  if (corp) {
    const open = slots.map((s, i) => (s.closed ? -1 : i)).filter(i => i >= 0);
    for (let a = 0; a + L <= open.length; a++) {
      const idx = open.slice(a, a + L);
      if (fits(idx)) return idx;
    }
    return null;
  }
  for (let a = 0; a + L <= slots.length; a++) {
    const idx = Array.from({ length: L }, (_, j) => a + j);
    if (fits(idx)) return idx;
  }
  return null;
}

// Матричный интерфейс — СТАВКА: раз за свой ход, ДО использования слотов,
// игрок ставит целую программу (потребление от 2 бит; сломанные нельзя).
// Слоты перегенерируются; если среди новых битов есть комбинация поставленной
// карты — УДАЧА, иначе ПРОВАЛ. Эффект зависит от ДЛИНЫ потребления:
//   2 бита — удача: первое движение сквозь препятствия / провал: питание в 0,
//            перезагрузка, ход кончается сразу (к следующему мощность вернётся);
//   3 бита — удача: эта карта закрывает слоты как КОРП (раз) / провал: свои атаки бьют и тебя (½, окр. вверх);
//   4 бита — удача: первая атака бьёт вдвойне / провал: блок карты на раунд;
//   5+ бит — удача: ДЖЕКПОТ (+5 слотов, половина идеальные) / провал: дальность
//            передвижений и урон программ −1 (срезанные до нуля заблокированы).
// Поставленная карта НЕ сгорает — она остаётся в руке «на кону».
function matrixBet(state, playerId, uid) {
  const fx = [];
  const player = currentPlayer(state);
  if (!player || player.id !== playerId || state.over) return { ok: false, error: 'Сейчас не ваш ход.', fx };
  if (player.interfaceId !== 'matrix') return { ok: false, error: 'Ставки принимает только матричный интерфейс.', fx };
  if (player.statuses.matrixBetDone) return { ok: false, error: 'Ставка в этом ходу уже сделана.', fx };
  if (state.slotsUsed) return { ok: false, error: 'Ставка возможна только ДО использования слотов.', fx };
  const card = player.hand.find(c => c.uid === uid);
  if (!card) return { ok: false, error: 'Программа не найдена в руке.', fx };
  if (card.stolen) return { ok: false, error: 'Перехваченную программу поставить нельзя.', fx };
  if (card.broken) return { ok: false, error: 'Сломанную программу поставить нельзя.', fx };
  if (card.blockedUntilRound && state.round <= card.blockedUntilRound) return { ok: false, error: 'Эта программа заблокирована.', fx };
  if ((card.consumption || '').length < 2) return { ok: false, error: 'Ставка — от 2 бит потребления (программы на 1 бит не принимаются).', fx };

  const prog = PROGRAM_MAP[card.progId] || { name: card.progId };
  const len = card.consumption.length;
  player.statuses.matrixBetDone = true;

  // Перегенерация слотов (столько же, сколько было).
  const n = state.slots ? state.slots.length : powerOf(player);
  state.slots = Array.from({ length: n }, () => ({ value: Math.random() < 0.5 ? 0 : 1, closed: false }));
  const bits = state.slots.map(s => String(s.value)).join('');
  const luck = bits.includes(card.consumption);

  let effectText;
  if (luck) {
    if (len === 2) {
      player.statuses.moveGhost = true;
      effectText = 'УДАЧА: первое передвижение в этот ход пройдёт СКВОЗЬ препятствия (встать можно только на свободную клетку).';
    } else if (len === 3) {
      player.statuses.corpOnceUid = card.uid;
      effectText = `УДАЧА: «${prog.name}» в этот ход закроет слоты как корпоративный интерфейс (один раз).`;
    } else if (len === 4) {
      player.statuses.matrixDouble = true;
      effectText = 'УДАЧА: первая атакующая программа в этот ход нанесёт ДВОЙНОЙ урон.';
    } else {
      // ДЖЕКПОТ: +5 слотов, половина всех слотов — идеальные (считаются и 0, и 1).
      for (let i = 0; i < 5; i++) state.slots.push({ value: Math.random() < 0.5 ? 0 : 1, closed: false });
      const idx = state.slots.map((_, i) => i);
      const half = Math.floor(state.slots.length / 2);
      for (let k = 0; k < half; k++) {
        const j = k + Math.floor(Math.random() * (idx.length - k));
        [idx[k], idx[j]] = [idx[j], idx[k]];
        state.slots[idx[k]].ideal = true;
      }
      effectText = '★ ДЖЕКПОТ: +5 слотов, половина всех слотов — ИДЕАЛЬНЫЕ (считаются и 0, и 1).';
    }
  } else {
    // Провалы зеркально переставлены: самый тяжёлый — у самой дешёвой ставки.
    if (len === 2) {
      // Критический провал: питание в ноль СРАЗУ, экран перезагрузки, ход
      // сгорает немедленно (crash → сервер завершает ход). К следующему ходу
      // мощность восстанавливается по обычным правилам (endTurn обнулит delta).
      player.powerDelta = -player.basePower;
      effectText = 'КРИТИЧЕСКИЙ ПРОВАЛ: питание в нуле — перезагрузка интерфейса, ход сгорает.';
    } else if (len === 3) {
      player.statuses.matrixSplash = true;
      effectText = 'ПРОВАЛ: ваши атаки в этот ход бьют и вас — половиной урона (округление вверх).';
    } else if (len === 4) {
      card.blockedUntilRound = state.round + 1;
      effectText = `ПРОВАЛ: «${prog.name}» заблокирована до конца следующего раунда.`;
    } else {
      player.statuses.moveMinus = true;
      player.statuses.dmgMinus = true;
      effectText = 'ПРОВАЛ: дальность передвижений и урон программ −1 (срезанные до нуля заблокированы).';
    }
  }
  fx.push({
    type: 'matrixBet', playerId, cardName: prog.name, consumption: card.consumption,
    luck, len, slots: state.slots, effectText,
  });
  fx.push({ type: 'log', text: `🎰 МАТРИЦА: ${player.name} поставил «${prog.name}» — ${luck ? 'УДАЧА' : 'ПРОВАЛ'}` });
  // Критический провал: слотов больше нет, экран перезагрузки, ход завершается.
  const crash = !luck && len === 2;
  if (crash) {
    state.slots = [];
    fx.push({ type: 'reboot', playerId });
  }
  return { ok: true, fx, crash };
}

// Перехват со Сканера сети: карта врага блокируется до конца следующего
// раунда, а сканирующий получает её копию в руку ДО КОНЦА ХОДА и разыгрывает
// её как свою (со своих слотов). Не можешь оплатить потребление своими
// открытыми слотами — перехвата нет и карта у врага НЕ блокируется.
function scanSteal(state, playerId, targetId, cardUid) {
  const fx = [];
  const player = currentPlayer(state);
  if (!player || player.id !== playerId || state.over) return { ok: false, error: 'Сейчас не ваш ход.', fx };
  const ps = state.pendingScan;
  if (!ps || ps.playerId !== playerId || ps.targetId !== targetId) {
    return { ok: false, error: 'Сначала просканируйте цель сканером сети.', fx };
  }
  const victim = getPlayer(state, targetId);
  if (!victim || !victim.alive) return { ok: false, error: 'Цель недоступна.', fx };
  const card = victim.hand.find(c => c.uid === cardUid);
  if (!card) return { ok: false, error: 'Программа не найдена в руке цели.', fx };
  if (card.broken) return { ok: false, error: 'Сломанную программу перехватить нельзя.', fx };
  if (card.stolen) return { ok: false, error: 'Перехваченную программу перехватить нельзя.', fx };
  if (card.blockedUntilRound && state.round <= card.blockedUntilRound) return { ok: false, error: 'Эта программа уже заблокирована.', fx };
  const corp = player.interfaceId === 'corp';
  if (!findSlotRun(state.slots, card.consumption, corp)) {
    return { ok: false, error: `Ваши открытые слоты не покрывают потребление «${(PROGRAM_MAP[card.progId] || {}).name || ''}» (${card.consumption}) — блокировка отменена.`, fx };
  }
  card.blockedUntilRound = state.round + 1;
  player.hand.push({
    uid: 'steal-' + Math.random().toString(36).slice(2, 9),
    progId: card.progId, consumption: card.consumption, stolen: true,
  });
  state.pendingScan = null; // один скан — один перехват
  const prog = PROGRAM_MAP[card.progId] || { name: card.progId };
  fx.push({ type: 'scanSteal', playerId, targetId, cardName: prog.name });
  fx.push({ type: 'log', text: `⛨ ${player.name} перехватил «${prog.name}» у ${victim.name}: у цели карта заблокирована до конца следующего раунда` });
  return { ok: true, fx };
}

// ---------------------------------------------------------------------------
// 12. Сериализация состояния для конкретного игрока (Инкогнито скрывает позицию)
// ---------------------------------------------------------------------------
function serialize(state, forPlayerId) {
  const me = getPlayer(state, forPlayerId);
  // КодШифр отображается отдельно от руки — только у стоящего на точке.
  let cipher = null;
  if (state.settings.mode === 'capture' && me && me.alive && !state.over && onControlPoint(state, me)) {
    cipher = { consumption: cipherFor(state, me) }; // с учётом роста от очков
  }
  return {
    settings: state.settings,
    order: state.order,
    turnIndex: state.turnIndex,
    round: state.round,
    over: state.over,
    winnerId: state.winnerId,
    winnerTeam: state.winnerTeam,
    slots: state.slots,
    map: state.map,
    copies: state.copies, // цифровые копии — оверлей поверх объектов
    setupStage: state.setupStage || 'build',
    mapDone: !!state.mapDone, // хост закончил карту (этап карты — ДО сбора рук)
    cipher,
    antivirus: state.antivirus,
    players: state.players.map(p => {
      const hidden = p.statuses.incognito && p.id !== forPlayerId;
      return {
        id: p.id, name: p.name, color: p.color, interfaceId: p.interfaceId,
        team: p.team,
        hp: p.hp, basePower: p.basePower, power: powerOf(p), alive: p.alive,
        pos: hidden ? null : p.pos,
        incognito: p.statuses.incognito,
        statuses: p.statuses,
        capturePoints: p.capturePoints || 0,
        handCount: p.hand.length,
        hand: p.id === forPlayerId ? p.hand : undefined,
        setupReady: p.setupReady,
        debug: !!p.debug,
      };
    }),
  };
}

module.exports = {
  createGame, createPlayer, serialize,
  useProgram, endTurn, startTurn, toggleOverheat, flipSlotBit, useRift,
  matrixBet, scanSteal, findSlotRun,
  bfsReachable, hasLineOfSight, manhattan, isFree, objectAt, playerAt, inBounds,
  getPlayer, currentPlayer, powerOf, key, copyOf, copyAt, spawnCells,
  rollCipherConsumption, onControlPoint, cipherFor, captureScoreOf,
  CIPHER_UID, AI_JEALOUS,
};
