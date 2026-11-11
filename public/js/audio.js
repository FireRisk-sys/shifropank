// ============================================================================
// ШИФРОПАНК — радио-плеер и новости с помехами
// ============================================================================
const AUDIO = (() => {
  const musicEl = () => $('music-el');
  const newsEl = () => $('news-el');
  // Громкость запоминается в браузере между сессиями.
  let localVolume = (() => {
    const v = parseFloat(localStorage.getItem('shifro-volume'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7;
  })();
  let ducked = false;
  let noiseCtx = null, noiseGain = null;

  function currentTrackUrl() {
    const m = NET.music;
    if (!m || !m.playlist.length) return null;
    return '/music/' + encodeURIComponent(m.playlist[m.index]);
  }

  // Перцептивная кривая громкости: ухо слышит громкость логарифмически,
  // поэтому линейный ползунок «не работает» в левой половине.
  // Квадратичная кривая: влево до конца = 0 (полная тишина), середина ≈ 25%.
  function gain(v) {
    if (v <= 0) return 0;
    return v * v;
  }

  function applyVolume() {
    const el = musicEl();
    if (!el) return;
    const g = gain(localVolume);
    el.volume = ducked ? g * 0.25 : g;
    const slider = $('pl-volume');
    if (slider) slider.title = `громкость: ${Math.round(localVolume * 100)}%`;
  }

  function syncMusic() {
    const m = NET.music, el = musicEl();
    if (!m) return;
    renderPlaylist();
    applyVolume(); // после смены трека громкость могла сброситься
    const url = currentTrackUrl();
    const setTrackName = (t) => {
      // Длинные имена не обрезаем многоточием, а пускаем медленной
      // «бегущей строкой» (текст продублирован — шов петли незаметен).
      const setMarquee = (el) => {
        if (!el) return;
        const sep = ' \u00A0•\u00A0 ';
        el.innerHTML = `<span class="marquee-inner">${esc(t)}</span>`;
        const inner = el.firstChild;
        requestAnimationFrame(() => {
          const need = inner.scrollWidth > el.clientWidth + 4;
          if (need) inner.textContent = (t + sep) + (t + sep);
          requestAnimationFrame(() => el.classList.toggle('marquee', need));
        });
      };
      setMarquee($('track-name'));
      setMarquee($('track-name-win'));
    };
    if (!url) { el.pause(); setTrackName('— тишина в эфире —'); return; }
    setTrackName('♪ ' + m.playlist[m.index]);
    if (!el.src.endsWith(encodeURIComponent(m.playlist[m.index]))) {
      el.src = url;
      el.volume = ducked ? gain(localVolume) * 0.25 : gain(localVolume);
    }
    if (m.playing) {
      const want = (Date.now() - m.startedAt) / 1000;
      el.play().then(() => {
        if (Math.abs(el.currentTime - want) > 2.5) el.currentTime = want;
      }).catch(() => { /* браузер ждёт жеста пользователя */ });
    } else {
      el.pause();
      if (m.pausedAt) el.currentTime = m.pausedAt / 1000;
    }
    $('pl-play').textContent = m.playing ? '⏸' : '▶';
  }

  function renderPlaylist() {
    const ul = $('playlist');
    if (!ul || !NET.music) return;
    ul.innerHTML = '';
    NET.music.playlist.forEach((name, i) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'pl-name';
      label.textContent = name.replace(/^\d+_/, '');
      label.title = name.replace(/^\d+_/, ''); // длинное имя — в подсказке
      li.appendChild(label);
      if (i === NET.music.index) li.classList.add('playing');
      label.addEventListener('click', () => socket.emit('music:control', { action: 'select', index: i }));
      // Удаление трека из плейлиста (и файла на сервере) — доступно всем,
      // как и остальное управление радио.
      const del = document.createElement('button');
      del.className = 'pl-del';
      del.textContent = '✕';
      del.title = 'удалить трек из плейлиста';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Удалить трек «${name.replace(/^\d+_/, '')}» из плейлиста?`)) {
          socket.emit('music:remove', { index: i });
        }
      });
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  // Трек закончился: «диджей» (первый в списке лобби) переключает дальше.
  function onTrackEnded() {
    const m = NET.music;
    if (!m || !m.playlist.length) return;
    const iAmDj = NET.lobby && NET.lobby.players.length && NET.lobby.players[0].id === NET.myId;
    if (m.playlist.length === 1) {
      if (iAmDj) socket.emit('music:control', { action: 'prev' }); // перемотка в начало = повтор
    } else if (iAmDj) {
      socket.emit('music:control', { action: 'next' });
    }
  }

  // --- радио-помехи поверх новостей ---
  function startNoise() {
    try {
      if (!noiseCtx) noiseCtx = new (window.AudioContext || window.webkitAudioContext)();
      const len = noiseCtx.sampleRate * 2;
      const buf = noiseCtx.createBuffer(1, len, noiseCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
      const src = noiseCtx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const filter = noiseCtx.createBiquadFilter();
      filter.type = 'bandpass'; filter.frequency.value = 1400; filter.Q.value = 0.6;
      noiseGain = noiseCtx.createGain();
      noiseGain.gain.value = 0.012; // шум едва слышен на фоне новости
      src.connect(filter).connect(noiseGain).connect(noiseCtx.destination);
      src.start();
      noiseGain._src = src;
    } catch (e) { /* помехи не критичны */ }
  }
  function stopNoise() {
    try { if (noiseGain && noiseGain._src) { noiseGain._src.stop(); noiseGain = null; } } catch (e) {}
  }

  function playNews(url) {
    const el = newsEl();
    ducked = true; applyVolume();
    startNoise();
    el.src = url;
    el.volume = gain(localVolume);
    el.play().catch(() => { ducked = false; applyVolume(); stopNoise(); });
    el.onended = () => { ducked = false; applyVolume(); stopNoise(); };
  }

  // Перетаскиваемое окно радио.
  // ПЕРЕМЕЩЕНИЕ — только за заголовок. РАЗМЕР — только за уголок справа снизу.
  // ВАЖНО: окно изначально прибито стилями за right+bottom, поэтому при драге
  // нужно сбросить ОБЕ привязки (right И bottom) — иначе окно не двигается,
  // а растягивается (нижний край остаётся на месте).
  function initRadioWindow() {
    const win = $('radio-window');
    $('radio-open-btn').addEventListener('click', () => {
      win.classList.toggle('hidden');
      FX.sfx.click();
    });
    $('radio-close-btn').addEventListener('click', () => win.classList.add('hidden'));

    // --- перемещение за заголовок ---
    let drag = null;
    $('radio-title').addEventListener('mousedown', (e) => {
      if (e.target.closest('#radio-close-btn')) return;
      const r = win.getBoundingClientRect();
      drag = { dx: e.clientX - r.x, dy: e.clientY - r.y };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      win.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.dx)) + 'px';
      win.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy)) + 'px';
      win.style.right = 'auto';
      win.style.bottom = 'auto'; // ← без этой строки окно «растягивалось» вместо драга
    });
    document.addEventListener('mouseup', () => { drag = null; resize = null; });

    // --- изменение размера за уголок (и только за него) ---
    let resize = null;
    $('radio-resize').addEventListener('mousedown', (e) => {
      const r = win.getBoundingClientRect();
      resize = { w: r.width, h: r.height, x: e.clientX, y: e.clientY };
      e.preventDefault();
      e.stopPropagation(); // не начинать перемещение
    });
    document.addEventListener('mousemove', (e) => {
      if (!resize) return;
      win.style.width = Math.max(240, Math.min(window.innerWidth * 0.9, resize.w + e.clientX - resize.x)) + 'px';
      win.style.height = Math.max(160, Math.min(window.innerHeight * 0.8, resize.h + e.clientY - resize.y)) + 'px';
      win.style.right = 'auto';
      win.style.bottom = 'auto';
      // при росте высоты держим окно на месте: top фиксируем один раз
      if (!resize.topFixed) {
        const r = win.getBoundingClientRect();
        win.style.left = r.x + 'px';
        win.style.top = r.y + 'px';
        resize.topFixed = true;
      }
    });
  }

  // Прячем окно радио (например, на экране загрузки оно только мешает).
  // Само радио продолжает играть — скрывается лишь окно.
  function hideRadioWindow() {
    $('radio-window').classList.add('hidden');
  }

  function init() {
    musicEl().addEventListener('ended', onTrackEnded);
    initRadioWindow();
    $('pl-play').addEventListener('click', () => {
      const action = NET.music && NET.music.playing ? 'pause' : 'play';
      socket.emit('music:control', { action });
    });
    $('pl-next').addEventListener('click', () => socket.emit('music:control', { action: 'next' }));
    $('pl-prev').addEventListener('click', () => socket.emit('music:control', { action: 'prev' }));
    const slider = $('pl-volume');
    slider.value = Math.round(localVolume * 100);
    applyVolume();
    slider.addEventListener('input', (e) => {
      localVolume = e.target.value / 100;
      localStorage.setItem('shifro-volume', String(localVolume));
      applyVolume();
    });
    $('pl-upload').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('track', file);
      FX.toast('Загрузка трека в сеть...');
      try {
        const res = await fetch('/upload', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
        FX.toast('Трек в эфире: ' + file.name);
      } catch (err) {
        FX.toast('Не удалось загрузить трек: ' + (err && err.message ? err.message : 'ошибка сети'));
      }
      e.target.value = '';
    });
  }

  socket.on('music:state', (m) => { NET.music = m; syncMusic(); });
  socket.on('news:play', ({ url }) => playNews(url));

  return { init, syncMusic, hideRadioWindow };
})();
