(function () {
  const { parseLrc, findActiveLineIndex } = window.LrcParser;
  const { EQ_FREQUENCIES, EQ_PRESETS, DualDeckAudioEngine } = window.YumaAudio;

  const SPEED_STEPS = [1.0, 1.25, 1.5, 0.75];

  const state = {
    streamPort: 0,
    store: null,
    localTracks: [],
    discoverySections: [],
    ytSearchResults: [],
    videoResults: [],
    searchMode: 'all',
    queue: [],
    queueIndex: -1,
    currentTrack: null,
    activeBackend: 'local', // 'local' | 'ytm' | 'localVideo'
    videoMode: false,
    isPlaying: false,
    shuffle: false,
    repeatMode: 'off', // 'off' | 'all' | 'one'
    playbackRate: 1.0,
    sleepTimerId: null,
    sleepEndTime: 0,
    sleepTickId: null,
    lyricsLines: [],
    activeLyricIndex: -1,
    sponsorSegments: [],
    lastSkippedSegmentStart: -1,
    pendingPlaylistTrack: null,
    currentView: 'discover',
    viewHistory: ['discover'],
    viewHistoryIndex: 0
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
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
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

  function updateGreeting() {
    const hr = new Date().getHours();
    const label = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    $('greetingHeading').textContent = label;
  }

  function getTrackStreamUrl(track) {
    return `http://127.0.0.1:${state.streamPort}/local?path=${encodeURIComponent(track.filePath)}`;
  }

  function isLiked(trackId) {
    return Boolean(state.store?.likedTracks?.some((t) => t.id === trackId));
  }

  function switchView(viewName, { recordHistory = true } = {}) {
    state.currentView = viewName;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.querySelectorAll('.side-nav-item').forEach((b) => b.classList.remove('active'));
    $(`view-${viewName}`)?.classList.add('active');
    document.querySelector(`.side-nav-item[data-view="${viewName}"]`)?.classList.add('active');

    if (recordHistory && state.viewHistory[state.viewHistoryIndex] !== viewName) {
      state.viewHistory = state.viewHistory.slice(0, state.viewHistoryIndex + 1);
      state.viewHistory.push(viewName);
      state.viewHistoryIndex = state.viewHistory.length - 1;
    }

    syncVideoStageVisibility();
  }

  function switchSideTab(tabName) {
    document.querySelectorAll('.side-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.side-content').forEach((c) => c.classList.remove('active'));
    document.querySelector(`.side-tab[data-side-tab="${tabName}"]`)?.classList.add('active');
    $(`side-${tabName}`)?.classList.add('active');
  }

  function syncVideoStageVisibility() {
    const showYtmVideo =
      state.activeBackend === 'ytm' &&
      state.videoMode &&
      state.currentView === 'videos' &&
      $('cinemaOverlay').classList.contains('hidden');

    const showLocalVideo = state.activeBackend === 'localVideo' && state.currentView === 'videos';
    const localVideoEl = $('localVideoPlayer');
    const placeholder = $('videoPlaceholder');

    localVideoEl.classList.toggle('hidden', !showLocalVideo);
    placeholder.classList.toggle('hidden', showYtmVideo || showLocalVideo);

    if (showYtmVideo) {
      const host = $('videoStageHost');
      const rect = host.getBoundingClientRect();
      window.yumaAPI.ytmPlayer.setStage(true, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      });
    } else {
      window.yumaAPI.ytmPlayer.setStage(false, { x: 0, y: 0, width: 0, height: 0 });
    }
  }

  function updateAmbientFromArtwork(src) {
    if (!state.store?.settings?.ambientBackdrop) return;
    if (!src) {
      document.documentElement.style.setProperty('--accent', '#1ed760');
      document.documentElement.style.setProperty('--accent-2', '#6366f1');
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
            r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
          }
        }
        if (count > 0) {
          r = Math.min(255, Math.round(r / count) + 25);
          g = Math.min(255, Math.round(g / count) + 20);
          b = Math.min(255, Math.round(b / count) + 35);
          document.documentElement.style.setProperty('--accent', `rgb(${r}, ${g}, ${b})`);
          document.documentElement.style.setProperty('--accent-2', `rgb(${Math.max(60, b)}, ${Math.max(50, r)}, ${Math.min(255, g + 45)})`);
          document.documentElement.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.42)`);
        }
      } catch {
        // ignore cross-origin canvas errors
      }
    };
    img.src = src;
  }

  function setPlayingUiState(playing) {
    state.isPlaying = playing;
    $('playPauseBtn').textContent = playing ? '⏸' : '▶';
    $('npArtworkWrap').classList.toggle('playing-pulse', playing);
    renderAllLists();
  }

  async function playTrackAtIndex(index, { useCrossfade = false, forceVideo = null } = {}) {
    if (index < 0 || index >= state.queue.length) return;
    state.queueIndex = index;
    const track = state.queue[index];
    state.currentTrack = track;
    state.sponsorSegments = [];
    state.lastSkippedSegmentStart = -1;

    const wantVideo = forceVideo !== null ? forceVideo : track.mediaType === 'video';
    state.videoMode = wantVideo;

    renderNowPlaying(track);
    renderQueue();
    updateAmbientFromArtwork(track.artwork);

    const localVid = $('localVideoPlayer');
    try {
      if (track.source === 'youtube') {
        engine.stop();
        localVid.pause();
        localVid.removeAttribute('src');
        state.activeBackend = 'ytm';
        setPlayingUiState(true);
        if (wantVideo) switchView('videos');
        syncVideoStageVisibility();
        await window.yumaAPI.ytmPlayer.setVolume(state.store?.settings?.volume ?? 0.85);
        await window.yumaAPI.ytmPlayer.setPlaybackRate(state.playbackRate);
        await window.yumaAPI.ytmPlayer.play(track.videoId, wantVideo);
      } else if (track.mediaType === 'video') {
        await window.yumaAPI.ytmPlayer.stop();
        engine.stop();
        state.activeBackend = 'localVideo';
        switchView('videos');
        syncVideoStageVisibility();
        localVid.src = getTrackStreamUrl(track);
        localVid.volume = state.store?.settings?.volume ?? 0.85;
        localVid.playbackRate = state.playbackRate;
        await localVid.play();
        setPlayingUiState(true);
      } else {
        await window.yumaAPI.ytmPlayer.stop();
        localVid.pause();
        localVid.removeAttribute('src');
        state.activeBackend = 'local';
        syncVideoStageVisibility();
        await engine.playUrl(getTrackStreamUrl(track), { useCrossfade });
        setPlayingUiState(true);
      }

      state.store.history = await window.yumaAPI.store.addHistory(track);
      renderHistory();
      renderQuickPicks();
    } catch (err) {
      showToast(`Playback failed: ${err.message || 'Check connection or media file'}`);
    }

    loadTrackExtras(track);
  }

  async function playTrackWithContext(track, trackList = [track], opts = {}) {
    const list = Array.isArray(trackList) && trackList.length > 0 ? trackList : [track];
    state.queue = [...list];
    const idx = state.queue.findIndex((t) => t.id === track.id);
    await playTrackAtIndex(idx >= 0 ? idx : 0, opts);
  }

  async function loadTrackExtras(track) {
    $('lyricsContainer').innerHTML = '<div class="empty-state">Searching synced lyrics...</div>';
    $('cinemaLyricsContainer').innerHTML = '<div class="empty-state">Searching lyrics...</div>';
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
        const html = `<pre style="white-space:pre-wrap;font-family:inherit;line-height:1.6;color:var(--text-muted);font-size:13.5px;">${escapeHtml(res.plainLyrics)}</pre>`;
        $('lyricsContainer').innerHTML = html;
        $('cinemaLyricsContainer').innerHTML = html;
      } else {
        $('lyricsContainer').innerHTML = '<div class="empty-state">No lyrics found for this track.</div>';
        $('cinemaLyricsContainer').innerHTML = '<div class="empty-state">No lyrics found.</div>';
      }
    } catch {
      $('lyricsContainer').innerHTML = '<div class="empty-state">Unable to load lyrics.</div>';
    }

    const sponsorBadge = $('npSponsorBadge');
    sponsorBadge.classList.add('hidden');
    if (track.source === 'youtube' && state.store?.settings?.sponsorBlockEnabled) {
      try {
        const segs = await window.yumaAPI.music.getSponsorSegments(track.videoId);
        if (state.currentTrack?.id !== track.id) return;
        state.sponsorSegments = Array.isArray(segs) ? segs : [];
        if (state.sponsorSegments.length > 0) {
          sponsorBadge.classList.remove('hidden');
          sponsorBadge.textContent = `SponsorBlock (${state.sponsorSegments.length})`;
        }
      } catch {
        // ignore
      }
    }
  }

  function renderNowPlaying(track) {
    $('npTitle').textContent = track.title;
    $('npArtist').textContent = `${track.artist}${track.album ? ` • ${track.album}` : ''}`;
    $('barTitle').textContent = track.title;
    $('barArtist').textContent = track.artist;
    $('cinemaTitle').textContent = track.title;
    $('cinemaArtist').textContent = track.artist;

    const setArt = (imgEl, phEl) => {
      if (track.artwork) {
        imgEl.src = track.artwork;
        imgEl.classList.remove('hidden');
        phEl.classList.add('hidden');
      } else {
        imgEl.classList.add('hidden');
        phEl.classList.remove('hidden');
      }
    };
    setArt($('npArtwork'), $('npArtworkPlaceholder'));
    setArt($('barThumb'), $('barThumbPlaceholder'));
    setArt($('cinemaArt'), $('cinemaArtPh'));

    const badge = $('npCodecBadge');
    badge.classList.remove('lossless', 'video');
    if (track.mediaType === 'video') {
      badge.textContent = track.source === 'youtube' ? 'VIDEO SONG • HD' : `VIDEO • ${track.codec || 'MP4'}`;
      badge.classList.add('video');
    } else if (track.lossless) {
      const sr = track.sampleRate ? ` • ${Math.round(track.sampleRate / 1000)}kHz` : '';
      const bd = track.bitDepth ? `/${track.bitDepth}bit` : '';
      badge.textContent = `HI-RES ${track.codec || 'FLAC'}${bd}${sr}`;
      badge.classList.add('lossless');
    } else {
      badge.textContent = track.source === 'youtube' ? 'YOUTUBE MUSIC • OPUS' : (track.codec || 'LOCAL AUDIO');
    }

    $('cinemaBadge').textContent = badge.textContent;

    const isYt = track.source === 'youtube';
    $('npSwitchVideoBtn').classList.toggle('hidden', !isYt);
    $('barVideoToggleBtn').classList.toggle('hidden', !isYt);
    $('npSwitchVideoBtn').textContent = state.videoMode ? '🎵 Audio Mode' : '🎬 Watch Video';

    const liked = isLiked(track.id);
    ['npLikeBtn', 'barLikeBtn'].forEach((id) => {
      const btn = $(id);
      btn.textContent = liked ? '♥' : '♡';
      btn.classList.toggle('liked', liked);
    });
  }

  function seekCurrent(seconds) {
    if (state.activeBackend === 'ytm') {
      window.yumaAPI.ytmPlayer.seek(seconds);
    } else if (state.activeBackend === 'localVideo') {
      const v = $('localVideoPlayer');
      if (Number.isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration, seconds));
    } else {
      engine.seek(seconds);
    }
  }

  function toggleCurrentPlay() {
    if (!state.currentTrack) return;
    if (state.activeBackend === 'ytm') {
      if (state.isPlaying) {
        window.yumaAPI.ytmPlayer.pause();
        setPlayingUiState(false);
      } else {
        window.yumaAPI.ytmPlayer.resume();
        setPlayingUiState(true);
      }
    } else if (state.activeBackend === 'localVideo') {
      const v = $('localVideoPlayer');
      if (v.paused) {
        v.play();
        setPlayingUiState(true);
      } else {
        v.pause();
        setPlayingUiState(false);
      }
    } else {
      engine.togglePlay();
    }
  }

  function toggleVideoMode() {
    if (!state.currentTrack || state.currentTrack.source !== 'youtube') return;
    state.videoMode = !state.videoMode;
    renderNowPlaying(state.currentTrack);
    if (state.videoMode) {
      switchView('videos');
      showToast('Switched to Video Song Stage');
    } else {
      syncVideoStageVisibility();
      showToast('Switched to Audio Mode');
    }
  }

  function renderLyricsLines() {
    const targets = [$('lyricsContainer'), $('cinemaLyricsContainer')];
    targets.forEach((container) => {
      container.innerHTML = '';
      state.lyricsLines.forEach((line, idx) => {
        const div = document.createElement('div');
        div.className = 'lyric-line';
        div.dataset.idx = String(idx);
        div.textContent = line.text;
        div.addEventListener('click', () => seekCurrent(line.time));
        container.appendChild(div);
      });
    });
  }

  function syncLyricsHighlight(currentTime) {
    if (!state.lyricsLines.length) return;
    const idx = findActiveLineIndex(state.lyricsLines, currentTime);
    if (idx === state.activeLyricIndex) return;
    state.activeLyricIndex = idx;

    [$('lyricsContainer'), $('cinemaLyricsContainer')].forEach((container) => {
      container.querySelectorAll('.lyric-line').forEach((el, i) => {
        el.classList.toggle('active', i === idx);
      });
      const activeEl = container.querySelector(`.lyric-line[data-idx="${idx}"]`);
      if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
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
    if (state.repeatMode === 'one') {
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
    if (state.queueIndex + 1 >= state.queue.length && state.repeatMode === 'off') {
      setPlayingUiState(false);
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
    const isCurrent = state.currentTrack?.id === track.id;
    row.className = `track-row ${isCurrent ? 'playing' : ''}`;

    const eqOverlay =
      isCurrent && state.isPlaying
        ? '<div class="eq-bars-overlay"><span></span><span></span><span></span></div>'
        : '';

    const thumbHtml = track.artwork
      ? `<div class="track-thumb-wrap"><img class="track-thumb" src="${escapeHtml(track.artwork)}" alt="" loading="lazy" />${eqOverlay}</div>`
      : `<div class="track-thumb-wrap"><div class="track-thumb">${track.mediaType === 'video' ? '🎬' : '♪'}</div>${eqOverlay}</div>`;

    const liked = isLiked(track.id);
    const badgeClass =
      track.mediaType === 'video'
        ? 'codec-badge video'
        : track.lossless
        ? 'codec-badge lossless'
        : 'codec-badge';
    const badgeText =
      track.mediaType === 'video'
        ? 'VIDEO'
        : track.lossless
        ? track.codec || 'FLAC'
        : track.source === 'youtube'
        ? 'YTM'
        : track.codec || 'AUDIO';

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
      renderSidebarLibrary();
      if (state.currentTrack?.id === track.id) renderNowPlaying(track);
    });

    return row;
  }

  function renderTrackList(containerId, tracks, emptyMsg) {
    const container = $(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (!tracks || tracks.length === 0) {
      container.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
      return;
    }
    tracks.forEach((t) => container.appendChild(createTrackRow(t, tracks)));
  }

  function renderQuickPicks() {
    const grid = $('quickPicksGrid');
    if (!grid) return;
    const pool = [
      ...(state.store?.history || []),
      ...(state.store?.likedTracks || []),
      ...(state.discoverySections[0]?.tracks || [])
    ];
    const unique = [];
    const seen = new Set();
    for (const t of pool) {
      if (t && !seen.has(t.id)) {
        seen.add(t.id);
        unique.push(t);
      }
      if (unique.length >= 6) break;
    }

    grid.innerHTML = '';
    unique.forEach((track) => {
      const card = document.createElement('div');
      card.className = 'quick-pick-card';
      card.innerHTML = `
        <img src="${escapeHtml(track.artwork || '')}" alt="" loading="lazy" />
        <span>${escapeHtml(track.title)}</span>
        <div class="qp-play">▶</div>
      `;
      card.addEventListener('click', () => playTrackWithContext(track, unique));
      grid.appendChild(card);
    });
  }

  function renderDiscovery() {
    renderQuickPicks();
    const container = $('discoveryShelves');
    container.innerHTML = '';
    if (!state.discoverySections.length) {
      container.innerHTML = '<div class="empty-state">Connect to the internet to load mixes, or add local folders from Your Library.</div>';
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
          <div class="card-art-wrap">
            <img src="${escapeHtml(track.artwork || '')}" alt="" loading="lazy" />
            <div class="card-play-fab">▶</div>
          </div>
          <div class="card-title">${escapeHtml(track.title)}</div>
          <div class="card-sub">${escapeHtml(track.artist)}</div>
        `;
        card.addEventListener('click', () => playTrackWithContext(track, sec.tracks));
        grid.appendChild(card);
      });

      container.appendChild(shelf);
    }
  }

  function renderSidebarLibrary() {
    $('sidebarLikedCount').textContent = `${state.store?.likedTracks?.length || 0} tracks`;
    const container = $('sidebarCustomPlaylists');
    container.innerHTML = '';
    (state.store?.playlists || []).forEach((pl) => {
      const div = document.createElement('div');
      div.className = 'sidebar-pl-item';
      div.innerHTML = `
        <div class="pl-thumb">♫</div>
        <div class="pl-text">
          <strong>${escapeHtml(pl.name)}</strong>
          <span class="muted">${pl.tracks.length} tracks</span>
        </div>
      `;
      div.addEventListener('click', () => {
        switchView('library');
        document.querySelector('.tab-btn[data-lib-tab="playlists"]')?.click();
      });
      container.appendChild(div);
    });
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
    const audioTracks = state.localTracks.filter((t) => t.mediaType !== 'video');
    const videoTracks = state.localTracks.filter((t) => t.mediaType === 'video');
    renderTrackList(
      'localTracksList',
      audioTracks,
      'No local audio files found. Click <strong>+ Add Music/Video Folder</strong> or drag &amp; drop files!'
    );
    renderTrackList(
      'localVideosList',
      videoTracks,
      'No local video songs (.mp4, .mkv, .webm) found in your added folders.'
    );
    renderVideoSongsList();
  }

  function renderVideoSongsList() {
    const localVideos = state.localTracks.filter((t) => t.mediaType === 'video');
    const combined = [...localVideos, ...state.videoResults];
    renderTrackList(
      'videoSongsList',
      combined,
      'Click <strong>Search Music Videos</strong> or open local .mp4/.webm video songs to watch here.'
    );
  }

  function renderLiked() {
    renderTrackList('likedTracksList', state.store?.likedTracks || [], 'No liked songs yet. Click ♡ on any track.');
  }

  function renderHistory() {
    renderTrackList('historyTracksList', state.store?.history || [], 'Your recently played tracks will appear here.');
  }

  function renderPlaylists() {
    renderSidebarLibrary();
    const container = $('playlistsContainer');
    container.innerHTML = '';
    const playlists = state.store?.playlists || [];
    if (playlists.length === 0) {
      container.innerHTML = '<div class="empty-state">Create a playlist above to organize songs and video songs together.</div>';
      return;
    }

    playlists.forEach((pl) => {
      const card = document.createElement('div');
      card.className = 'playlist-card';
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
      renderTrackList('ytSearchList', state.ytSearchResults, 'No results found.');
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
      { el: $('heroVisualizer'), color: '#1ed760' },
      { el: $('sideVisualizer'), color: '#22d3ee' },
      { el: $('cinemaVisualizer'), color: '#1ed760' }
    ];

    // Audio-reactive halo intensity
    let energy = 0.08;
    if (state.activeBackend === 'local' && data && state.isPlaying) {
      let sum = 0;
      for (let i = 0; i < 8; i++) sum += data[i];
      energy = sum / (8 * 255);
    } else if (state.isPlaying) {
      energy = 0.32 + 0.25 * Math.abs(Math.sin(performance.now() / 320));
    }

    const halo = $('npHalo');
    if (halo) {
      halo.style.transform = `scale(${(1 + energy * 0.22).toFixed(3)})`;
      halo.style.opacity = state.isPlaying ? String((0.45 + energy * 0.45).toFixed(2)) : '0.2';
    }

    const now = performance.now() / 210;
    for (const { el, color } of canvases) {
      if (!el) continue;
      const ctx = el.getContext('2d');
      const w = el.width;
      const h = el.height;
      ctx.clearRect(0, 0, w, h);

      const bars = 32;
      const barWidth = w / bars - 3;
      for (let i = 0; i < bars; i++) {
        let val = 0.07;
        if (state.activeBackend === 'local' && data && state.isPlaying) {
          val = data[i] / 255;
        } else if (state.isPlaying) {
          val = 0.22 + 0.52 * Math.abs(Math.sin(now + i * 0.42) * Math.cos(now * 0.55 + i * 0.19));
        }
        const barH = Math.max(4, val * (h - 8));
        const grad = ctx.createLinearGradient(0, h - barH, 0, h);
        grad.addColorStop(0, color);
        grad.addColorStop(1, 'rgba(168, 85, 247, 0.35)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(i * (barWidth + 3), h - barH, barWidth, barH, 3);
        ctx.fill();
      }
    }

    visualizerRaf = requestAnimationFrame(drawVisualizers);
  }

  async function runHybridSearch(query, mode = state.searchMode) {
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

    $('ytSearchList').innerHTML = '<div class="empty-state">Searching online...</div>';
    try {
      const results = await window.yumaAPI.music.search(q, mode);
      state.ytSearchResults = results;
      if (mode === 'videos') {
        state.videoResults = results;
        renderVideoSongsList();
      }
      renderTrackList('ytSearchList', results, 'No matching songs or videos found.');
      $('searchMeta').textContent = `Found ${localMatches.length} local + ${results.length} online results`;
    } catch {
      $('ytSearchList').innerHTML = '<div class="empty-state">Online search failed (check internet connection).</div>';
    }
  }

  async function loadDiscovery() {
    $('discoveryShelves').innerHTML = '<div class="empty-state">Loading discovery mixes...</div>';
    try {
      state.discoverySections = await window.yumaAPI.music.getHome();
    } catch {
      state.discoverySections = [];
    }
    renderDiscovery();
    // Seed recommended video songs shelf silently
    window.yumaAPI.music
      .search('latest hit music video 2026', 'videos')
      .then((vids) => {
        state.videoResults = vids || [];
        renderVideoSongsList();
      })
      .catch(() => {});
  }

  function setSleepTimer(minutes) {
    clearTimeout(state.sleepTimerId);
    clearInterval(state.sleepTickId);
    const btn = $('sleepTimerBtn');

    if (!minutes || minutes <= 0) {
      state.sleepEndTime = 0;
      btn.textContent = '🌙';
      btn.classList.remove('active');
      showToast('Sleep timer turned off');
      return;
    }

    state.sleepEndTime = Date.now() + minutes * 60 * 1000;
    btn.classList.add('active');
    const updateLabel = () => {
      const remMin = Math.max(1, Math.ceil((state.sleepEndTime - Date.now()) / 60000));
      btn.textContent = `🌙 ${remMin}m`;
    };
    updateLabel();
    state.sleepTickId = setInterval(updateLabel, 15000);
    state.sleepTimerId = setTimeout(() => {
      if (state.isPlaying) toggleCurrentPlay();
      setSleepTimer(0);
      showToast('Sleep timer paused playback');
    }, minutes * 60 * 1000);
    showToast(`Sleep timer set for ${minutes} minutes`);
  }

  function renderUpdaterStatus(status) {
    if (!status) return;
    $('updateStatusText').textContent = `v${status.currentVersion} — ${status.message}`;

    const isAvail = status.state === 'available';
    const isDl = status.state === 'downloading';
    const isReady = status.state === 'downloaded';

    $('downloadUpdateBtn').classList.toggle('hidden', !isAvail);
    $('installUpdateBtn').classList.toggle('hidden', !isReady);
    $('updateProgressWrap').classList.toggle('hidden', !isDl && !isReady);
    $('updateProgressFill').style.width = `${status.progress || 0}%`;
    $('updateProgressPct').textContent = `${status.progress || 0}%`;

    const pill = $('updateBadgeBtn');
    if (isAvail || isDl || isReady) {
      pill.classList.remove('hidden');
      $('updatePillText').textContent = isReady
        ? 'Restart & Update'
        : isDl
        ? `Updating ${status.progress || 0}%`
        : `Update v${status.availableVersion}`;
    } else {
      pill.classList.add('hidden');
    }

    if (status.pcRelease?.notes) {
      $('releaseNotesBox').classList.remove('hidden');
      $('releaseNotesBox').textContent = `Release Notes (${status.pcRelease.tag}):\n${status.pcRelease.notes}`;
    }

    if (status.upstream) {
      $('upstreamStatusText').textContent = `Latest Android release: ${status.upstream.name}`;
      $('upstreamTagBadge').textContent = status.upstream.tag;
    }
  }

  function wireEvents() {
    // Window controls
    $('minBtn').addEventListener('click', () => window.yumaAPI.windowControls.minimize());
    $('maxBtn').addEventListener('click', () => window.yumaAPI.windowControls.maximize());
    $('closeBtn').addEventListener('click', () => window.yumaAPI.windowControls.close());

    // Back / Forward navigation
    $('navBackBtn').addEventListener('click', () => {
      if (state.viewHistoryIndex > 0) {
        state.viewHistoryIndex--;
        switchView(state.viewHistory[state.viewHistoryIndex], { recordHistory: false });
      }
    });
    $('navFwdBtn').addEventListener('click', () => {
      if (state.viewHistoryIndex < state.viewHistory.length - 1) {
        state.viewHistoryIndex++;
        switchView(state.viewHistory[state.viewHistoryIndex], { recordHistory: false });
      }
    });

    // Left Sidebar Navigation
    document.querySelectorAll('.side-nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
    $('sidebarLikedItem').addEventListener('click', () => {
      switchView('library');
      document.querySelector('.tab-btn[data-lib-tab="liked"]')?.click();
    });
    $('sidebarNewPlBtn').addEventListener('click', () => {
      switchView('library');
      document.querySelector('.tab-btn[data-lib-tab="playlists"]')?.click();
      $('newPlaylistInput').focus();
    });

    // Side Tabs
    document.querySelectorAll('.side-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchSideTab(btn.dataset.sideTab));
    });

    // Search Mode Tabs
    document.querySelectorAll('.tab-btn[data-search-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn[data-search-mode]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.searchMode = btn.dataset.searchMode;
        if ($('globalSearchInput').value.trim()) {
          runHybridSearch($('globalSearchInput').value, state.searchMode);
        }
      });
    });

    // Library Sub-tabs
    document.querySelectorAll('.tab-btn[data-lib-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn[data-lib-tab]').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.lib-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        $(`lib-panel-${btn.dataset.libTab}`)?.classList.add('active');
      });
    });

    // Search Input
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

    $('videoSearchTriggerBtn').addEventListener('click', () => {
      document.querySelector('.tab-btn[data-search-mode="videos"]')?.click();
      switchView('search');
      searchInput.focus();
    });

    $('videoTheaterBtn').addEventListener('click', () => {
      $('cinemaOverlay').classList.remove('hidden');
      syncVideoStageVisibility();
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
        showToast(`Scanned ${res.tracks.length} local media files`);
      }
    };
    $('addFolderBtn').addEventListener('click', handleAddFolder);
    $('heroAddFolderBtn').addEventListener('click', handleAddFolder);

    $('rescanBtn').addEventListener('click', async () => {
      const res = await window.yumaAPI.library.scan();
      state.localTracks = res.tracks;
      renderLocalTracks();
      showToast(`Rescanned ${res.tracks.length} local files`);
    });

    $('openFilesQuickBtn').addEventListener('click', async () => {
      const res = await window.yumaAPI.library.pickFiles();
      if (!res.canceled && res.tracks.length > 0) {
        playTrackWithContext(res.tracks[0], res.tracks);
      }
    });

    $('heroRefreshFeedBtn').addEventListener('click', loadDiscovery);

    // Drag & Drop Audio or Video Files
    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files || []);
      const paths = files.map((f) => window.yumaAPI.getPathForFile(f)).filter(Boolean);
      if (paths.length > 0) {
        const tracks = await window.yumaAPI.library.parsePaths(paths);
        if (tracks.length > 0) {
          playTrackWithContext(tracks[0], tracks);
          showToast(`Loaded ${tracks.length} dropped file(s)`);
        }
      }
    });

    // Local Video Player Events
    const localVid = $('localVideoPlayer');
    localVid.addEventListener('timeupdate', () => {
      if (state.activeBackend !== 'localVideo') return;
      const cur = localVid.currentTime || 0;
      const dur = Number.isFinite(localVid.duration) ? localVid.duration : 0;
      $('seekSlider').max = dur > 0 ? dur : 100;
      $('seekSlider').value = cur;
      $('currentTimeLabel').textContent = formatTime(cur);
      $('durationLabel').textContent = formatTime(dur);
      syncLyricsHighlight(cur);
    });
    localVid.addEventListener('ended', () => {
      if (state.activeBackend === 'localVideo') nextTrack();
    });

    // Transport Controls
    $('playPauseBtn').addEventListener('click', toggleCurrentPlay);
    $('nextBtn').addEventListener('click', () => nextTrack());
    $('prevBtn').addEventListener('click', prevTrack);

    $('shuffleBtn').addEventListener('click', (e) => {
      state.shuffle = !state.shuffle;
      e.currentTarget.classList.toggle('active', state.shuffle);
      showToast(state.shuffle ? 'Shuffle On' : 'Shuffle Off');
    });

    $('repeatBtn').addEventListener('click', (e) => {
      const order = ['off', 'all', 'one'];
      state.repeatMode = order[(order.indexOf(state.repeatMode) + 1) % order.length];
      e.currentTarget.textContent = state.repeatMode === 'one' ? '↻¹' : '↻';
      e.currentTarget.classList.toggle('active', state.repeatMode !== 'off');
      showToast(`Repeat: ${state.repeatMode.toUpperCase()}`);
    });

    $('seekSlider').addEventListener('input', (e) => seekCurrent(parseFloat(e.target.value)));

    $('volumeSlider').addEventListener('input', async (e) => {
      const vol = parseFloat(e.target.value);
      engine.setVolume(vol);
      window.yumaAPI.ytmPlayer.setVolume(vol);
      localVid.volume = vol;
      await window.yumaAPI.store.updateSettings({ volume: vol });
    });

    $('speedBtn').addEventListener('click', () => {
      const nextIdx = (SPEED_STEPS.indexOf(state.playbackRate) + 1) % SPEED_STEPS.length;
      state.playbackRate = SPEED_STEPS[nextIdx];
      $('speedBtn').textContent = `${state.playbackRate}x`;
      engine.setPlaybackRate(state.playbackRate);
      window.yumaAPI.ytmPlayer.setPlaybackRate(state.playbackRate);
      localVid.playbackRate = state.playbackRate;
      showToast(`Playback speed: ${state.playbackRate}x`);
    });

    $('sleepTimerBtn').addEventListener('click', () => $('sleepModal').classList.remove('hidden'));
    $('closeSleepModal').addEventListener('click', () => $('sleepModal').classList.add('hidden'));
    document.querySelectorAll('.sleep-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        setSleepTimer(parseInt(btn.dataset.mins, 10));
        $('sleepModal').classList.add('hidden');
      });
    });

    $('quickLyricsBtn').addEventListener('click', () => switchSideTab('lyrics'));
    $('quickQueueBtn').addEventListener('click', () => switchSideTab('queue'));

    $('npSwitchVideoBtn').addEventListener('click', toggleVideoMode);
    $('barVideoToggleBtn').addEventListener('click', toggleVideoMode);

    $('cinemaBtn').addEventListener('click', () => {
      $('cinemaOverlay').classList.remove('hidden');
      syncVideoStageVisibility();
    });
    $('closeCinemaBtn').addEventListener('click', () => {
      $('cinemaOverlay').classList.add('hidden');
      syncVideoStageVisibility();
    });

    const toggleCurrentLike = async () => {
      if (!state.currentTrack) return;
      const res = await window.yumaAPI.store.toggleLike(state.currentTrack);
      state.store.likedTracks = res.likedTracks;
      renderNowPlaying(state.currentTrack);
      renderLiked();
      renderSidebarLibrary();
    };
    $('npLikeBtn').addEventListener('click', toggleCurrentLike);
    $('barLikeBtn').addEventListener('click', toggleCurrentLike);

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

    // DSP & Settings
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

    // Keyboard shortcuts & Global Media Keys
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggleCurrentPlay();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInput.focus();
      } else if (e.key === 'Escape' && !$('cinemaOverlay').classList.contains('hidden')) {
        $('cinemaOverlay').classList.add('hidden');
        syncVideoStageVisibility();
      }
    });

    window.yumaAPI.onMediaCommand((cmd) => {
      if (cmd === 'toggle') toggleCurrentPlay();
      if (cmd === 'next') nextTrack();
      if (cmd === 'prev') prevTrack();
    });

    // In-App Updater (No browser redirects!)
    $('updateBadgeBtn').addEventListener('click', () => switchView('updates'));
    $('checkUpdatesBtn').addEventListener('click', async () => {
      $('updateStatusText').textContent = 'Checking GitHub Releases...';
      await window.yumaAPI.updater.check();
    });
    $('downloadUpdateBtn').addEventListener('click', async () => {
      await window.yumaAPI.updater.download();
    });
    $('installUpdateBtn').addEventListener('click', () => {
      window.yumaAPI.updater.install();
    });
    window.yumaAPI.updater.onStatus(renderUpdaterStatus);

    // Keep WebContentsView video stage aligned on window resize
    const ro = new ResizeObserver(() => syncVideoStageVisibility());
    ro.observe($('videoStageHost'));
    window.addEventListener('resize', syncVideoStageVisibility);
  }

  async function bootstrap() {
    updateGreeting();
    const cfg = await window.yumaAPI.getConfig();
    state.streamPort = cfg.streamPort;
    state.store = await window.yumaAPI.store.getState();

    const s = state.store.settings;
    engine = new DualDeckAudioEngine({
      onTimeUpdate: (cur, dur) => {
        if (state.activeBackend !== 'local') return;
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
        if (state.activeBackend === 'local') setPlayingUiState(playing);
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
      const playingNow = !ytState.paused && !ytState.ended;
      if (playingNow !== state.isPlaying) {
        setPlayingUiState(playingNow);
      }
      syncLyricsHighlight(cur);
      checkSponsorBlock(cur);
      if (ytState.ended) {
        nextTrack({ useCrossfade: false });
      }
    });

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

    window.yumaAPI.library.scan().then((res) => {
      state.localTracks = res.tracks || [];
      renderLocalTracks();
    });
    loadDiscovery();
  }

  bootstrap();
})();
