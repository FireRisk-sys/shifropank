// ============================================================================
// ШИФРОПАНК — экран лобби
// Настройки сессии общие (любое изменение сбрасывает готовность всех).
// Командный режим: каждый САМ выбирает себе команду (А/Б/В/Г) в своей строке.
// ============================================================================
const LOBBY = (() => {
  // Числовые/строковые настройки -> id полей в index.html
  const SETTING_IDS = {
    startHP: 'set-hp', startPower: 'set-power', maxPrograms: 'set-progs',
    turnSeconds: 'set-timer', mapW: 'set-mapw', mapH: 'set-maph',
    mode: 'set-mode',
    capturePoints: 'set-cap-points', captureLenMin: 'set-cap-lenmin', captureLenMax: 'set-cap-lenmax',
    cipherGrow: 'set-cipher-grow', cipherStep: 'set-cipher-step', // рост КодШифра
    antivirusRound: 'set-av-round', antivirusType: 'set-av-type', // антивирус
  };

  const TEAM_NAMES = ['А', 'Б', 'В', 'Г'];
  // Цвета значков команд (не путать с личным цветом пикселя игрока!)
  const TEAM_COLORS = ['#ff5555', '#55aaff', '#ffd740', '#b388ff'];

  const teamBadge = (t) => t == null ? '' :
    `<span class="p-team" style="border-color:${TEAM_COLORS[t]};color:${TEAM_COLORS[t]}">${TEAM_NAMES[t]}</span>`;

  function render() {
    const l = NET.lobby;
    if (!l) return;
    const teamsOn = !!l.settings.teamsEnabled;
    // Хост (первый вошедший) — админ сессии: видит кнопки кика.
    const amHost = l.players[0] && l.players[0].id === NET.myId;
    const ul = $('lobby-players');
    ul.innerHTML = '';
    for (const p of l.players) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="p-color" style="background:${esc(p.color)}"></span>
        <span class="p-name">${esc(p.name)}${p.id === NET.myId ? ' (вы)' : ''}</span>
        ${teamsOn ? teamBadge(p.team) : ''}
        <span class="p-ready" style="margin-left:auto">${p.ready ? '✔ ГОТОВ' : '...'}</span>`;
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
      // В командном режиме — селектор команды (свою строку можно менять).
      if (teamsOn) {
        const sel = document.createElement('select');
        sel.className = 'team-select';
        sel.innerHTML = '<option value="">—</option>' +
          TEAM_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
        sel.value = p.team == null ? '' : String(p.team);
        sel.disabled = p.id !== NET.myId;
        sel.title = p.id === NET.myId ? 'ваша команда' : 'команду выбирает сам игрок';
        sel.addEventListener('change', () => {
          socket.emit('player:team', { team: sel.value === '' ? null : +sel.value });
        });
        li.insertBefore(sel, li.lastChild);
      }
      ul.appendChild(li);
    }
    // Не перезаписываем поле, которое пользователь сейчас редактирует.
    for (const [k, id] of Object.entries(SETTING_IDS)) {
      const input = $(id);
      if (document.activeElement !== input) input.value = l.settings[k];
    }
    // Код комнаты — хост диктует его друзьям для подключения.
    $('room-code').textContent = l.code ? `КОД КОМНАТЫ: ${l.code} — продиктуйте друзьям` : '';
    const teamsBox = $('set-teams');
    if (document.activeElement !== teamsBox) teamsBox.checked = teamsOn;
    // Поля режима «Захват территории» видны только в нём.
    const capture = l.settings.mode === 'capture';
    document.querySelectorAll('.capture-only').forEach(el => el.classList.toggle('hidden', !capture));
    const meLp = l.players.find(p => p.id === NET.myId);
    $('ready-btn').textContent = meLp && meLp.ready ? 'ОТМЕНА ГОТОВНОСТИ' : 'ГОТОВ';
    // Пересоздание игры одним нажатием — привилегия хоста.
    $('recreate-btn').classList.toggle('hidden', !amHost);
  }

  function init() {
    for (const [k, id] of Object.entries(SETTING_IDS)) {
      $(id).addEventListener('change', () => sendSettings());
    }
    $('set-teams').addEventListener('change', () => sendSettings());
    $('ready-btn').addEventListener('click', () => {
      const meLp = NET.lobby && NET.lobby.players.find(p => p.id === NET.myId);
      socket.emit('player:ready', { ready: !(meLp && meLp.ready) });
    });
    $('recreate-btn').addEventListener('click', () => {
      FX.sfx.click();
      socket.emit('lobby:recreate');
    });
  }

  // Собираем все поля настроек в один пакет для сервера.
  function sendSettings() {
    const s = Object.fromEntries(Object.entries(SETTING_IDS).map(([key, iid]) => [key, $(iid).value]));
    s.teamsEnabled = $('set-teams').checked;
    socket.emit('settings:update', s);
  }

  return { render, init, TEAM_NAMES, TEAM_COLORS };
})();
