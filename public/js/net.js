// ============================================================================
// ШИФРОПАНК — сеть и общее состояние клиента
// ============================================================================
const socket = io();

const NET = {
  myId: null,
  phase: 'lobby',      // 'lobby' | 'setup' | 'game'
  meta: null,          // { programs, interfaces }
  lobby: null,         // { settings, players }
  state: null,         // сериализованное состояние матча
  music: null,
};

// --- мелкие помощники ---
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function me() {
  return NET.state && NET.state.players.find(p => p.id === NET.myId);
}
function isMyTurn() {
  if (!NET.state || NET.state.over) return false;
  return NET.state.order[NET.state.turnIndex] === NET.myId;
}
function currentTurnPlayer() {
  if (!NET.state) return null;
  const id = NET.state.order[NET.state.turnIndex];
  return NET.state.players.find(p => p.id === id);
}

// --- чат (два журнала: лобби и игра) ---
function addChatMessage({ from, color, text }) {
  for (const logId of ['chat-log', 'chat-log-game']) {
    const log = $(logId);
    if (!log) continue;
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `<span class="from" style="color:${esc(color)}">${esc(from)}:</span> ${esc(text)}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  if (typeof FX !== 'undefined' && FX.sfx) FX.sfx.chat();
}

function wireChat(inputId, btnId) {
  const input = $(inputId), btn = $(btnId);
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat:send', { text });
    input.value = '';
  };
  btn.addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

socket.on('chat:message', addChatMessage);
socket.on('game:error', ({ msg }) => {
  FX.errorBeep();
  FX.glitchBurst(350, false); // короткий сбой интерфейса при отказе программы
  FX.toast(msg || 'Ошибка');
});
