// ============================================================================
// ШИФРОПАНК — визуальные и звуковые эффекты (трещины, окна ошибок, оверлеи)
// ============================================================================
const FX = (() => {
  const DEATH_PHRASES = [
    '«Твой разум растворился в цифровой пустоте. Даже логи не вспомнят твоего имени.»',
    '«Нейроны сгорели дотла. Сеть не прощает ошибок.»',
    '«Прошивка мозга повреждена beyond repair. Добро пожаловать в небытие, нетраннер.»',
    '«Плосколинейная смерть. Твой сигнал затерялся между секторами.»',
    '«Корпорации даже не заметят, что тебя больше нет.»',
    '«Синапсы отключены. Последняя мысль: 01100100 01100101 01100001 01100100.»',
  ];
  const WIN_PHRASES = [
    'Все соперники стёрты из сети. Ты — последний сигнал в мёртвом эфире.',
    'Сектор зачищен. Легенды о тебе будут шептаться в чёрных каналах.',
    'Полный контроль над сетью. Так рождаются призраки.',
  ];

  // Реплики ИИ при активации «АИ защита» (окно для активировавшего).
  const AI_ACTIVATION_PHRASES = [
    'Защитный протокол активирован. Никто не тронет моего оператора.',
    'Я вижу все входящие пакеты. Попробуй только посягнуть.',
    'Оператор под моей опекой. Угрозы будут нейтрализованы.',
    'Сканирование периметра... Угроз: 0. Пока что.',
    'Мои алгоритмы быстрее твоих намерений, нетраннер.',
    'Доступ к оператору закрыт. Обратитесь в поддержку. Шутка. Поддержки нет.',
  ];

  // Окно ИИ-помощника при включении «АИ защита» (только у активировавшего).
  function showAiWindow(aiName) {
    const phrase = AI_ACTIVATION_PHRASES[Math.floor(Math.random() * AI_ACTIVATION_PHRASES.length)];
    const div = document.createElement('div');
    div.className = 'err-window ai-window';
    div.style.left = '50%'; div.style.top = '16%';
    div.style.transform = 'translateX(-50%)';
    div.innerHTML = `<div class="err-title"><span>AI // ${esc(aiName)}</span><span>✕</span></div>
      <div class="err-body">${esc(phrase)}</div>`;
    $('fx-layer').appendChild(div);
    setTimeout(() => div.remove(), 3600);
  }

  let audioCtx = null;
  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  // Звук ошибки (отказ в использовании программы)
  function errorBeep() {
    try {
      const c = ctx();
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(220, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(70, c.currentTime + 0.25);
      g.gain.setValueAtTime(0.12, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.3);
      o.connect(g).connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.3);
    } catch (e) { /* звук не критичен */ }
  }

  // --- синтезатор ретро-бипов ---
  function beep(freq, dur = 0.08, type = 'square', vol = 0.08, delay = 0) {
    try {
      const c = ctx();
      const t = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* звук не критичен */ }
  }

  const sfx = {
    click:   () => beep(900, 0.05, 'square', 0.045),
    slot:    () => beep(700, 0.05, 'square', 0.06),
    success: () => { beep(520, 0.07); beep(880, 0.1, 'square', 0.08, 0.08); },
    move:    () => beep(300, 0.06, 'triangle', 0.08),
    damage:  () => { beep(160, 0.16, 'sawtooth', 0.12); beep(110, 0.14, 'sawtooth', 0.1, 0.08); },
    heal:    () => { beep(520, 0.1, 'sine', 0.09); beep(780, 0.14, 'sine', 0.09, 0.1); },
    turn:    () => { beep(660, 0.07); beep(660, 0.09, 'square', 0.08, 0.11); },
    chat:    () => beep(1250, 0.04, 'sine', 0.035),
    blocked: () => { beep(1100, 0.06, 'triangle', 0.09); beep(1100, 0.06, 'triangle', 0.07, 0.08); },
    walls:   () => beep(220, 0.09, 'square', 0.08),
    death:   () => { beep(400, 0.3, 'sawtooth', 0.12); beep(200, 0.45, 'sawtooth', 0.12, 0.25); beep(90, 0.8, 'sawtooth', 0.12, 0.5); },
    revive:  () => { beep(300, 0.1, 'sine', 0.1); beep(500, 0.1, 'sine', 0.1, 0.1); beep(800, 0.22, 'sine', 0.1, 0.2); },
    win:     () => { beep(523, 0.12, 'square', 0.09); beep(659, 0.12, 'square', 0.09, 0.12); beep(784, 0.12, 'square', 0.09, 0.24); beep(1046, 0.3, 'square', 0.09, 0.36); },
  };

  // Короткое уведомление
  function toast(text) {
    const div = document.createElement('div');
    div.className = 'err-window';
    div.style.left = '50%'; div.style.top = '12%';
    div.style.transform = 'translateX(-50%)';
    div.innerHTML = `<div class="err-title"><span>СИСТЕМА</span><span>✕</span></div><div class="err-body">${esc(text)}</div>`;
    $('fx-layer').appendChild(div);
    setTimeout(() => div.remove(), 2400);
  }

  // Трещина интерфейса при уроне
  function crack(permanent) {
    const o = $('crack-overlay');
    if (permanent) { o.classList.add('perma'); o.classList.remove('show'); return; }
    o.classList.add('show');
    setTimeout(() => o.classList.remove('show'), 900);
  }
  function clearCracks() {
    $('crack-overlay').classList.remove('show', 'perma');
  }

  // --- полноэкранный глитч (урон, критические сбои) ---
  // Интерфейс «ломается» на пару секунд: экран дёргается, полосы-помехи
  // разъезжаются, по экрану сыплются глитч-символы.
  const GLITCH_CHARS = '▓▒░╳#%&@?!01';
  function glitchBurst(dur = 1200, heavy = true) {
    const layer = $('fx-layer');
    if (!layer) return;
    const made = [];
    if (heavy) document.body.classList.add('dmg-glitch');
    // горизонтальные полосы-помехи
    const slices = heavy ? 8 : 4;
    for (let i = 0; i < slices; i++) {
      const s = document.createElement('div');
      s.className = 'glitch-slice';
      s.style.top = (Math.random() * 100) + '%';
      s.style.height = (3 + Math.random() * 24) + 'px';
      s.style.background = ['rgba(0,255,156,.45)', 'rgba(255,34,68,.45)', 'rgba(41,182,246,.4)', 'rgba(255,255,255,.22)'][i % 4];
      s.style.animationDelay = (Math.random() * 0.2) + 's';
      s.style.animationDuration = (0.09 + Math.random() * 0.14) + 's';
      layer.appendChild(s); made.push(s);
    }
    // разбросанные глитч-символы
    const glyphs = heavy ? 16 : 6;
    for (let i = 0; i < glyphs; i++) {
      const g = document.createElement('span');
      g.className = 'glitch-glyph';
      g.textContent = GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
      g.style.left = (Math.random() * 96) + '%';
      g.style.top = (Math.random() * 96) + '%';
      g.style.color = i % 3 === 0 ? 'var(--red)' : (i % 3 === 1 ? 'var(--green)' : 'var(--amber)');
      g.style.fontSize = (12 + Math.random() * 26) + 'px';
      g.style.animationDuration = (0.12 + Math.random() * 0.2) + 's';
      layer.appendChild(g); made.push(g);
    }
    setTimeout(() => {
      document.body.classList.remove('dmg-glitch');
      made.forEach(el => el.remove());
    }, dur);
  }

  // Ливень окон ошибок при краже мощности (как при заражении вирусом)
  function errorStorm() {
    const layer = $('fx-layer');
    const msgs = ['ОШИБКА ДОСТУПА', 'ПОТЕРЯ МОЩНОСТИ', 'НЕСАНКЦИОНИРОВАННЫЙ ДОСТУП', 'СБОЙ ЯДРА', 'УТЕЧКА ДАННЫХ', 'ВЗЛОМ ШИНЫ', 'МОЩНОСТЬ ПЕРЕХВАЧЕНА', 'КРИТИЧЕСКИЙ СБОЙ'];
    const count = 12 + Math.floor(Math.random() * 7); // 12–18 окон
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const div = document.createElement('div');
        div.className = 'err-window virus';
        div.style.left = (3 + Math.random() * 68) + '%';
        div.style.top = (3 + Math.random() * 68) + '%';
        div.innerHTML = `<div class="err-title"><span>${msgs[Math.floor(Math.random() * msgs.length)]}</span><span>✕</span></div>
          <div class="err-body">код 0x${Math.floor(Math.random() * 65535).toString(16).padStart(4, '0')} — мощность перехвачена</div>`;
        layer.appendChild(div);
        setTimeout(() => div.remove(), 1500 + Math.random() * 1500); // сами исчезают
      }, i * 90);
    }
    glitchBurst(900);
    errorBeep();
  }

  function showDeath() {
    hideReboot(); // смерть важнее перезагрузки
    $('death-phrase').textContent = DEATH_PHRASES[Math.floor(Math.random() * DEATH_PHRASES.length)];
    $('overlay-death').classList.add('show');
  }
  function showWin(winnerName, iWon, opts = {}) {
    $('overlay-death').classList.remove('show');
    hideReboot(); // конец матча закрывает экран перезагрузки
    // Заголовок: личная победа, чужая победа или победа команды.
    $('win-title').textContent = opts.title || (iWon ? 'СЕТЬ ПОКОРЕНА' : `${winnerName} ЗАХВАТИЛ СЕТЬ`);
    $('win-phrase').textContent = opts.phrase || WIN_PHRASES[Math.floor(Math.random() * WIN_PHRASES.length)];
    $('overlay-win').classList.add('show');
  }
  function hideOverlays() {
    for (const id of ['overlay-death', 'overlay-win', 'overlay-reboot']) $(id).classList.remove('show');
    stopReboot();
    clearCracks();
  }

  // ---- Экран перезагрузки (0 мощности) ----
  // Бегущий cmd-поток на фоне + окно с последовательностью загрузки и
  // бегущим индикатором. Живёт, пока ход не вернётся к игроку (hideReboot).
  let rebootTimer = null;
  const REBOOT_BOOT = [
    'NEURO-LINK BIOS v4.7 — аварийная перезагрузка',
    '[ OK ] ядро интерфейса',
    '[ OK ] шина данных .......... 100 Мбит/с',
    '<span class="acc-red">[FAIL] блок питания ......... 0 В</span>',
    '[ OK ] резервный контур ..... активен',
    '[ .. ] перезапуск драйвера слотов',
    '[ OK ] слоты ................ инициализированы',
    '[ OK ] карта сектора ........ синхронизирована',
    '[ OK ] канал связи .......... в сети',
    '[ .. ] подзарядка конденсаторов...',
    'Питание вернётся к началу вашего следующего хода.',
    'Не отключайте нейролинк<span class="blink">█</span>',
  ];
  function rebootBgLine() {
    const hex = () => Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0').toUpperCase();
    const bits = () => Array.from({ length: 8 }, () => Math.random() < .5 ? '0' : '1').join('');
    const T = [
      () => `0x${hex()}  ${bits()} ${bits()}  ACK`,
      () => `ping node-${Math.floor(Math.random() * 16)} ... ${Math.random() < .3 ? 'timeout' : 'ok'}`,
      () => `TRACE ${hex()} :: sector-sync ... OK`,
      () => `MEM ${Math.floor(Math.random() * 640)}K OK`,
      () => `C:\\SHIFROPANK> ${['recover', 'mount slots', 'sync map', 'route /flush'][Math.floor(Math.random() * 4)]}`,
      () => `dump 0x${hex()} > nul`,
    ];
    return T[Math.floor(Math.random() * T.length)]();
  }
  function stopReboot() {
    if (rebootTimer) { clearInterval(rebootTimer); rebootTimer = null; }
  }
  function hideReboot() {
    stopReboot();
    $('overlay-reboot').classList.remove('show');
  }
  function showReboot() {
    // экран висит, пока мощность не восстановится к началу следующего хода игрока
    // (снимается в GAME.render, когда ход снова переходит к игроку)
    stopReboot();
    $('overlay-reboot').classList.add('show');
    glitchBurst(1500, true);
    const bg = $('reboot-bg'), log = $('reboot-log');
    bg.textContent = ''; log.innerHTML = '';
    const bar = $('reboot-bar');
    bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; // перезапуск индикатора
    let bi = 0;
    rebootTimer = setInterval(() => {
      // фон — непрерывный консольный поток (держим последние ~90 строк)
      bg.textContent += rebootBgLine() + '\n' + rebootBgLine() + '\n';
      const lines = bg.textContent.split('\n');
      if (lines.length > 90) bg.textContent = lines.slice(-90).join('\n');
      // окно — последовательность загрузки по строкам, потом молчит (курсор мигает сам)
      if (bi < REBOOT_BOOT.length) log.innerHTML += REBOOT_BOOT[bi++] + '\n';
    }, 140);
  }

  // Ссылка на закрытие открытого окна сканера (окно само не исчезает;
  // убираем его крестиком/Esc/перехватом или при смене хода).
  let scanWinClose = null;

  // Обработчик fx-событий от сервера
  function handleFx(events) {
    for (const e of events) {
      if (e.type === 'damage') {
        sfx.damage();
        if (e.targetId === NET.myId) {
          const m = me();
          glitchBurst(350); // ~треть секунды — резко, но не затянуто
          crack(false);
          if (m && m.alive && m.hp < 5) crack(true);
        } else {
          glitchBurst(250, false); // урон по другому — лёгкие помехи
        }
      }
      if (e.type === 'heal') sfx.heal();
      if (e.type === 'move') sfx.move();
      if (e.type === 'programUsed') sfx.success();
      if (e.type === 'slotsClosed') sfx.slot();
      if (e.type === 'walls') sfx.walls();
      if (e.type === 'blocked') sfx.blocked();
      if (e.type === 'reverse') sfx.heal();
      if (e.type === 'turnStart' && e.playerId === NET.myId) sfx.turn();
      // Новый ход — окно сканера прошлого хода больше не актуально
      // (перехват живёт только в ход сканирующего): закрываем его.
      if (e.type === 'turnStart' && scanWinClose) scanWinClose();
      if (e.type === 'overheatBoost' && e.playerId === NET.myId) sfx.success();
      if (e.type === 'powerSteal' && e.targetId === NET.myId && e.amount > 0) errorStorm();
      // Торрент: эффект чужой программы прошёл как обычно, но цель получила
      // +мощность, равную потреблению этой программы.
      if (e.type === 'torrent') {
        if (e.targetId === NET.myId) sfx.success();
        const tgt = NET.state && NET.state.players.find(p => p.id === e.targetId);
        toast(`⇅ ТОРРЕНТ: ${tgt ? tgt.name : '???'} получает +${e.amount} мощности от чужой «${e.progName}»`);
      }
      // Сторонний айпи: выбранный игрок получает +мощность вместо урона автора.
      if (e.type === 'powerBoost') {
        if (e.targetId === NET.myId) sfx.success();
        const src = NET.state && NET.state.players.find(p => p.id === e.sourceId);
        const tgt = NET.state && NET.state.players.find(p => p.id === e.targetId);
        toast(`⇑ СТОРОННИЙ АЙПИ: ${tgt ? tgt.name : '???'} +${e.amount} мощности (от ${src ? src.name : '???'})`
          + (e.tpiBlocked ? ` — его Сторонний айпи заблокирован на ход` : ''));
      }
      if (e.type === 'death') {
        sfx.death();
        if (e.targetId === NET.myId) showDeath();
      }
      if (e.type === 'revive') {
        sfx.revive();
        if (e.targetId === NET.myId) { clearCracks(); toast('РЕЗЕРВНОЕ ПИТАНИЕ: системы восстановлены'); }
      }
      if (e.type === 'reboot' && e.playerId === NET.myId) showReboot();
      if (e.type === 'overheat' && e.playerId === NET.myId) document.body.classList.add('overheat');
      // --- новые события раунда 11 ---
      if (e.type === 'pushed') { sfx.damage(); glitchBurst(250, false); }
      if (e.type === 'teleport' || e.type === 'swapCopy') sfx.move();
      // Парный портал не смог высадить: все клетки вокруг выхода заняты.
      if (e.type === 'portalBlocked' && e.playerId === NET.myId) {
        errorBeep();
        toast('ПОРТАЛ ЗАБЛОКИРОВАН: рядом с выходом нет свободных клеток — вы остались на месте.');
      }
      if (e.type === 'copySpawn') sfx.success();
      if (e.type === 'copyHit') sfx.damage();
      if (e.type === 'copyDown') {
        sfx.death();
        if (e.ownerId === NET.myId) toast('Ваша цифровая копия уничтожена.');
      }
      if (e.type === 'cipherReroll') {
        sfx.slot();
        toast(`◈ КодШифр перешифрован: ${e.consumption}`);
      }
      if (e.type === 'captureScore') {
        sfx.win();
        const scorer = NET.state && NET.state.players.find(p => p.id === e.playerId);
        toast(`◈ ЗАХВАТ: ${scorer ? scorer.name : '???'} — ${e.points}/${e.need}`);
      }
      if (e.type === 'p2pLink') {
        sfx.success();
        const caster = NET.state && NET.state.players.find(p => p.id === e.playerId);
        toast(`⇄ P2P: ${caster ? caster.name : '???'} подключился к ${e.targetName}. До конца хода его карты исполняются с позиции подключённого.`);
      }
      // Кустарный интерфейс: переворот бита слота (щелчок для автора).
      if (e.type === 'bitFlip' && e.playerId === NET.myId) sfx.slot();
      // Разлом данных: вступление (звук для вступившего) и поломка программы.
      if (e.type === 'rift' && e.playerId === NET.myId) sfx.blocked();
      if (e.type === 'riftUsed') {
        sfx.success();
        const who = NET.state && NET.state.players.find(p => p.id === e.playerId);
        toast(`⌁ РАЗЛОМ ДАННЫХ: ${who ? who.name : '???'} сломал «${e.progName}» (потребление: ${e.consumption})`);
      }
      // Реплика ИИ-бота в общий чат (блокировка «АИ защита», ревность).
      if (e.type === 'aiChat') {
        addChatMessage({ from: e.from, color: '#b388ff', text: e.text });
      }
      // Боевой лог: удары, смерти, очки захвата — строкой в чат.
      // (Инкогнито и защитные программы сюда не попадают — так решил движок.)
      if (e.type === 'log') {
        addChatMessage({ from: '//ЛОГ', color: '#557a66', text: e.text });
      }
      // Антивирус: громкие системные сообщения для всех.
      if (e.type === 'antivirus') {
        addChatMessage({ from: '⚠ АНТИВИРУС', color: '#ff5555', text: e.text });
        if (e.text.includes('ПРОСНУЛСЯ')) { errorBeep(); glitchBurst(500); }
        toast(e.text);
      }
      // Сканер сети: руку цели видит только сканирующий. Можно ПЕРЕХВАТИТЬ
      // одну целую программу: она блокируется у врага, а вы разыгрываете её
      // со своих слотов в этот же ход. Окно НЕ исчезает само: его закрывают
      // крестик / Esc / перехват карты — либо конец вашего хода (перехват
      // возможен только в свой ход, так что с новым ходом окно убираем).
      if (e.type === 'scan' && e.playerId === NET.myId) {
        sfx.success();
        const div = document.createElement('div');
        div.className = 'err-window scan-window';
        div.style.left = '50%'; div.style.top = '12%';
        div.style.transform = 'translateX(-50%)';
        const rows = e.hand.length ? e.hand.map(h => {
          const off = h.broken || h.blocked;
          const note = h.broken ? 'сломана' : h.blocked ? 'уже заблокирована' : '';
          return `<div class="scan-row">
            <span class="scan-card">▸ ${esc(h.name)} <b class="scan-cons">${esc(h.consumption)}</b>${note ? ` <i class="dim">(${note})</i>` : ''}</span>
            ${off ? '' : `<button class="btn tiny scan-steal" data-uid="${esc(h.uid)}" title="заблокировать у врага на раунд и разыграть со своих слотов в этот ход">ПЕРЕХВАТ</button>`}
          </div>`;
        }).join('') : '<i>рука пуста</i>';
        div.innerHTML = `<div class="err-title"><span>СКАНЕР СЕТИ // рука: ${esc(e.targetName)}</span><span class="scan-close">✕</span></div>
          <div class="err-body">${rows}
          <div class="dim scan-hint">Окно не исчезает само (не дольше вашего хода). ПЕРЕХВАТ возможен, если ваши открытые слоты покрывают потребление карты. Esc — отказаться.</div></div>`;
        $('fx-layer').appendChild(div);
        const onEsc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
        document.addEventListener('keydown', onEsc, true);
        const close = () => {
          document.removeEventListener('keydown', onEsc, true);
          if (scanWinClose === close) scanWinClose = null;
          if (div.parentNode) div.remove();
        };
        // Запоминаем закрытие окна глобально: начался новый ход (ваш ход
        // кончился) — сервер уже аннулировал перехват, окно убираем.
        if (scanWinClose) scanWinClose();
        scanWinClose = close;
        div.querySelector('.scan-close').addEventListener('click', close);
        // Перехват: сервер проверит слоты; при успехе карта придёт в руку
        // обновлением состояния, у врага — заблокируется. Окно закрываем сразу.
        div.querySelectorAll('.scan-steal').forEach(btn => {
          btn.addEventListener('click', () => {
            socket.emit('game:scanSteal', { targetId: e.targetId, uid: btn.dataset.uid });
            close();
          });
        });
      }
      // Перехват сканером состоялся — строка в лог придёт отдельным fx.
      if (e.type === 'scanSteal' && e.playerId === NET.myId) {
        sfx.success();
        toast(`⛨ ПЕРЕХВАТ: «${e.cardName}» в вашей руке до конца хода — разыграйте её со своих слотов.`);
      }
      // Ставка Матрицы: слоты прокручиваются «барабаном», затем результат.
      if (e.type === 'matrixBet') {
        const mine = e.playerId === NET.myId;
        // Чужие ставки анонсируем только джекпотом (удача 5+) или крахом (провал 2 бит).
        if (mine || (e.luck && e.len >= 5) || (!e.luck && e.len === 2)) {
          const who = (NET.state && NET.state.players.find(p => p.id === e.playerId) || {}).name || '???';
          sfx.slot();
          toast(`🎰 МАТРИЦА (${who}): ставка «${e.cardName}» (${e.consumption}) — ${e.effectText}`);
        }
        if (mine) {
          // «Барабан»: каждый слот прокручивается со своей задержкой — волна слева направо.
          const strip = $('slots-strip');
          if (strip) {
            [...strip.children].forEach((s, i) => { s.style.animationDelay = (i * 55) + 'ms'; });
            strip.classList.add('matrix-spin');
            setTimeout(() => {
              strip.classList.remove('matrix-spin');
              [...strip.children].forEach(s => { s.style.animationDelay = ''; });
            }, 900 + strip.children.length * 55);
          }
          if (e.luck) sfx.success(); else { errorBeep(); glitchBurst(400, false); }
          // ДЖЕКПОТ: золотая переливающаяся надпись на весь экран (1.5 с, сама тает).
          if (e.luck && e.len >= 5) {
            const j = document.createElement('div');
            j.className = 'jackpot-flash';
            j.innerHTML = '<span>★ ДЖЕКПОТ ★</span>';
            document.body.appendChild(j);
            sfx.win();
            setTimeout(() => j.remove(), 1500);
          }
        }
      }
      // Закладка: мина поставлена (карта обновится из state).
      if (e.type === 'mineSet') { sfx.walls(); }
      // Взрыв мины (карта или «Закладка»): хлопок + глитч + тост — раньше у
      // взрыва НЕ БЫЛО своей обратной связи, из-за чего казалось, что мина
      // «не взорвалась» (урон шёл незаметным fx 'damage', а при блоке
      // защитой взрыва вовсе не было видно). Урон — отдельным fx 'damage'.
      if (e.type === 'mine') {
        beep(85, 0.3, 'sawtooth', 0.14);
        beep(55, 0.4, 'sawtooth', 0.1, 0.06);
        if (e.playerId !== NET.myId) glitchBurst(280, false);
        const victim = NET.state && NET.state.players.find(p => p.id === e.playerId);
        toast(victim ? `💥 МИНА ВЗОРВАЛАСЬ: ${victim.name}` : '💥 МИНА ВЗОРВАЛАСЬ');
      }
      // Перегретые слоты (военный интерфейс): бонус пришёл горячим.
      if (e.type === 'slotsHot' && e.playerId === NET.myId) {
        sfx.slot();
        toast(`⚠ ПЕРЕГРЕТЫЕ СЛОТЫ: +${e.amount} — незакрытые ударят двойным уроном и не дадут нового бонуса.`);
      }
      // Двойной ожог от незакрытых перегретых слотов.
      if (e.type === 'overheatBurn' && e.playerId === NET.myId) {
        glitchBurst(450);
        toast(`🔥 ПЕРЕГРЕВ ЖЖЁТ: −${e.amount} ХП (перегретые слоты бьют вдвойне).`);
      }
      // Активация «АИ защита»: окно ИИ с фразой — только для активировавшего.
      if (e.type === 'aiDefenseOn' && e.playerId === NET.myId) {
        sfx.blocked();
        showAiWindow(e.from);
      }
      if (e.type === 'gameOver') {
        sfx.win();
        const winner = NET.state && NET.state.players.find(p => p.id === e.winnerId);
        const m = me();
        if (e.winnerTeam != null && typeof LOBBY !== 'undefined') {
          // Командная победа: команда побеждает вместе.
          const tn = LOBBY.TEAM_NAMES[e.winnerTeam] || e.winnerTeam;
          const iWon = !!(m && m.team === e.winnerTeam);
          showWin('', iWon, {
            title: `КОМАНДА ${tn} ЗАХВАТИЛА СЕТЬ`,
            phrase: e.reason === 'capture'
              ? 'Точки контроля взломаны. Территория сети закреплена за командой.'
              : 'Командная операция завершена. Сеть под контролем.',
          });
        } else {
          showWin(winner ? winner.name : '???', e.winnerId === NET.myId, {
            phrase: e.reason === 'capture'
              ? 'Точки контроля взломаны. Территория сети захвачена.'
              : null,
          });
        }
      }
    }
  }

  return { errorBeep, sfx, toast, crack, clearCracks, glitchBurst, errorStorm, showDeath, showWin, hideOverlays, showReboot, hideReboot, showAiWindow, handleFx };
})();

socket.on('fx', (events) => {
  FX.handleFx(events);
});
