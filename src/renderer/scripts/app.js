(function () {
  const { parseLrc, findActiveLineIndex } = window.LrcParser;
  const { EQ_FREQUENCIES, EQ_PRESETS, DualDeckAudioEngine } = window.YumaAudio;

  const state = {
    streamPort: 0,
    store: null,
    localTracks: [],
    discoverySections: [],
    ytSearchResults: [],
    queue: [],
    queueIndex: -1,
    currentTrack: null,
    activeBackend: 'local',
    isPlaying: false,
    shuffle: false,
    repeat: false,
    lyricsLines: [],
    activeLyricIndex: -1,
    sponsorSegments: [],
    lastSkippedSegmentStart: -1,
    pendingPlaylistTrack: null
  };

  let engine = null;
  let toastTimer = null;
  let searchDebounce = null;
  let visualizerRaf = null;

  const $ = (id) => document.getElementById(id);

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function formatTime(secs) {
    if (!Number.isFinite(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getTrackStreamUrl(track) {
    if (track.source === 'local') {
      return `http://127.0.0.1:${state.streamPort}/local?path=${encodeURIComponent(track.filePath)}`;
    }
    return `http://127.0.0.1:${state.streamPort}/stream?id=${encodeURIComponent(track.videoId)}`;
  }

  function isLiked(trackId) {
    return Boolean(state.store?.likedTracks?.some((t) => t.id === trackId));
  }

  function switchView(viewName) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.querySelectorAll('.nav-pill').forEach((b) => b.classList.remove('active'));
    $(`view-${viewName}`)?.classList.add('active');
    document.querySelector(`.nav-pill[data-view="${viewName}"]`)?.classList.add('active');
  }

  function switchSideTab(tabName) {
    document.querySelectorAll('.side-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.side-content').forEach((c) => c.classList.remove('active'));
    document.querySelector(`.side-tab[data-side-tab="${tabName}"]`)?.classList.add('active');
    $(`side-${tabName}`)?.classList.add('active');
  }

  function updateAmbientFromArtwork(src) {
    if (!state.store?.settings?.ambientBackdrop) return;
    if (!src) {
      document.documentElement.style.setProperty('--accent', '#6c8cff');
      document.documentElement.style.setProperty('--accent-2', '#a855f7');
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] + data[i + 1] + data[i + 2] > 70) {
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
          }
        }
        if (count > 0) {
          r = Math.min(255, Math.round(r / count) + 25);
          g = Math.min(255, Math.round(g / count) + 20);
          b = Math.min(255, Math.round(b / count) + 35);
          const c1 = `rgb(${r}, ${g}, ${b})`;
          const c2 = `rgb(${Math.max(60, b)}, ${Math.max(50, r)}, ${Math.min(255, g + 40)})`;
          document.documentElement.style.setProperty('--accent', c1);
          document.documentElement.style.setProperty('--accent-2', c2);
        }
      } catch {
        // ignore cross-origin canvas errors
      }
    };
    img.src = src;
  }

  async function playTrackAtIndex(index, { useCrossfade = false } = {}) {
    if (index < 0 || index >= state.queue.length) return;
    state.queueIndex = index;
    const track = state.queue[index];
    state.currentTrack = track;
    state.sponsorSegments = [];
    state.lastSkippedSegmentStart = -1;

    renderNowPlaying(track);
    renderQueue();
    updateAmbientFromArtwork(track.artwork);

    try {
      if (track.source === 'youtube') {
        engine.stop();
        state.activeBackend = 'ytm';
        $('playPauseBtn').textContent = '⏸';
        state.isPlaying = true;
        await window.yumaAPI.ytmPlayer.setVolume(state.store?.settings?.volume ?? 0.85);
        await window.yumaAPI.ytmPlayer.play(track.videoId);
      } else {
        await window.yumaAPI.ytmPlayer.stop();
        state.activeBackend = 'local';
        const url = getTrackStreamUrl(track);
        await engine.playUrl(url, { useCrossfade });
        state.isPlaying = true;
        $('playPauseBtn').textContent = '⏸';
      }
      state.store.history = await window.yumaAPI.store.addHistory(track);
      renderHistory();
    } catch (err) {
      showToast(`Playback failed: ${err.message || 'Check connection or audio file'}`);
    }

    loadTrackExtras(track);
  }

  async function playTrackWithContext(track, trackList = [track]) {
    const list = Array.isArray(trackList) && trackList.length > 0 ? trackList : [track];
    state.queue = [...list];
    const idx = state.queue.findIndex((t) => t.id === track.id);
    await playTrackAtIndex(idx >= 0 ? idx : 0, { useCrossfade: false });
  }

  async function loadTrackExtras(track) {
    // 1. Lyrics
    $('lyricsContainer').innerHTML = '<div class="empty-state">Searching lyrics...</div>';
    $('lyricsSourceBadge').textContent = 'Lyrics';
    state.lyricsLines = [];
    state.activeLyricIndex = -1;

    try {
      const res = await window.yumaAPI.music.getLyrics(track);
      if (state.currentTrack?.id !== track.id) return;

      if (res.syncedLyrics) {
        state.lyricsLines = parseLrc(res.syncedLyrics);
        $('lyricsSourceBadge').textContent = `Synced Lyrics • ${res.source}`;
        renderLyricsLines();
      } else if (res.plainLyrics) {
        $('lyricsSourceBadge').textContent = `Plain Lyrics • ${res.source}`;
        $('lyricsContainer').innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit;line-height:1.6;color:var(--text-muted);font-size:13.5px;">${escapeHtml(res.plainLyrics)}</pre>`;
      } else {
        $('lyricsContainer').innerHTML = '<div class="empty-state">No lyrics found for this track.</div>';
      }
    } catch {
      $('lyricsContainer').innerHTML = '<div class="empty-state">Unable to load lyrics.</div>';
    }

    // 2. SponsorBlock (YouTube only)
    const sponsorBadge = $('npSponsorBadge');
    sponsorBadge.classList.add('hidden');
    if (track.source === 'youtube' && state.store?.settings?.sponsorBlockEnabled) {
      try {
        const segs = await window.yumaAPI.music.getSponsorSegments(track.videoId);
        if (state.currentTrack?.id !== track.id) return;
        state.sponsorSegments = Array.isArray(segs) ? segs : [];
        if (state.sponsorSegments.length > 0) {
          sponsorBadge.classList.remove('hidden');
          sponsorBadge.textContent = `SponsorBlock (${state.sponsorSegments.length} skips)`;
        }
      } catch {
        // ignore
      }
    }
  }

  function renderNowPlaying(track) {
    $('npTitle').textContent = track.title;
    $('npArtist').textContent = `${track.artist} • ${track.album || ''}`;

    const img = $('npArtwork');
    const ph = $('npArtworkPlaceholder');
    if (track.artwork) {
      img.src = track.artwork;
      img.classList.remove('hidden');
      ph.classList.add('hidden');
    } else {
      img.classList.add('hidden');
      ph.classList.remove('hidden');
    }

    const badge = $('npCodecBadge');
    if (track.lossless) {
      const sr = track.sampleRate ? ` • ${Math.round(track.sampleRate / 1000)}kHz` : '';
      const bd = track.bitDepth ? `/${track.bitDepth}bit` : '';
      badge.textContent = `HI-RES ${track.codec || 'FLAC'}${bd}${sr}`;
      badge.classList.add('lossless');
    } else {
      badge.textContent = track.source === 'youtube' ? 'YOUTUBE MUSIC • OPUS' : (track.codec || 'LOCAL AUDIO');
      badge.classList.remove('lossless');
    }

    const likeBtn = $('npLikeBtn');
    const liked = isLiked(track.id);
    likeBtn.textContent = liked ? '♥' : '♡';
    likeBtn.classList.toggle('liked', liked);
  }

  function seekCurrent(seconds) {
    if (state.activeBackend === 'ytm') {
      window.yumaAPI.ytmPlayer.seek(seconds);
    } else {
      engine.seek(seconds);
    }
  }

  function toggleCurrentPlay() {
    if (!state.currentTrack) return;
    if (state.activeBackend === 'ytm') {
      if (state.isPlaying) {
        window.yumaAPI.ytmPlayer.pause();
        state.isPlaying = false;
        $('playPauseBtn').textContent = '▶';
      } else {
        window.yumaAPI.ytmPlayer.resume();
        state.isPlaying = true;
        $('playPauseBtn').textContent = '⏸';
      }
    } else {
      engine.togglePlay();
    }
  }

  function renderLyricsLines() {
    const container = $('lyricsContainer');
    container.innerHTML = '';
    state.lyricsLines.forEach((line, idx) => {
      const div = document.createElement('div');
      div.className = 'lyric-line';
      div.dataset.idx = String(idx);
      div.textContent = line.text;
      div.addEventListener('click', () => seekCurrent(line.time));
      container.appendChild(div);
    });
  }

  function syncLyricsHighlight(currentTime) {
    if (!state.lyricsLines.length) return;
    const idx = findActiveLineIndex(state.lyricsLines, currentTime);
    if (idx === state.activeLyricIndex) return;
    state.activeLyricIndex = idx;

    const container = $('lyricsContainer');
    container.querySelectorAll('.lyric-line').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
    const activeEl = container.querySelector(`.lyric-line[data-idx="${idx}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function checkSponsorBlock(currentTime) {
    if (!state.store?.settings?.sponsorBlockEnabled || !state.sponsorSegments.length) return;
    for (const seg of state.sponsorSegments) {
      if (currentTime >= seg.start && currentTime < seg.end - 0.35 && state.lastSkippedSegmentStart !== seg.start) {
        state.lastSkippedSegmentStart = seg.start;
        seekCurrent(seg.end);
        showToast(`Skipped ${seg.category} segment (SponsorBlock)`);
        break;
      }
    }
  }

  function nextTrack({ useCrossfade = false } = {}) {
    if (!state.queue.length) return;
    if (state.repeat) {
      playTrackAtIndex(state.queueIndex, { useCrossfade });
      return;
    }
    if (state.shuffle && state.queue.length > 1) {
      let randIdx = state.queueIndex;
      while (randIdx === state.queueIndex) {
        randIdx = Math.floor(Math.random() * state.queue.length);
      }
      playTrackAtIndex(randIdx, { useCrossfade });
      return;
    }
    const nextIdx = (state.queueIndex + 1) % state.queue.length;
    playTrackAtIndex(nextIdx, { useCrossfade });
  }

  function prevTrack() {
    if (!state.queue.length) return;
    const currentPos = parseFloat($('seekSlider').value) || 0;
    if (currentPos > 4) {
      seekCurrent(0);
      return;
    }
    const prevIdx = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
    playTrackAtIndex(prevIdx);
  }

  function createTrackRow(track, listContext) {
    const row = document.createElement('div');
    row.className = 'track-row';
    if (state.currentTrack?.id === track.id) row.classList.add('playing');

    const thumbHtml = track.artwork
      ? `<img class="track-thumb" src="${escapeHtml(track.artwork)}" alt="" loading="lazy" />`
      : `<div class="track-thumb">♪</div>`;

    const liked = isLiked(track.id);
    const badgeClass = track.lossless ? 'codec-badge lossless' : 'codec-badge';
    const badgeText = track.lossless ? (track.codec || 'FLAC') : track.source === 'youtube' ? 'YTM' : (track.codec || 'AUDIO');

    row.innerHTML = `
      ${thumbHtml}
      <div class="track-meta">
        <div class="track-name">${escapeHtml(track.title)}</div>
        <div class="track-sub">${escapeHtml(track.artist)} • ${formatTime(track.duration)}</div>
      </div>
      <span class="${badgeClass}">${escapeHtml(badgeText)}</span>
      <div class="track-actions">
        <button class="icon-btn row-queue" title="Add to Queue">+</button>
        <button class="icon-btn row-playlist" title="Add to Playlist">☰</button>
        <button class="icon-btn row-like ${liked ? 'liked' : ''}" title="Like">${liked ? '♥' : '♡'}</button>
      </div>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      playTrackWithContext(track, listContext);
    });

    row.querySelector('.row-queue').addEventListener('click', () => {
      state.queue.push(track);
      renderQueue();
      showToast(`Added "${track.title}" to queue`);
    });

    row.querySelector('.row-playlist').addEventListener('click', () => openPlaylistModal(track));

    row.querySelector('.row-like').addEventListener('click', async () => {
      const res = await window.yumaAPI.store.toggleLike(track);
      state.store.likedTracks = res.likedTracks;
      renderAllLists();
      if (state.currentTrack?.id === track.id) renderNowPlaying(track);
    });

    return row;
  }

  function renderTrackList(containerId, tracks, emptyMsg) {
    const container = $(containerId);
    container.innerHTML = '';
    if (!tracks || tracks.length === 0) {
      container.innerHTML = `<div class="empty-state glass-panel">${emptyMsg}</div>`;
      return;
    }
    tracks.forEach((t) => container.appendChild(createTrackRow(t, tracks)));
  }

  function renderDiscovery() {
    const container = $('discoveryShelves');
    container.innerHTML = '';
    if (!state.discoverySections.length) {
      container.innerHTML = '<div class="empty-state glass-panel">Connect to internet to load YouTube Music discovery, or add local music folders below.</div>';
      return;
    }

    for (const sec of state.discoverySections) {
      const shelf = document.createElement('div');
      shelf.className = 'shelf';
      shelf.innerHTML = `<div class="shelf-title">${escapeHtml(sec.title)}</div><div class="cards-grid"></div>`;
      const grid = shelf.querySelector('.cards-grid');

      sec.tracks.forEach((track) => {
        const card = document.createElement('div');
        card.className = 'music-card';
        card.innerHTML = `
          <img src="${escapeHtml(track.artwork || '')}" alt="" loading="lazy" />
          <div class="card-title">${escapeHtml(track.title)}</div>
          <div class="card-sub">${escapeHtml(track.artist)}</div>
        `;
        card.addEventListener('click', () => playTrackWithContext(track, sec.tracks));
        grid.appendChild(card);
      });

      container.appendChild(shelf);
    }
  }

  function renderFolders() {
    const chips = $('folderChips');
    chips.innerHTML = '';
    (state.store?.localFolders || []).forEach((folder) => {
      const chip = document.createElement('div');
      chip.className = 'folder-chip';
      chip.innerHTML = `<span>📁 ${escapeHtml(folder)}</span><button title="Remove folder">✕</button>`;
      chip.querySelector('button').addEventListener('click', async () => {
        const res = await window.yumaAPI.library.removeFolder(folder);
        state.store.localFolders = res.folders;
        state.localTracks = res.tracks;
        renderFolders();
        renderLocalTracks();
      });
      chips.appendChild(chip);
    });
  }

  function renderLocalTracks() {
    renderTrackList(
      'localTracksList',
      state.localTracks,
      'No local audio files found. Click <strong>+ Add Music Folder</strong> or drag &amp; drop FLAC/MP3 files!'
    );
  }

  function renderLiked() {
    renderTrackList('likedTracksList', state.store?.likedTracks || [], 'No liked songs yet. Click ♡ on any track.');
  }

  function renderHistory() {
    renderTrackList('historyTracksList', state.store?.history || [], 'Your recently played tracks will appear here.');
  }

  function renderPlaylists() {
    const container = $('playlistsContainer');
    container.innerHTML = '';
    const playlists = state.store?.playlists || [];
    if (playlists.length === 0) {
      container.innerHTML = '<div class="empty-state glass-panel">Create a playlist above to organize local and YouTube Music tracks together.</div>';
      return;
    }

    playlists.forEach((pl) => {
      const card = document.createElement('div');
      card.className = 'playlist-card glass-panel';
      card.innerHTML = `
        <div class="playlist-card-head">
          <div>
            <strong>${escapeHtml(pl.name)}</strong>
            <span class="muted"> (${pl.tracks.length} tracks)</span>
          </div>
          <div>
            <button class="glass-btn pl-play-btn">▶ Play</button>
            <button class="icon-btn pl-del-btn" title="Delete Playlist">🗑</button>
          </div>
        </div>
        <div class="track-list pl-tracks"></div>
      `;

      card.querySelector('.pl-play-btn').addEventListener('click', () => {
        if (pl.tracks.length > 0) playTrackWithContext(pl.tracks[0], pl.tracks);
      });
      card.querySelector('.pl-del-btn').addEventListener('click', async () => {
        state.store.playlists = await window.yumaAPI.store.deletePlaylist(pl.id);
        renderPlaylists();
      });

      const listEl = card.querySelector('.pl-tracks');
      pl.tracks.forEach((t) => listEl.appendChild(createTrackRow(t, pl.tracks)));
      container.appendChild(card);
    });
  }

  function renderQueue() {
    $('queueCount').textContent = String(state.queue.length);
    const list = $('queueList');
    list.innerHTML = '';
    if (state.queue.length === 0) {
      list.innerHTML = '<div class="empty-state">Queue is empty.</div>';
      return;
    }
    state.queue.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = `track-row ${idx === state.queueIndex ? 'playing' : ''}`;
      row.innerHTML = `
        <div class="track-thumb">${idx === state.queueIndex ? '▶' : idx + 1}</div>
        <div class="track-meta">
          <div class="track-name">${escapeHtml(t.title)}</div>
          <div class="track-sub">${escapeHtml(t.artist)}</div>
        </div>
        <span class="codec-badge">${formatTime(t.duration)}</span>
        <button class="icon-btn" title="Remove">✕</button>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        playTrackAtIndex(idx);
      });
      row.querySelector('button').addEventListener('click', () => {
        state.queue.splice(idx, 1);
        if (idx < state.queueIndex) state.queueIndex--;
        renderQueue();
      });
      list.appendChild(row);
    });
  }

  function renderAllLists() {
    renderLocalTracks();
    renderLiked();
    renderHistory();
    renderPlaylists();
    if (state.ytSearchResults.length) {
      renderTrackList('ytSearchList', state.ytSearchResults, 'No YouTube Music results.');
    }
  }

  function openPlaylistModal(track) {
    state.pendingPlaylistTrack = track;
    const list = $('playlistModalList');
    list.innerHTML = '';
    const playlists = state.store?.playlists || [];
    if (playlists.length === 0) {
      list.innerHTML = '<div class="muted">No playlists yet. Create one in Library → Playlists.</div>';
    } else {
      playlists.forEach((pl) => {
        const btn = document.createElement('button');
        btn.className = 'glass-btn';
        btn.style.textAlign = 'left';
        btn.textContent = `${pl.name} (${pl.tracks.length})`;
        btn.addEventListener('click', async () => {
          const updated = await window.yumaAPI.store.addToPlaylist(pl.id, state.pendingPlaylistTrack);
          const idx = state.store.playlists.findIndex((p) => p.id === pl.id);
          if (idx >= 0) state.store.playlists[idx] = updated;
          $('playlistModal').classList.add('hidden');
          renderPlaylists();
          showToast(`Added to "${pl.name}"`);
        });
        list.appendChild(btn);
      });
    }
    $('playlistModal').classList.remove('hidden');
  }

  function buildEqUI() {
    const container = $('eqSlidersContainer');
    container.innerHTML = '';
    const bands = state.store?.settings?.eqBands || EQ_PRESETS.Flat;

    EQ_FREQUENCIES.forEach((freq, idx) => {
      const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
      const val = bands[idx] || 0;
      const div = document.createElement('div');
      div.className = 'eq-band';
      div.innerHTML = `
        <span class="eq-db" id="eqDb${idx}">${val > 0 ? `+${val}` : val}</span>
        <input type="range" min="-12" max="12" step="0.5" value="${val}" data-band="${idx}" />
        <span class="eq-freq">${label}</span>
      `;
      const input = div.querySelector('input');
      input.addEventListener('input', async (e) => {
        const db = parseFloat(e.target.value);
        $(`eqDb${idx}`).textContent = db > 0 ? `+${db}` : String(db);
        engine.setEqBand(idx, db);
        $('eqPresetSelect').value = 'Custom';
        const nextBands = [...engine.eqBands];
        await window.yumaAPI.store.updateSettings({ eqBands: nextBands, eqPreset: 'Custom' });
      });
      container.appendChild(div);
    });
  }

  function drawVisualizers() {
    const data = engine?.getSpectrum();
    const canvases = [
      { el: $('heroVisualizer'), color: '#6c8cff' },
      { el: $('sideVisualizer'), color: '#a855f7' }
    ];

    for (const { el, color } of canvases) {
      if (!el) continue;
      const ctx = el.getContext('2d');
      const w = el.width;
      const h = el.height;
      ctx.clearRect(0, 0, w, h);

      const bars = 32;
      const barWidth = w / bars - 3;
      const now = performance.now() / 220;
      for (let i = 0; i < bars; i++) {
        let val = 0.08;
        if (state.activeBackend === 'local' && data) {
          val = data[i] / 255;
        } else if (state.activeBackend === 'ytm' && state.isPlaying) {
          val = 0.25 + 0.5 * Math.abs(Math.sin(now + i * 0.45) * Math.cos(now * 0.6 + i * 0.2));
        }
        const barH = Math.max(4, val * (h - 8));
        const grad = ctx.createLinearGradient(0, h - barH, 0, h);
        grad.addColorStop(0, color);
        grad.addColorStop(1, 'rgba(255,255,255,0.22)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(i * (barWidth + 3), h - barH, barWidth, barH, 3);
        ctx.fill();
      }
    }

    visualizerRaf = requestAnimationFrame(drawVisualizers);
  }

  async function runHybridSearch(query) {
    const q = query.trim();
    if (!q) return;
    switchView('search');
    $('searchMeta').textContent = `Searching for "${q}"...`;

    const localMatches = state.localTracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q.toLowerCase()) ||
        t.artist.toLowerCase().includes(q.toLowerCase()) ||
        (t.album || '').toLowerCase().includes(q.toLowerCase())
    );

    if (localMatches.length > 0) {
      $('localSearchBlock').classList.remove('hidden');
      renderTrackList('localSearchList', localMatches, '');
    } else {
      $('localSearchBlock').classList.add('hidden');
    }

    $('ytSearchList').innerHTML = '<div class="empty-state glass-panel">Searching YouTube Music...</div>';
    try {
      const results = await window.yumaAPI.music.search(q);
      state.ytSearchResults = results;
      renderTrackList('ytSearchList', results, 'No matching songs found on YouTube Music.');
      $('searchMeta').textContent = `Found ${localMatches.length} local + ${results.length} YouTube Music tracks`;
    } catch {
      $('ytSearchList').innerHTML = '<div class="empty-state glass-panel">YouTube Music search failed (check internet connection).</div>';
      $('searchMeta').textContent = `Found ${localMatches.length} local tracks (offline)`;
    }
  }

  async function loadDiscovery() {
    $('discoveryShelves').innerHTML = '<div class="empty-state glass-panel">Loading discovery mixes...</div>';
    try {
      state.discoverySections = await window.yumaAPI.music.getHome();
    } catch {
      state.discoverySections = [];
    }
    renderDiscovery();
  }

  function wireEvents() {
    // Window controls
    $('minBtn').addEventListener('click', () => window.yumaAPI.windowControls.minimize());
    $('maxBtn').addEventListener('click', () => window.yumaAPI.windowControls.maximize());
    $('closeBtn').addEventListener('click', () => window.yumaAPI.windowControls.close());

    // Floating Island Navigation
    document.querySelectorAll('.nav-pill').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Side Tabs
    document.querySelectorAll('.side-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchSideTab(btn.dataset.sideTab));
    });

    // Library Sub-tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.lib-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        $(`lib-panel-${btn.dataset.libTab}`)?.classList.add('active');
      });
    });

    // Search
    const searchInput = $('globalSearchInput');
    searchInput.addEventListener('input', (e) => {
      $('clearSearchBtn').classList.toggle('hidden', !e.target.value);
      clearTimeout(searchDebounce);
      if (e.target.value.trim().length >= 2) {
        searchDebounce = setTimeout(() => runHybridSearch(e.target.value), 500);
      }
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchDebounce);
        runHybridSearch(e.target.value);
      }
    });
    $('clearSearchBtn').addEventListener('click', () => {
      searchInput.value = '';
      $('clearSearchBtn').classList.add('hidden');
      switchView('discover');
    });

    // Local folder & file pickers
    const handleAddFolder = async () => {
      const res = await window.yumaAPI.library.pickFolder();
      if (!res.canceled) {
        state.store.localFolders = res.folders;
        state.localTracks = res.tracks;
        renderFolders();
        renderLocalTracks();
        switchView('library');
        showToast(`Scanned ${res.tracks.length} local audio tracks`);
      }
    };
    $('addFolderBtn').addEventListener('click', handleAddFolder);
    $('heroAddFolderBtn').addEventListener('click', handleAddFolder);

    $('rescanBtn').addEventListener('click', async () => {
      const res = await window.yumaAPI.library.scan();
      state.localTracks = res.tracks;
      renderLocalTracks();
      showToast(`Rescanned ${res.tracks.length} local tracks`);
    });

    $('openFilesQuickBtn').addEventListener('click', async () => {
      const res = await window.yumaAPI.library.pickFiles();
      if (!res.canceled && res.tracks.length > 0) {
        playTrackWithContext(res.tracks[0], res.tracks);
      }
    });

    $('heroRefreshFeedBtn').addEventListener('click', loadDiscovery);

    // Drag & Drop audio files anywhere on window
    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files || []);
      const paths = files.map((f) => window.yumaAPI.getPathForFile(f)).filter(Boolean);
      if (paths.length > 0) {
        const tracks = await window.yumaAPI.library.parsePaths(paths);
        if (tracks.length > 0) {
          playTrackWithContext(tracks[0], tracks);
          showToast(`Loaded ${tracks.length} dropped audio file(s)`);
        }
      }
    });

    // Transport Controls
    $('playPauseBtn').addEventListener('click', () => toggleCurrentPlay());
    $('nextBtn').addEventListener('click', () => nextTrack());
    $('prevBtn').addEventListener('click', () => prevTrack());
    $('shuffleBtn').addEventListener('click', (e) => {
      state.shuffle = !state.shuffle;
      e.currentTarget.classList.toggle('active', state.shuffle);
    });
    $('repeatBtn').addEventListener('click', (e) => {
      state.repeat = !state.repeat;
      e.currentTarget.classList.toggle('active', state.repeat);
    });

    $('seekSlider').addEventListener('input', (e) => {
      seekCurrent(parseFloat(e.target.value));
    });

    $('volumeSlider').addEventListener('input', async (e) => {
      const vol = parseFloat(e.target.value);
      engine.setVolume(vol);
      window.yumaAPI.ytmPlayer.setVolume(vol);
      await window.yumaAPI.store.updateSettings({ volume: vol });
    });

    $('quickLyricsBtn').addEventListener('click', () => switchSideTab('lyrics'));

    $('npLikeBtn').addEventListener('click', async () => {
      if (!state.currentTrack) return;
      const res = await window.yumaAPI.store.toggleLike(state.currentTrack);
      state.store.likedTracks = res.likedTracks;
      renderNowPlaying(state.currentTrack);
      renderLiked();
    });

    $('clearQueueBtn').addEventListener('click', () => {
      state.queue = state.currentTrack ? [state.currentTrack] : [];
      state.queueIndex = state.currentTrack ? 0 : -1;
      renderQueue();
    });

    // Playlists
    $('createPlaylistBtn').addEventListener('click', async () => {
      const input = $('newPlaylistInput');
      if (!input.value.trim()) return;
      const pl = await window.yumaAPI.store.createPlaylist(input.value);
      state.store.playlists.push(pl);
      input.value = '';
      renderPlaylists();
    });
    $('closePlaylistModal').addEventListener('click', () => $('playlistModal').classList.add('hidden'));

    // DSP & Settings controls
    $('crossfadeSlider').addEventListener('input', async (e) => {
      const sec = parseInt(e.target.value, 10);
      $('crossfadeValue').textContent = `${sec}s`;
      engine.setCrossfade(sec, $('bassSwapToggle').checked);
      await window.yumaAPI.store.updateSettings({ crossfadeSeconds: sec });
    });

    $('bassSwapToggle').addEventListener('change', async (e) => {
      engine.setCrossfade(parseInt($('crossfadeSlider').value, 10), e.target.checked);
      await window.yumaAPI.store.updateSettings({ bassSwap: e.target.checked });
    });

    $('sponsorBlockToggle').addEventListener('change', async (e) => {
      state.store.settings.sponsorBlockEnabled = e.target.checked;
      await window.yumaAPI.store.updateSettings({ sponsorBlockEnabled: e.target.checked });
    });

    $('ambientToggle').addEventListener('change', async (e) => {
      state.store.settings.ambientBackdrop = e.target.checked;
      $('ambientBackdrop').style.opacity = e.target.checked ? '1' : '0';
      await window.yumaAPI.store.updateSettings({ ambientBackdrop: e.target.checked });
    });

    $('eqPresetSelect').addEventListener('change', async (e) => {
      const preset = e.target.value;
      if (!EQ_PRESETS[preset]) return;
      const bands = [...EQ_PRESETS[preset]];
      engine.setAllEqBands(bands);
      state.store.settings.eqBands = bands;
      state.store.settings.eqPreset = preset;
      buildEqUI();
      await window.yumaAPI.store.updateSettings({ eqPreset: preset, eqBands: bands });
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggleCurrentPlay();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInput.focus();
      }
    });

    // App Updater & Upstream Sync
    $('checkUpdatesBtn').addEventListener('click', async () => {
      $('updateStatusText').textContent = 'Checking GitHub...';
      await window.yumaAPI.updater.check();
    });

    $('downloadUpdateBtn').addEventListener('click', async () => {
      const res = await window.yumaAPI.updater.download();
      if (!res.started && res.url) {
        window.yumaAPI.openExternal(res.url);
      }
    });

    $('installUpdateBtn').addEventListener('click', () => {
      window.yumaAPI.updater.install();
    });

    window.yumaAPI.updater.onStatus((status) => renderUpdaterStatus(status));
  }

  function renderUpdaterStatus(status) {
    if (!status) return;
    $('updateStatusText').textContent = `v${status.currentVersion} — ${status.message}`;
    $('downloadUpdateBtn').classList.toggle('hidden', status.state !== 'available');
    $('installUpdateBtn').classList.toggle('hidden', status.state !== 'downloaded');

    if (status.state === 'available') {
      showToast(`Update v${status.availableVersion} available!`);
    } else if (status.state === 'downloaded') {
      showToast(`Update v${status.availableVersion} downloaded — ready to install!`);
    }

    if (status.upstream) {
      $('upstreamStatusText').textContent = `Latest upstream: ${status.upstream.tag} (${status.upstream.name})`;
      const btn = $('openUpstreamBtn');
      btn.classList.remove('hidden');
      btn.onclick = () => window.yumaAPI.openExternal(status.upstream.url);
    }
  }

  async function bootstrap() {
    const cfg = await window.yumaAPI.getConfig();
    state.streamPort = cfg.streamPort;
    state.store = await window.yumaAPI.store.getState();

    const s = state.store.settings;
    engine = new DualDeckAudioEngine({
      onTimeUpdate: (cur, dur) => {
        const slider = $('seekSlider');
        slider.max = dur > 0 ? dur : 100;
        slider.value = cur;
        $('currentTimeLabel').textContent = formatTime(cur);
        $('durationLabel').textContent = formatTime(dur);
        syncLyricsHighlight(cur);
        checkSponsorBlock(cur);
      },
      onCrossfadeTrigger: () => nextTrack({ useCrossfade: true }),
      onEnded: () => nextTrack({ useCrossfade: false }),
      onPlayStateChange: (playing) => {
        state.isPlaying = playing;
        $('playPauseBtn').textContent = playing ? '⏸' : '▶';
      },
      onError: (msg) => showToast(msg)
    });

    engine.setVolume(s.volume);
    engine.setCrossfade(s.crossfadeSeconds, s.bassSwap);
    engine.setAllEqBands(s.eqBands);

    window.yumaAPI.ytmPlayer.onState((ytState) => {
      if (state.activeBackend !== 'ytm' || ytState.videoId !== state.currentTrack?.videoId) return;
      if (ytState.isAd) return;
      const cur = ytState.currentTime || 0;
      const dur = ytState.duration || 0;
      const slider = $('seekSlider');
      slider.max = dur > 0 ? dur : 100;
      slider.value = cur;
      $('currentTimeLabel').textContent = formatTime(cur);
      $('durationLabel').textContent = formatTime(dur);
      state.isPlaying = !ytState.paused && !ytState.ended;
      $('playPauseBtn').textContent = state.isPlaying ? '⏸' : '▶';
      syncLyricsHighlight(cur);
      checkSponsorBlock(cur);
      if (ytState.ended) {
        nextTrack({ useCrossfade: false });
      }
    });

    // Sync Settings UI
    $('volumeSlider').value = s.volume;
    $('crossfadeSlider').value = s.crossfadeSeconds;
    $('crossfadeValue').textContent = `${s.crossfadeSeconds}s`;
    $('bassSwapToggle').checked = s.bassSwap;
    $('sponsorBlockToggle').checked = s.sponsorBlockEnabled;
    $('ambientToggle').checked = s.ambientBackdrop;
    $('ambientBackdrop').style.opacity = s.ambientBackdrop ? '1' : '0';
    $('eqPresetSelect').value = s.eqPreset || 'Flat';
    buildEqUI();

    wireEvents();
    renderFolders();
    renderLiked();
    renderHistory();
    renderPlaylists();
    renderQueue();
    drawVisualizers();

    // Scan saved local folders & load online discovery in parallel
    window.yumaAPI.library.scan().then((res) => {
      state.localTracks = res.tracks || [];
      renderLocalTracks();
    });
    loadDiscovery();
  }

  bootstrap();
})();
