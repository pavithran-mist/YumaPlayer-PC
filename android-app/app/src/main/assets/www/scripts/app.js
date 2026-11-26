(function () {
  const { parseLrc, findActiveLineIndex } = window.LrcParser;
  const { EQ_FREQUENCIES, EQ_PRESETS, DualDeckAudioEngine } = window.YumaAudio;
  const ICONS = window.YumaIcons;

  const SPEED_STEPS = [1.0, 1.25, 1.5, 0.75];

  const state = {
    streamPort: 0,
    store: null,
    localTracks: [],
    discoverySections: [],
    ytSearchResults: [],
    videoResults: [],
    searchMode: 'all',
    homeFilter: 'all',
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
    viewHistoryIndex: 0,
    playingContext: 'YumaPlayer Mix',
    activePlaylistSpec: null,
    librarySort: 'recent',
    libraryFilter: '',
    isRefillingQueue: false,
    isAdvancing: false
  };

  let engine = null;
  let toastTimer = null;
  let searchDebounce = null;

  const $ = (id) => document.getElementById(id);

  function hydrateIcons() {
    document.querySelectorAll('[data-icon]').forEach((el) => {
      const name = el.getAttribute('data-icon');
      if (ICONS[name]) el.innerHTML = ICONS[name];
    });
    $('playPauseBtn').innerHTML = ICONS.play;
    $('cinemaPlayBtn').innerHTML = ICONS.play;
    $('sleepTimerBtn').innerHTML = ICONS.moon;
    if ($('cinemaSleepBtn')) $('cinemaSleepBtn').innerHTML = ICONS.moon;
    $('npLikeBtn').innerHTML = ICONS.heart;
    $('barLikeBtn').innerHTML = ICONS.heart;
    if ($('cinemaLikeBtn')) $('cinemaLikeBtn').innerHTML = ICONS.heart;
  }

  function dismissSplash() {
    const splash = $('splashOverlay');
    if (!splash) return;
    const hide = () => {
      splash.classList.add('fade-out');
      setTimeout(() => splash.classList.add('hidden'), 460);
    };
    splash.addEventListener('click', hide, { once: true });
    setTimeout(hide, 550);
  }

  function getHdArtwork(track) {
    if (!track) return '';
    let url = track.artwork || '';
    if (!url && track.videoId) {
      return `https://i.ytimg.com/vi/${track.videoId}/maxresdefault.jpg`;
    }
    if (url.includes('googleusercontent.com') || url.includes('ggpht.com')) {
      if (/=w\d+-h\d+/.test(url)) return url.replace(/=w\d+-h\d+[^?#]*/, '=w1200-h1200-l95-rj');
      if (/=s\d+/.test(url)) return url.replace(/=s\d+[^?#]*/, '=s1200');
    }
    if (url.includes('ytimg.com/vi/')) {
      return url.replace(/\/(default|mqdefault|hqdefault|sddefault)\.jpg/, '/maxresdefault.jpg');
    }
    return url;
  }

  function applyArtWithFallback(imgEl, track) {
    if (!imgEl || !track) return;
    const hd = getHdArtwork(track);
    imgEl.onerror = () => {
      if (track.videoId && !imgEl.src.includes('hqdefault.jpg')) {
        imgEl.src = `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`;
      }
    };
    imgEl.src = hd;
  }

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

  function updateGreeting() {
    const hr = new Date().getHours();
    $('greetingHeading').textContent =
      hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  }

  function getTrackStreamUrl(track) {
    if (window.YumaAndroid) {
      return `http://127.0.0.1:${state.streamPort}/local?uri=${encodeURIComponent(track.filePath)}`;
    }
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
    const cinemaOpen = !$('cinemaOverlay').classList.contains('hidden');
    const isYtmVideo = state.activeBackend === 'ytm' && state.videoMode;
    const isLocalVideo = state.activeBackend === 'localVideo';

    const showInlineYtm = isYtmVideo && state.currentView === 'videos' && !cinemaOpen;
    const showCinemaYtm = isYtmVideo && cinemaOpen;
    const showInlineLocal = isLocalVideo && state.currentView === 'videos' && !cinemaOpen;
    const showCinemaLocal = isLocalVideo && cinemaOpen;

    const localVideoEl = $('localVideoPlayer');
    const inlineHost = $('videoStageHost');
    const cinemaVideoStage = $('cinemaVideoStage');
    const cinemaAudioBody = $('cinemaAudioBody');

    if (showCinemaLocal) {
      if (localVideoEl.parentElement !== cinemaVideoStage) {
        cinemaVideoStage.appendChild(localVideoEl);
      }
      localVideoEl.classList.remove('hidden');
    } else {
      if (localVideoEl.parentElement !== inlineHost) {
        inlineHost.insertBefore(localVideoEl, inlineHost.firstChild);
      }
      localVideoEl.classList.toggle('hidden', !showInlineLocal);
    }

    $('videoPlaceholder').classList.toggle('hidden', showInlineYtm || showInlineLocal);
    cinemaVideoStage.classList.toggle('hidden', !showCinemaYtm && !showCinemaLocal);
    cinemaAudioBody.classList.toggle('hidden', showCinemaYtm || showCinemaLocal);

    if (showCinemaYtm) {
      const rect = cinemaVideoStage.getBoundingClientRect();
      window.yumaAPI.ytmPlayer.setStage(true, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      });
    } else if (showInlineYtm) {
      const rect = inlineHost.getBoundingClientRect();
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

  function openCinema() {
    $('cinemaOverlay').classList.remove('hidden');
    window.yumaAPI.windowControls.setFullscreen(true);
    kickVisualizerLoop();
    setTimeout(syncVideoStageVisibility, 80);
  }

  function closeCinema() {
    $('cinemaOverlay').classList.add('hidden');
    window.yumaAPI.windowControls.setFullscreen(false);
    setTimeout(syncVideoStageVisibility, 80);
  }

  function updateAmbientFromArtwork(src) {
    if (!state.store?.settings?.ambientBackdrop || !src) {
      document.documentElement.style.setProperty('--wash-color', 'rgba(229, 9, 20, 0.28)');
      document.documentElement.style.setProperty('--wash-secondary', 'rgba(120, 12, 24, 0.12)');
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
          if (data[i] + data[i + 1] + data[i + 2] > 65) {
            r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
          }
        }
        if (count > 0) {
          r = Math.min(240, Math.round(r / count));
          g = Math.min(240, Math.round(g / count));
          b = Math.min(240, Math.round(b / count));
          document.documentElement.style.setProperty('--wash-color', `rgba(${r}, ${g}, ${b}, 0.34)`);
          document.documentElement.style.setProperty('--wash-secondary', `rgba(${r}, ${g}, ${b}, 0.10)`);
        }
      } catch {
        // ignore cross-origin canvas restrictions
      }
    };
    img.src = src;
  }

  function syncActiveTrackHighlights() {
    const curId = state.currentTrack?.id || null;
    document.querySelectorAll('.track-row').forEach((row) => {
      const match = Boolean(curId && row.dataset.trackId === curId);
      if (row.classList.contains('playing') === match && (!match || row.dataset.playingState === String(state.isPlaying))) {
        return;
      }
      row.classList.toggle('playing', match);
      row.dataset.playingState = String(state.isPlaying);
      const idxCell = row.querySelector('.track-idx');
      if (idxCell) {
        const num = row.dataset.trackNum || '';
        idxCell.innerHTML =
          match && state.isPlaying
            ? `<div class="eq-bars-inline"><span></span><span></span><span></span></div><span class="row-play-icon">${ICONS.pause}</span>`
            : `<span class="row-num">${num}</span><span class="row-play-icon">${ICONS.play}</span>`;
      }
    });
    document.querySelectorAll('.queue-row').forEach((row, idx) => {
      const isCur = idx === state.queueIndex;
      row.classList.toggle('playing', isCur);
      const span = row.querySelector('span');
      if (span) span.innerHTML = isCur && state.isPlaying ? ICONS.play : String(idx + 1);
    });
  }

  function setPlayingUiState(playing) {
    state.isPlaying = playing;
    const icon = playing ? ICONS.pause : ICONS.play;
    $('playPauseBtn').innerHTML = icon;
    $('cinemaPlayBtn').innerHTML = icon;
    if (window.YumaAndroid && state.currentTrack) {
      window.YumaAndroid.updateMediaNotification(
        state.currentTrack.title || 'YumaPlayer',
        state.currentTrack.artist || 'by Pavithran',
        Boolean(playing)
      );
    }
    syncActiveTrackHighlights();
    if (playing) kickVisualizerLoop();
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
    syncActiveTrackHighlights();
    updateAmbientFromArtwork(getHdArtwork(track));

    const localVid = $('localVideoPlayer');
    const targetVol = state.store?.settings?.volume ?? 0.85;
    try {
      if (track.source === 'youtube') {
        engine.stop();
        localVid.pause();
        localVid.removeAttribute('src');
        state.activeBackend = 'ytm';
        setPlayingUiState(true);
        if (wantVideo) switchView('videos');
        syncVideoStageVisibility();
        window.yumaAPI.ytmPlayer.setVolume(targetVol);
        window.yumaAPI.ytmPlayer.setPlaybackRate(state.playbackRate);
        await window.yumaAPI.ytmPlayer.play(track.videoId, wantVideo);
      } else if (track.mediaType === 'video') {
        window.yumaAPI.ytmPlayer.stop();
        engine.stop();
        state.activeBackend = 'localVideo';
        switchView('videos');
        syncVideoStageVisibility();
        localVid.src = getTrackStreamUrl(track);
        localVid.volume = targetVol;
        localVid.playbackRate = state.playbackRate;
        await localVid.play();
        setPlayingUiState(true);
      } else {
        window.yumaAPI.ytmPlayer.stop();
        localVid.pause();
        localVid.removeAttribute('src');
        state.activeBackend = 'local';
        syncVideoStageVisibility();
        await engine.playUrl(getTrackStreamUrl(track), { useCrossfade });
        setPlayingUiState(true);
      }

      window.yumaAPI.store.addHistory(track).then((hist) => {
        state.store.history = hist;
        setTimeout(() => {
          if (state.currentView === 'library') renderHistory();
          if (state.currentView === 'discover') renderQuickPicks();
        }, 60);
      });
    } catch (err) {
      showToast(`Playback failed: ${err.message || 'Check connection or file'}`);
    }

    loadTrackExtras(track);
    if (state.store?.settings?.endlessQueue !== false && state.queue.length - 1 - index <= 2) {
      ensureEndlessQueue(track);
    }
  }

  async function ensureEndlessQueue(seedTrack = state.currentTrack) {
    if (state.isRefillingQueue || !seedTrack || state.store?.settings?.endlessQueue === false) return 0;
    state.isRefillingQueue = true;
    try {
      const fallbackQuery = `${seedTrack.artist || ''} ${seedTrack.title || ''}`.trim();
      const radio = await window.yumaAPI.music.getUpNext(seedTrack.videoId || null, fallbackQuery);
      const existingIds = new Set(state.queue.map((t) => t.id));
      const existingVidIds = new Set(state.queue.map((t) => t.videoId).filter(Boolean));
      const fresh = (Array.isArray(radio) ? radio : []).filter(
        (t) => t && !existingIds.has(t.id) && (!t.videoId || !existingVidIds.has(t.videoId))
      );
      if (fresh.length > 0) {
        state.queue.push(...fresh.slice(0, 15));
        renderQueue();
        return fresh.length;
      }
      // Offline local fallback: queue unplayed local tracks
      const localExtra = state.localTracks.filter((t) => !existingIds.has(t.id));
      if (localExtra.length > 0) {
        state.queue.push(...localExtra.slice(0, 10));
        renderQueue();
        return localExtra.length;
      }
      return 0;
    } catch {
      return 0;
    } finally {
      state.isRefillingQueue = false;
    }
  }

  async function playTrackWithContext(track, trackList = [track], opts = {}) {
    const list = Array.isArray(trackList) && trackList.length > 0 ? trackList : [track];
    state.queue = [...list];
    if (opts.contextName) state.playingContext = opts.contextName;
    else if (state.currentView === 'search') state.playingContext = 'Search Results';
    else if (state.currentView === 'videos') state.playingContext = 'Video Songs';
    else if (state.currentView === 'library') state.playingContext = 'Your Library';
    else state.playingContext = 'YumaPlayer Mix';
    const idx = state.queue.findIndex((t) => t.id === track.id);
    await playTrackAtIndex(idx >= 0 ? idx : 0, opts);
  }

  async function loadTrackExtras(track) {
    $('lyricsContainer').innerHTML = '<div class="empty-state">Searching lyrics...</div>';
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
        $('lyricsSourceBadge').textContent = `Lyrics • ${res.source}`;
        const html = `<pre style="white-space:pre-wrap;font-family:inherit;line-height:1.6;color:var(--text-secondary);font-size:13.5px;">${escapeHtml(res.plainLyrics)}</pre>`;
        $('lyricsContainer').innerHTML = html;
        $('cinemaLyricsContainer').innerHTML = html;
      } else {
        $('lyricsContainer').innerHTML = '<div class="empty-state">No lyrics found for this song.</div>';
        $('cinemaLyricsContainer').innerHTML = '<div class="empty-state">No lyrics available.</div>';
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
    $('npArtist').textContent = track.artist;
    $('barTitle').textContent = track.title;
    $('barArtist').textContent = track.artist;
    $('cinemaTitle').textContent = track.title;
    $('cinemaArtist').textContent = track.artist;
    $('cinemaBarTitle').textContent = track.title;
    $('cinemaBarArtist').textContent = track.artist;

    const setArt = (imgEl, phEl) => {
      const hdUrl = getHdArtwork(track);
      if (hdUrl) {
        applyArtWithFallback(imgEl, track);
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
      badge.textContent = track.source === 'youtube' ? 'VIDEO SONG' : `VIDEO • ${track.codec || 'MP4'}`;
      badge.classList.add('video');
    } else if (track.lossless) {
      const sr = track.sampleRate ? ` • ${Math.round(track.sampleRate / 1000)}kHz` : '';
      const bd = track.bitDepth ? `/${track.bitDepth}bit` : '';
      badge.textContent = `${track.codec || 'FLAC'}${bd}${sr}`;
      badge.classList.add('lossless');
    } else {
      badge.textContent = track.source === 'youtube' ? 'YOUTUBE MUSIC' : (track.codec || 'AUDIO');
    }

    $('cinemaBadge').textContent = state.playingContext || badge.textContent;

    const isYt = track.source === 'youtube';
    $('npSwitchVideoBtn').classList.toggle('hidden', !isYt);
    $('barVideoToggleBtn').classList.toggle('hidden', !isYt);
    $('cinemaVideoToggleBtn').classList.toggle('hidden', !isYt);
    const modeLabel = state.videoMode ? `${ICONS.music} Audio Mode` : `${ICONS.video} Watch Video`;
    $('npSwitchVideoBtn').innerHTML = modeLabel;
    $('cinemaVideoToggleBtn').innerHTML = modeLabel;

    const liked = isLiked(track.id);
    ['npLikeBtn', 'barLikeBtn', 'cinemaLikeBtn'].forEach((id) => {
      const btn = $(id);
      if (!btn) return;
      btn.innerHTML = liked ? ICONS.heartFilled : ICONS.heart;
      btn.classList.toggle('liked', liked);
    });
  }

  function updateProgressUi(cur, dur) {
    const maxVal = dur > 0 ? dur : 100;
    $('seekSlider').max = maxVal;
    $('seekSlider').value = cur;
    $('cinemaSeekSlider').max = maxVal;
    $('cinemaSeekSlider').value = cur;
    const pct = dur > 0 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
    const miniFill = $('miniProgressFill');
    if (miniFill) miniFill.style.width = `${pct}%`;
    const curText = formatTime(cur);
    const durText = formatTime(dur);
    $('currentTimeLabel').textContent = curText;
    $('durationLabel').textContent = durText;
    $('cinemaCurTime').textContent = curText;
    $('cinemaDurTime').textContent = durText;
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
    const cinemaOpen = !$('cinemaOverlay').classList.contains('hidden');
    if (state.videoMode && !cinemaOpen) {
      switchView('videos');
    } else {
      syncVideoStageVisibility();
    }
  }

  function renderLyricsLines() {
    [$('lyricsContainer'), $('cinemaLyricsContainer')].forEach((container) => {
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
        showToast(`Skipped ${seg.category}`);
        break;
      }
    }
  }

  async function nextTrack({ useCrossfade = false } = {}) {
    if (!state.queue.length || state.isAdvancing) return;
    state.isAdvancing = true;
    try {
      if (state.repeatMode === 'one') {
        await playTrackAtIndex(state.queueIndex, { useCrossfade });
        return;
      }
      if (state.shuffle && state.queue.length > 1) {
        let randIdx = state.queueIndex;
        while (randIdx === state.queueIndex) {
          randIdx = Math.floor(Math.random() * state.queue.length);
        }
        await playTrackAtIndex(randIdx, { useCrossfade });
        return;
      }
      if (state.queueIndex + 1 >= state.queue.length) {
        if (state.store?.settings?.endlessQueue !== false) {
          const added = await ensureEndlessQueue(state.currentTrack);
          if (added > 0) {
            await playTrackAtIndex(state.queueIndex + 1, { useCrossfade });
            return;
          }
        }
        if (state.repeatMode === 'off') {
          setPlayingUiState(false);
          return;
        }
      }
      const nextIdx = (state.queueIndex + 1) % state.queue.length;
      await playTrackAtIndex(nextIdx, { useCrossfade });
    } finally {
      state.isAdvancing = false;
    }
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

  function openTrackMenu(track, opts = {}) {
    if (!track) return;
    $('trackMenuTitle').textContent = track.title || 'Track';
    $('trackMenuSub').textContent = `${track.artist || 'Unknown'} • ${track.album || 'Single'}`;
    const list = $('trackMenuActions');
    list.innerHTML = '';

    const addItem = (label, onClick) => {
      const btn = document.createElement('button');
      btn.className = 'glass-btn sheet-action-btn';
      btn.textContent = label;
      btn.addEventListener('click', async () => {
        $('trackMenuModal').classList.add('hidden');
        await onClick();
      });
      list.appendChild(btn);
    };

    addItem('Play Now', () => playTrackWithContext(track, [track], { contextName: state.playingContext }));
    addItem('Play Next', () => {
      const insertIdx = Math.max(0, state.queueIndex + 1);
      state.queue.splice(insertIdx, 0, track);
      renderQueue();
      showToast('Will play next');
    });
    addItem('Add to Queue', () => {
      state.queue.push(track);
      renderQueue();
      showToast('Added to queue');
    });
    addItem(isLiked(track.id) ? 'Remove from Liked Songs' : 'Save to Liked Songs', async () => {
      const res = await window.yumaAPI.store.toggleLike(track);
      state.store.likedTracks = res.likedTracks;
      renderAllLists();
      renderSidebarLibrary();
      if (state.currentTrack?.id === track.id) renderNowPlaying(track);
      if (state.currentView === 'playlist' && state.activePlaylistSpec) {
        if (state.activePlaylistSpec.kind === 'liked') state.activePlaylistSpec.tracks = res.likedTracks;
        openPlaylistDetail(state.activePlaylistSpec, { keepHistory: true });
      }
      showToast(res.liked ? 'Saved to Liked Songs' : 'Removed from Liked Songs');
    });
    addItem('Add to Playlist...', () => openPlaylistModal(track));
    if (opts.playlistId) {
      addItem('Remove from this Playlist', async () => {
        const updated = await window.yumaAPI.store.removeFromPlaylist(opts.playlistId, track.id);
        const pl = state.store.playlists.find((p) => p.id === opts.playlistId);
        if (pl && updated) pl.tracks = updated.tracks;
        renderAllLists();
        if (state.currentView === 'playlist' && state.activePlaylistSpec?.id === opts.playlistId) {
          state.activePlaylistSpec.tracks = pl ? pl.tracks : [];
          openPlaylistDetail(state.activePlaylistSpec, { keepHistory: true });
        }
        showToast('Removed from playlist');
      });
    }
    if (track.source === 'youtube') {
      addItem(state.videoMode ? 'Switch to Audio Mode' : 'Watch Video Version', () => {
        if (state.currentTrack?.id === track.id) toggleVideoMode();
        else playTrackWithContext(track, [track], { forceVideo: true });
      });
    }
    addItem('View Lyrics', () => {
      if (state.currentTrack?.id !== track.id) {
        playTrackWithContext(track, [track]).then(() => {
          if (window.innerWidth <= 900) {
            openCinema();
            $('cinemaOverlay').classList.add('show-lyrics');
          } else switchSideTab('lyrics');
        });
      } else if (window.innerWidth <= 900) {
        openCinema();
        $('cinemaOverlay').classList.add('show-lyrics');
      } else {
        switchSideTab('lyrics');
      }
    });

    $('trackMenuModal').classList.remove('hidden');
  }

  function createTrackRow(track, index, listContext, opts = {}) {
    const row = document.createElement('div');
    const isCurrent = state.currentTrack?.id === track.id;
    row.className = `track-row ${isCurrent ? 'playing' : ''}`;
    row.dataset.trackId = track.id || '';
    row.dataset.trackNum = String(index + 1);

    const idxHtml =
      isCurrent && state.isPlaying
        ? `<div class="eq-bars-inline"><span></span><span></span><span></span></div><span class="row-play-icon">${ICONS.pause}</span>`
        : `<span class="row-num">${index + 1}</span><span class="row-play-icon">${ICONS.play}</span>`;

    const thumbUrl = getHdArtwork(track);
    const thumbHtml = thumbUrl
      ? `<img class="track-thumb" src="${escapeHtml(thumbUrl)}" alt="" loading="lazy" />`
      : `<div class="track-thumb">${track.mediaType === 'video' ? ICONS.video : ICONS.music}</div>`;

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
      <div class="track-idx">${idxHtml}</div>
      <div class="track-main">
        ${thumbHtml}
        <div class="track-meta">
          <div class="track-name">${escapeHtml(track.title)}</div>
          <div class="track-sub">${escapeHtml(track.artist)}</div>
        </div>
      </div>
      <div class="track-album">${escapeHtml(track.album || 'Single')}</div>
      <div><span class="${badgeClass}">${escapeHtml(badgeText)}</span></div>
      <div class="track-right-cell">
        <div class="track-actions">
          <button class="icon-btn row-queue" title="Add to queue">${ICONS.plus}</button>
          <button class="icon-btn row-playlist" title="Add to playlist">${ICONS.listPlus}</button>
          <button class="icon-btn row-like ${liked ? 'liked' : ''}" title="Save to Liked Songs">${liked ? ICONS.heartFilled : ICONS.heart}</button>
          <button class="icon-btn row-more" title="More options">${ICONS.moreVert}</button>
        </div>
        <span class="track-dur">${formatTime(track.duration)}</span>
      </div>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (isCurrent) {
        toggleCurrentPlay();
      } else {
        playTrackWithContext(track, listContext, { contextName: opts.contextName });
      }
    });

    row.querySelector('.row-queue').addEventListener('click', () => {
      state.queue.push(track);
      renderQueue();
      showToast('Added to queue');
    });

    row.querySelector('.row-playlist').addEventListener('click', () => openPlaylistModal(track));

    row.querySelector('.row-like').addEventListener('click', async () => {
      const res = await window.yumaAPI.store.toggleLike(track);
      state.store.likedTracks = res.likedTracks;
      renderAllLists();
      renderSidebarLibrary();
      if (state.currentTrack?.id === track.id) renderNowPlaying(track);
    });

    row.querySelector('.row-more')?.addEventListener('click', () => openTrackMenu(track, opts));

    return row;
  }

  function renderTrackList(containerId, tracks, emptyMsg, opts = {}) {
    const container = $(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (!tracks || tracks.length === 0) {
      container.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
      return;
    }
    tracks.forEach((t, idx) => container.appendChild(createTrackRow(t, idx, tracks, opts)));
  }

  function renderQuickPicks() {
    const grid = $('quickPicksGrid');
    if (!grid) return;
    grid.innerHTML = '';

    // Pin Liked Songs & custom Playlists cleanly in Home Quick Picks (matching Spotify 2x4 grid)
    if (state.homeFilter === 'all') {
      const likedCard = document.createElement('div');
      likedCard.className = 'quick-pick-card';
      likedCard.innerHTML = `
        <div class="qp-grad-thumb liked-grad">${ICONS.heartFilled}</div>
        <span>Liked Songs</span>
        <div class="qp-play">${ICONS.play}</div>
      `;
      likedCard.addEventListener('click', () =>
        openPlaylistDetail({
          id: 'liked',
          name: 'Liked Songs',
          description: 'All songs and videos you saved',
          owner: 'Pavithran',
          tracks: state.store?.likedTracks || [],
          kind: 'liked'
        })
      );
      grid.appendChild(likedCard);
    }

    let pool = [];
    if (state.homeFilter === 'videos') {
      pool = [...state.localTracks.filter((t) => t.mediaType === 'video'), ...state.videoResults];
    } else if (state.homeFilter === 'local') {
      pool = state.localTracks;
    } else {
      pool = [
        ...(state.store?.history || []),
        ...(state.store?.likedTracks || []),
        ...(state.discoverySections[0]?.tracks || [])
      ];
    }

    const maxSongs = state.homeFilter === 'all' ? 7 : 8;
    const unique = [];
    const seen = new Set();
    for (const t of pool) {
      if (t && !seen.has(t.id)) {
        seen.add(t.id);
        unique.push(t);
      }
      if (unique.length >= maxSongs) break;
    }

    unique.forEach((track) => {
      const card = document.createElement('div');
      card.className = 'quick-pick-card';
      card.innerHTML = `
        <img src="${escapeHtml(getHdArtwork(track))}" alt="" loading="lazy" />
        <span>${escapeHtml(track.title)}</span>
        <div class="qp-play">${ICONS.play}</div>
      `;
      const imgEl = card.querySelector('img');
      if (imgEl && track.videoId) {
        imgEl.onerror = () => { imgEl.src = `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`; };
      }
      card.addEventListener('click', () => playTrackWithContext(track, unique, { contextName: 'Quick Picks' }));
      grid.appendChild(card);
    });
  }

  function renderDiscovery() {
    renderQuickPicks();
    const container = $('discoveryShelves');
    container.innerHTML = '';

    let sections = state.discoverySections;
    if (state.homeFilter === 'videos') {
      sections = state.videoResults.length ? [{ title: 'Popular Video Songs', tracks: state.videoResults }] : [];
    } else if (state.homeFilter === 'local') {
      sections = state.localTracks.length ? [{ title: 'Your Local Library', tracks: state.localTracks.slice(0, 12) }] : [];
    }

    if (!sections.length) {
      container.innerHTML = '<div class="empty-state">No tracks available in this view yet.</div>';
      return;
    }

    for (const sec of sections) {
      const shelf = document.createElement('div');
      shelf.className = 'shelf';
      shelf.innerHTML = `<div class="shelf-head shelf-clickable"><div class="shelf-title">${escapeHtml(sec.title)}</div><span class="muted shelf-open-link">Open mix ›</span></div><div class="cards-grid"></div>`;
      shelf.querySelector('.shelf-head').addEventListener('click', () => {
        openPlaylistDetail({
          id: `shelf_${sec.title}`,
          name: sec.title,
          description: 'Curated mix from YumaPlayer discovery',
          owner: 'YumaPlayer · Pavithran',
          tracks: sec.tracks,
          kind: 'shelf'
        });
      });
      const grid = shelf.querySelector('.cards-grid');

      sec.tracks.forEach((track) => {
        const card = document.createElement('div');
        card.className = 'music-card';
        card.innerHTML = `
          <div class="card-art-wrap">
            <img src="${escapeHtml(getHdArtwork(track))}" alt="" loading="lazy" />
            <div class="card-play-fab">${ICONS.play}</div>
          </div>
          <div class="card-title">${escapeHtml(track.title)}</div>
          <div class="card-sub">${escapeHtml(track.artist)}</div>
        `;
        const imgEl = card.querySelector('img');
        if (imgEl && track.videoId) {
          imgEl.onerror = () => { imgEl.src = `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`; };
        }
        card.addEventListener('click', () => playTrackWithContext(track, sec.tracks, { contextName: sec.title }));
        grid.appendChild(card);
      });

      container.appendChild(shelf);
    }
  }

  function formatPlaylistDuration(tracks) {
    const totalSec = (tracks || []).reduce((acc, t) => acc + (Number(t?.duration) || 0), 0);
    if (!totalSec) return `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}`;
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.max(1, Math.floor((totalSec % 3600) / 60));
    const durStr = hrs > 0 ? `${hrs}h ${mins}min` : `${mins}min`;
    return `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'} • ${durStr}`;
  }

  function buildCoverArtHtml(spec) {
    if (spec.kind === 'liked') {
      return `<div class="pl-cover-grad liked-grad">${ICONS.heartFilled}</div>`;
    }
    const arts = [];
    const seen = new Set();
    for (const t of spec.tracks || []) {
      const u = getHdArtwork(t);
      if (u && !seen.has(u)) {
        seen.add(u);
        arts.push(u);
      }
      if (arts.length >= 4) break;
    }
    if (arts.length >= 4) {
      return `<div class="pl-collage">${arts.map((u) => `<img src="${escapeHtml(u)}" alt="" />`).join('')}</div>`;
    }
    if (arts.length >= 1) {
      return `<img class="pl-cover-single" src="${escapeHtml(arts[0])}" alt="" />`;
    }
    return `<div class="pl-cover-grad">${ICONS.music}</div>`;
  }

  function openPlaylistDetail(spec, { keepHistory = false } = {}) {
    state.activePlaylistSpec = spec;
    $('plTitle').textContent = spec.name || 'Playlist';
    $('plDesc').textContent = spec.description || '';
    $('plOwner').textContent = spec.owner || 'Pavithran';
    $('plStats').textContent = formatPlaylistDuration(spec.tracks || []);
    $('plTopHint').textContent = spec.kind === 'playlist' ? 'PLAYLIST' : 'COLLECTION';
    $('plCoverWrap').innerHTML = buildCoverArtHtml(spec);
    $('plMiniThumb').innerHTML = buildCoverArtHtml(spec);

    const isEditable = spec.kind === 'playlist';
    $('plInlineAddRow').classList.toggle('hidden', !isEditable);
    $('plAddSongsBtn').classList.toggle('hidden', !isEditable);
    $('plSaveBtn').innerHTML = spec.kind === 'shelf' ? ICONS.plusCircle : ICONS.download;
    $('plPlayAllBtn').innerHTML = ICONS.play;
    $('plHeroBackdrop').style.setProperty('--pl-tint', spec.kind === 'liked' ? '#4c1d95' : '#6b0f1a');

    renderTrackList(
      'plDetailTracksList',
      spec.tracks || [],
      isEditable ? 'Tap "+ Add to this playlist" above to add songs.' : 'No tracks in this collection yet.',
      { playlistId: isEditable ? spec.id : null, contextName: spec.name }
    );

    switchView('playlist', { recordHistory: !keepHistory });
  }

  function openAddSongsModal(playlistId) {
    const modal = $('addSongsModal');
    const listEl = $('addSongsList');
    const filterInput = $('addSongsFilterInput');
    const pl = (state.store?.playlists || []).find((p) => p.id === playlistId);
    if (!pl) return;

    const renderCandidates = () => {
      const q = (filterInput.value || '').trim().toLowerCase();
      const poolMap = new Map();
      [
        ...(state.store?.likedTracks || []),
        ...(state.store?.history || []),
        ...(state.localTracks || []),
        ...(state.discoverySections[0]?.tracks || []),
        ...(state.ytSearchResults || [])
      ].forEach((t) => {
        if (t && t.id && !poolMap.has(t.id)) poolMap.set(t.id, t);
      });
      const existingIds = new Set((pl.tracks || []).map((t) => t.id));
      let items = Array.from(poolMap.values());
      if (q) {
        items = items.filter(
          (t) =>
            (t.title || '').toLowerCase().includes(q) ||
            (t.artist || '').toLowerCase().includes(q)
        );
      }
      listEl.innerHTML = '';
      if (!items.length) {
        listEl.innerHTML = '<div class="empty-state">Search songs in Search tab or type above to match saved tracks.</div>';
        return;
      }
      items.slice(0, 40).forEach((t) => {
        const added = existingIds.has(t.id);
        const row = document.createElement('div');
        row.className = 'add-song-row';
        const thumb = getHdArtwork(t);
        row.innerHTML = `
          ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" />` : `<div class="add-song-ph">${ICONS.music}</div>`}
          <div class="track-meta">
            <div class="track-name">${escapeHtml(t.title)}</div>
            <div class="track-sub">${escapeHtml(t.artist)}</div>
          </div>
          <button class="glass-btn add-pick-btn">${added ? 'Added' : 'Add'}</button>
        `;
        const btn = row.querySelector('button');
        btn.disabled = added;
        btn.addEventListener('click', async () => {
          const updated = await window.yumaAPI.store.addToPlaylist(pl.id, t);
          if (updated) pl.tracks = updated.tracks;
          existingIds.add(t.id);
          btn.textContent = 'Added';
          btn.disabled = true;
          renderPlaylists();
          if (state.currentView === 'playlist' && state.activePlaylistSpec?.id === pl.id) {
            state.activePlaylistSpec.tracks = pl.tracks;
            openPlaylistDetail(state.activePlaylistSpec, { keepHistory: true });
          }
          showToast(`Added to ${pl.name}`);
        });
        listEl.appendChild(row);
      });
    };

    filterInput.value = '';
    filterInput.oninput = renderCandidates;
    renderCandidates();
    modal.classList.remove('hidden');
  }

  function renderLibraryOverview() {
    const container = $('libraryOverviewList');
    if (!container) return;
    container.innerHTML = '';

    const entries = [
      {
        id: 'liked',
        name: 'Liked Songs',
        sub: `Playlist • ${(state.store?.likedTracks || []).length} songs`,
        pinned: true,
        kind: 'liked',
        tracks: state.store?.likedTracks || [],
        description: 'Songs and music videos you liked',
        sortOrder: 0
      },
      {
        id: 'recent',
        name: 'Recently Played',
        sub: `Mix • ${(state.store?.history || []).length} songs`,
        pinned: true,
        kind: 'history',
        tracks: state.store?.history || [],
        description: 'Your recent listening activity',
        sortOrder: 1
      },
      ...(state.store?.playlists || []).map((pl, idx) => ({
        id: pl.id,
        name: pl.name,
        sub: `Playlist • ${pl.tracks.length} ${pl.tracks.length === 1 ? 'song' : 'songs'}`,
        pinned: false,
        kind: 'playlist',
        tracks: pl.tracks || [],
        description: 'Custom playlist • Created in YumaPlayer',
        sortOrder: 10 + idx
      })),
      {
        id: 'local_audio',
        name: 'Local Audio Library',
        sub: `Device Folder • ${state.localTracks.filter((t) => t.mediaType !== 'video').length} tracks`,
        pinned: false,
        kind: 'localAudio',
        tracks: state.localTracks.filter((t) => t.mediaType !== 'video'),
        description: 'Offline FLAC, MP3, WAV & audio files',
        sortOrder: 900
      },
      {
        id: 'local_video',
        name: 'Local Video Songs',
        sub: `Device Folder • ${state.localTracks.filter((t) => t.mediaType === 'video').length} videos`,
        pinned: false,
        kind: 'localVideos',
        tracks: state.localTracks.filter((t) => t.mediaType === 'video'),
        description: 'Offline MP4, MKV & WebM video files',
        sortOrder: 901
      }
    ];

    const q = (state.libraryFilter || '').trim().toLowerCase();
    let visible = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;

    if (state.librarySort === 'alpha') {
      visible = [...visible].sort((a, b) => a.name.localeCompare(b.name));
    } else if (state.librarySort === 'count') {
      visible = [...visible].sort((a, b) => b.tracks.length - a.tracks.length);
    }

    visible.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'lib-ov-row';
      row.innerHTML = `
        <div class="lib-ov-thumb">${buildCoverArtHtml(item)}</div>
        <div class="lib-ov-meta">
          <div class="lib-ov-title">${escapeHtml(item.name)}</div>
          <div class="lib-ov-sub">${item.pinned ? `<span class="pin-badge">${ICONS.pin}</span>` : ''}<span>${escapeHtml(item.sub)}</span></div>
        </div>
      `;
      row.addEventListener('click', () => openPlaylistDetail(item));
      container.appendChild(row);
    });
  }

  function renderSidebarLibrary() {
    const count = state.store?.likedTracks?.length || 0;
    $('sidebarLikedCount').textContent = `${count} ${count === 1 ? 'song' : 'songs'}`;
    const container = $('sidebarCustomPlaylists');
    container.innerHTML = '';
    (state.store?.playlists || []).forEach((pl) => {
      const div = document.createElement('div');
      div.className = 'sidebar-pl-item';
      div.innerHTML = `
        <div class="pl-thumb">${ICONS.music}</div>
        <div class="pl-text">
          <strong>${escapeHtml(pl.name)}</strong>
          <span class="muted">Playlist • ${pl.tracks.length} songs</span>
        </div>
      `;
      div.addEventListener('click', () => {
        openPlaylistDetail({
          id: pl.id,
          name: pl.name,
          description: 'Custom playlist',
          owner: 'Pavithran',
          tracks: pl.tracks || [],
          kind: 'playlist'
        });
      });
      container.appendChild(div);
    });
    renderLibraryOverview();
  }

  function renderFolders() {
    const chips = $('folderChips');
    chips.innerHTML = '';
    (state.store?.localFolders || []).forEach((folder) => {
      const chip = document.createElement('div');
      chip.className = 'folder-chip';
      chip.innerHTML = `${ICONS.folder} <span>${escapeHtml(folder)}</span><button title="Remove folder">${ICONS.close}</button>`;
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
      'No local audio files found. Click <strong>Add Folder</strong> or drag &amp; drop files onto the player.'
    );
    renderTrackList(
      'localVideosList',
      videoTracks,
      'No local video files (.mp4, .mkv, .webm) found in your added folders.'
    );
    renderVideoSongsList();
  }

  function renderVideoSongsList() {
    const localVideos = state.localTracks.filter((t) => t.mediaType === 'video');
    renderTrackList(
      'videoSongsList',
      [...localVideos, ...state.videoResults],
      'Click Find Music Videos or open local .mp4/.webm video songs.'
    );
  }

  function renderLiked() {
    renderTrackList('likedTracksList', state.store?.likedTracks || [], 'Songs you like will appear here.');
  }

  function renderHistory() {
    renderTrackList('historyTracksList', state.store?.history || [], 'No playback history yet.');
  }

  function renderPlaylists() {
    renderSidebarLibrary();
    const container = $('playlistsContainer');
    container.innerHTML = '';
    const playlists = state.store?.playlists || [];
    if (playlists.length === 0) {
      container.innerHTML = '<div class="empty-state">Create a playlist above to organize your songs and video songs.</div>';
      return;
    }

    playlists.forEach((pl) => {
      const card = document.createElement('div');
      card.className = 'playlist-card';
      card.innerHTML = `
        <div class="playlist-card-head">
          <div class="pl-card-open" style="cursor:pointer;">
            <strong>${escapeHtml(pl.name)}</strong>
            <span class="muted"> • ${pl.tracks.length} songs (Open ›)</span>
          </div>
          <div class="hero-actions">
            <button class="spotify-btn pl-play-btn">${ICONS.play} Play</button>
            <button class="icon-btn pl-del-btn" title="Delete Playlist">${ICONS.trash}</button>
          </div>
        </div>
        <div class="track-list pl-tracks"></div>
      `;

      card.querySelector('.pl-card-open').addEventListener('click', () => {
        openPlaylistDetail({
          id: pl.id,
          name: pl.name,
          description: 'Custom playlist',
          owner: 'Pavithran',
          tracks: pl.tracks || [],
          kind: 'playlist'
        });
      });
      card.querySelector('.pl-play-btn').addEventListener('click', () => {
        if (pl.tracks.length > 0) playTrackWithContext(pl.tracks[0], pl.tracks, { contextName: pl.name });
      });
      card.querySelector('.pl-del-btn').addEventListener('click', async () => {
        state.store.playlists = await window.yumaAPI.store.deletePlaylist(pl.id);
        renderPlaylists();
      });

      const listEl = card.querySelector('.pl-tracks');
      pl.tracks.forEach((t, idx) =>
        listEl.appendChild(createTrackRow(t, idx, pl.tracks, { playlistId: pl.id, contextName: pl.name }))
      );
      container.appendChild(card);
    });
  }

  function renderQueue() {
    $('queueCount').textContent = String(state.queue.length);
    const list = $('queueList');
    list.innerHTML = '';
    if (state.queue.length === 0) {
      list.innerHTML = '<div class="empty-state">Your queue is empty.</div>';
      return;
    }
    state.queue.forEach((t, idx) => {
      const isCur = idx === state.queueIndex;
      const row = document.createElement('div');
      row.className = `queue-row ${isCur ? 'playing' : ''}`;
      row.innerHTML = `
        <span class="muted" style="text-align:center">${isCur && state.isPlaying ? ICONS.play : idx + 1}</span>
        <div class="track-meta">
          <div class="track-name">${escapeHtml(t.title)}</div>
          <div class="track-sub">${escapeHtml(t.artist)}</div>
        </div>
        <span class="track-dur">${formatTime(t.duration)}</span>
        <button class="icon-btn" title="Remove">${ICONS.close}</button>
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
    renderLibraryOverview();
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
      list.innerHTML = '<div class="muted">No playlists yet. Create one in Your Library → Playlists.</div>';
    } else {
      playlists.forEach((pl) => {
        const btn = document.createElement('button');
        btn.className = 'glass-btn';
        btn.style.justifyContent = 'space-between';
        btn.innerHTML = `<span>${escapeHtml(pl.name)}</span><span class="muted">${pl.tracks.length}</span>`;
        btn.addEventListener('click', async () => {
          const updated = await window.yumaAPI.store.addToPlaylist(pl.id, state.pendingPlaylistTrack);
          const idx = state.store.playlists.findIndex((p) => p.id === pl.id);
          if (idx >= 0) state.store.playlists[idx] = updated;
          $('playlistModal').classList.add('hidden');
          renderPlaylists();
          showToast(`Added to ${pl.name}`);
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

  let vizRafId = 0;
  function kickVisualizerLoop() {
    if (!vizRafId) {
      vizRafId = requestAnimationFrame(drawVisualizers);
    }
  }

  function drawVisualizers() {
    vizRafId = 0;
    const data = engine?.getSpectrum();
    const canvases = [
      { el: $('sideVisualizer'), color: '#ff2a3c' },
      { el: $('cinemaVisualizer'), color: '#ff2a3c' }
    ];
    const anyVisible = canvases.some((c) => c.el && c.el.offsetParent !== null);

    if (anyVisible) {
      let energy = 0.05;
      if (state.activeBackend === 'local' && data && state.isPlaying) {
        let sum = 0;
        for (let i = 0; i < 8; i++) sum += data[i];
        energy = sum / (8 * 255);
      } else if (state.isPlaying) {
        energy = 0.28 + 0.18 * Math.abs(Math.sin(performance.now() / 340));
      }

      const halo = $('npHalo');
      if (halo) {
        halo.style.transform = `scale(${(1 + energy * 0.14).toFixed(3)})`;
        halo.style.opacity = state.isPlaying ? String((0.3 + energy * 0.4).toFixed(2)) : '0.15';
      }

      const now = performance.now() / 220;
      for (const { el, color } of canvases) {
        if (!el || el.offsetParent === null) continue;
        const ctx = el.getContext('2d');
        const w = el.width;
        const h = el.height;
        ctx.clearRect(0, 0, w, h);

        const bars = 28;
        const barWidth = w / bars - 3;
        for (let i = 0; i < bars; i++) {
          let val = 0.06;
          if (state.activeBackend === 'local' && data && state.isPlaying) {
            val = data[i] / 255;
          } else if (state.isPlaying) {
            val = 0.2 + 0.46 * Math.abs(Math.sin(now + i * 0.45) * Math.cos(now * 0.52 + i * 0.2));
          }
          const barH = Math.max(3, val * (h - 6));
          ctx.fillStyle = state.isPlaying ? color : 'rgba(255,255,255,0.16)';
          ctx.beginPath();
          ctx.roundRect(i * (barWidth + 3), h - barH, barWidth, barH, 2);
          ctx.fill();
        }
      }
    }

    if (state.isPlaying && anyVisible) {
      vizRafId = requestAnimationFrame(drawVisualizers);
    }
  }

  async function runHybridSearch(query, mode = state.searchMode) {
    const q = query.trim();
    if (!q) return;
    switchView('search');
    if ($('globalSearchInput') && $('globalSearchInput').value !== query) $('globalSearchInput').value = query;
    if ($('mobileSearchInput') && $('mobileSearchInput').value !== query) $('mobileSearchInput').value = query;
    $('mobileSearchClearBtn')?.classList.toggle('hidden', !q);
    $('mobileBrowseBlock')?.classList.add('hidden');
    $('view-search')?.classList.add('has-search');
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

    $('ytSearchList').innerHTML = '<div class="empty-state">Searching...</div>';
    try {
      const results = await window.yumaAPI.music.search(q, mode);
      state.ytSearchResults = results;
      if (mode === 'videos') {
        state.videoResults = results;
        renderVideoSongsList();
      }
      renderTrackList('ytSearchList', results, 'No matching songs or videos found.');
      $('searchMeta').textContent = `${localMatches.length} local • ${results.length} online results`;
    } catch {
      $('ytSearchList').innerHTML = '<div class="empty-state">Online search unavailable (check connection).</div>';
    }
  }

  async function loadDiscovery() {
    $('discoveryShelves').innerHTML = '<div class="empty-state">Loading mixes...</div>';
    try {
      state.discoverySections = await window.yumaAPI.music.getHome();
    } catch {
      state.discoverySections = [];
    }
    renderDiscovery();
    window.yumaAPI.music
      .search('official music video', 'videos')
      .then((vids) => {
        state.videoResults = vids || [];
        renderVideoSongsList();
        if (state.homeFilter === 'videos') renderDiscovery();
      })
      .catch(() => {});
  }

  function setSleepTimer(minutes) {
    clearTimeout(state.sleepTimerId);
    clearInterval(state.sleepTickId);
    const btn = $('sleepTimerBtn');

    if (!minutes || minutes <= 0) {
      state.sleepEndTime = 0;
      btn.innerHTML = ICONS.moon;
      btn.classList.remove('active');
      showToast('Sleep timer turned off');
      return;
    }

    state.sleepEndTime = Date.now() + minutes * 60 * 1000;
    btn.classList.add('active');
    const updateLabel = () => {
      const remMin = Math.max(1, Math.ceil((state.sleepEndTime - Date.now()) / 60000));
      btn.innerHTML = `${ICONS.moon} <span>${remMin}m</span>`;
    };
    updateLabel();
    state.sleepTickId = setInterval(updateLabel, 15000);
    state.sleepTimerId = setTimeout(() => {
      if (state.isPlaying) toggleCurrentPlay();
      setSleepTimer(0);
      showToast('Sleep timer paused playback');
    }, minutes * 60 * 1000);
    showToast(`Sleep timer set for ${minutes} min`);
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
        ? 'Restart to Update'
        : isDl
        ? `Updating ${status.progress || 0}%`
        : `Update v${status.availableVersion}`;
    } else {
      pill.classList.add('hidden');
    }

    if (status.pcRelease?.notes) {
      $('releaseNotesBox').classList.remove('hidden');
      $('releaseNotesBox').textContent = `Release ${status.pcRelease.tag}:\n${status.pcRelease.notes}`;
    }

    if (status.upstream) {
      $('upstreamStatusText').textContent = `Latest Android release: ${status.upstream.name}`;
      $('upstreamTagBadge').textContent = status.upstream.tag;
    }
  }

  function wireEvents() {
    $('minBtn').addEventListener('click', () => window.yumaAPI.windowControls.minimize());
    $('maxBtn').addEventListener('click', () => window.yumaAPI.windowControls.maximize());
    $('closeBtn').addEventListener('click', () => window.yumaAPI.windowControls.close());

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

    document.querySelectorAll('.side-nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
    $('sidebarLikedItem').addEventListener('click', () => {
      openPlaylistDetail({
        id: 'liked',
        name: 'Liked Songs',
        description: 'All songs and videos you saved',
        owner: 'Pavithran',
        tracks: state.store?.likedTracks || [],
        kind: 'liked'
      });
    });
    $('sidebarNewPlBtn').addEventListener('click', () => {
      switchView('library');
      document.querySelector('.tab-btn[data-lib-tab="playlists"]')?.click();
      $('newPlaylistInput').focus();
    });

    document.querySelectorAll('.filter-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.homeFilter = btn.dataset.homeFilter;
        renderDiscovery();
      });
    });

    document.querySelectorAll('.side-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchSideTab(btn.dataset.sideTab));
    });

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

    document.querySelectorAll('.tab-btn[data-lib-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn[data-lib-tab]').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.lib-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        $(`lib-panel-${btn.dataset.libTab}`)?.classList.add('active');
      });
    });

    const searchInput = $('globalSearchInput');
    const mobileSearchInput = $('mobileSearchInput');
    const syncSearchVal = (val) => {
      if (searchInput && searchInput.value !== val) searchInput.value = val;
      if (mobileSearchInput && mobileSearchInput.value !== val) mobileSearchInput.value = val;
      $('clearSearchBtn').classList.toggle('hidden', !val);
      $('mobileSearchClearBtn')?.classList.toggle('hidden', !val);
      if (!val.trim()) {
        $('mobileBrowseBlock')?.classList.remove('hidden');
        $('view-search')?.classList.remove('has-search');
      }
    };
    const onSearchInputEvent = (val) => {
      syncSearchVal(val);
      clearTimeout(searchDebounce);
      if (val.trim().length >= 2) {
        searchDebounce = setTimeout(() => runHybridSearch(val), 500);
      }
    };
    searchInput.addEventListener('input', (e) => onSearchInputEvent(e.target.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchDebounce);
        runHybridSearch(e.target.value);
      }
    });
    if (mobileSearchInput) {
      mobileSearchInput.addEventListener('input', (e) => onSearchInputEvent(e.target.value));
      mobileSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          clearTimeout(searchDebounce);
          runHybridSearch(e.target.value);
        }
      });
    }
    $('clearSearchBtn').addEventListener('click', () => {
      syncSearchVal('');
      switchView('discover');
    });
    $('mobileSearchClearBtn')?.addEventListener('click', () => {
      syncSearchVal('');
      $('mobileBrowseBlock')?.classList.remove('hidden');
      $('view-search')?.classList.remove('has-search');
      $('localSearchBlock').classList.add('hidden');
      $('ytSearchList').innerHTML = '<div class="empty-state">Tap a category or type above to search.</div>';
      $('searchMeta').textContent = 'Search songs, artists, music videos, or local files';
      mobileSearchInput?.focus();
    });
    document.querySelectorAll('.browse-tile, .genre-reel-card').forEach((tile) => {
      tile.addEventListener('click', () => {
        if (tile.dataset.browseAction === 'library') {
          switchView('library');
          return;
        }
        const q = tile.dataset.browseQuery;
        const m = tile.dataset.browseMode || 'all';
        document.querySelector(`.tab-btn[data-search-mode="${m}"]`)?.click();
        if (q) runHybridSearch(q, m);
      });
    });

    $('mobileEqBtn')?.addEventListener('click', () => switchView('dsp'));
    $('searchEqBtn')?.addEventListener('click', () => switchView('dsp'));
    $('searchFilesBtn')?.addEventListener('click', () => $('openFilesQuickBtn').click());
    $('libEqBtn')?.addEventListener('click', () => switchView('dsp'));
    $('mobileUpdatesBtn')?.addEventListener('click', () => switchView('updates'));
    $('libUpdatesBtn')?.addEventListener('click', () => switchView('updates'));
    $('mobileOpenBtn')?.addEventListener('click', () => $('openFilesQuickBtn').click());

    document.querySelectorAll('.avatar-trigger').forEach((btn) => {
      btn.addEventListener('click', () => $('profileModal')?.classList.remove('hidden'));
    });
    $('closeProfileModal')?.addEventListener('click', () => $('profileModal')?.classList.add('hidden'));
    $('profEqBtn')?.addEventListener('click', () => {
      $('profileModal')?.classList.add('hidden');
      switchView('dsp');
    });
    $('profUpdatesBtn')?.addEventListener('click', () => {
      $('profileModal')?.classList.add('hidden');
      switchView('updates');
    });
    $('profOpenMediaBtn')?.addEventListener('click', () => {
      $('profileModal')?.classList.add('hidden');
      $('openFilesQuickBtn').click();
    });
    $('profScanBtn')?.addEventListener('click', () => {
      $('profileModal')?.classList.add('hidden');
      $('addFolderBtn').click();
    });
    $('profCreatePlBtn')?.addEventListener('click', () => {
      $('profileModal')?.classList.add('hidden');
      switchView('library');
      document.querySelector('.tab-btn[data-lib-tab="playlists"]')?.click();
      setTimeout(() => $('newPlaylistInput')?.focus(), 80);
    });

    $('libSearchToggleBtn')?.addEventListener('click', () => {
      const row = $('libSearchRow');
      const open = row.classList.toggle('hidden');
      if (!open) $('libFilterInput')?.focus();
      else {
        state.libraryFilter = '';
        if ($('libFilterInput')) $('libFilterInput').value = '';
        renderLibraryOverview();
      }
    });
    $('libFilterInput')?.addEventListener('input', (e) => {
      state.libraryFilter = e.target.value;
      renderLibraryOverview();
    });
    $('libFilterClearBtn')?.addEventListener('click', () => {
      state.libraryFilter = '';
      if ($('libFilterInput')) $('libFilterInput').value = '';
      $('libSearchRow')?.classList.add('hidden');
      renderLibraryOverview();
    });
    $('libQuickCreateBtn')?.addEventListener('click', () => {
      document.querySelector('.tab-btn[data-lib-tab="playlists"]')?.click();
      setTimeout(() => $('newPlaylistInput')?.focus(), 80);
    });
    $('libMobileAddFolderBtn')?.addEventListener('click', () => $('addFolderBtn').click());
    $('libSortBtn')?.addEventListener('click', () => {
      const order = ['recent', 'alpha', 'count'];
      const labels = { recent: 'Recents', alpha: 'A–Z', count: 'Most songs' };
      state.librarySort = order[(order.indexOf(state.librarySort) + 1) % order.length];
      $('libSortLabel').textContent = labels[state.librarySort];
      renderLibraryOverview();
    });

    // Playlist Detail View Controls
    $('plBackBtn')?.addEventListener('click', () => switchView('library'));
    $('plPlayAllBtn')?.addEventListener('click', () => {
      const tracks = state.activePlaylistSpec?.tracks || [];
      if (!tracks.length) return showToast('Add some songs to play');
      playTrackWithContext(tracks[0], tracks, { contextName: state.activePlaylistSpec.name });
    });
    $('plShufflePlayBtn')?.addEventListener('click', () => {
      const tracks = state.activePlaylistSpec?.tracks || [];
      if (!tracks.length) return showToast('No tracks to shuffle');
      state.shuffle = true;
      $('shuffleBtn').classList.add('active');
      $('cinemaShuffleBtn').classList.add('active');
      const idx = Math.floor(Math.random() * tracks.length);
      playTrackWithContext(tracks[idx], tracks, { contextName: state.activePlaylistSpec.name });
    });
    $('plSaveBtn')?.addEventListener('click', async () => {
      const spec = state.activePlaylistSpec;
      if (!spec || !spec.tracks?.length) return;
      if (spec.kind === 'shelf') {
        const pl = await window.yumaAPI.store.createPlaylist(spec.name);
        for (const t of spec.tracks) {
          await window.yumaAPI.store.addToPlaylist(pl.id, t);
        }
        state.store.playlists = (await window.yumaAPI.store.getState()).playlists;
        renderPlaylists();
        $('plSaveBtn').innerHTML = ICONS.checkCircle;
        showToast(`Saved "${spec.name}" to Your Library`);
      } else {
        state.queue.push(...spec.tracks);
        renderQueue();
        $('plSaveBtn').innerHTML = ICONS.checkCircle;
        showToast(`Queued ${spec.tracks.length} songs`);
      }
    });
    $('plAddSongsBtn')?.addEventListener('click', () => {
      if (state.activePlaylistSpec?.kind === 'playlist') openAddSongsModal(state.activePlaylistSpec.id);
    });
    $('plInlineAddRow')?.addEventListener('click', () => {
      if (state.activePlaylistSpec?.kind === 'playlist') openAddSongsModal(state.activePlaylistSpec.id);
    });
    $('plMoreBtn')?.addEventListener('click', () => {
      const spec = state.activePlaylistSpec;
      if (!spec) return;
      if (spec.tracks?.length) openTrackMenu(spec.tracks[0], { playlistId: spec.kind === 'playlist' ? spec.id : null });
    });
    $('closeAddSongsModal')?.addEventListener('click', () => $('addSongsModal')?.classList.add('hidden'));
    $('closeTrackMenuModal')?.addEventListener('click', () => $('trackMenuModal')?.classList.add('hidden'));
    $('cinemaMoreBtn')?.addEventListener('click', () => {
      if (state.currentTrack) openTrackMenu(state.currentTrack);
    });

    $('videoSearchTriggerBtn').addEventListener('click', () => {
      document.querySelector('.tab-btn[data-search-mode="videos"]')?.click();
      switchView('search');
      searchInput.focus();
    });

    $('videoTheaterBtn').addEventListener('click', openCinema);

    const handleAddFolder = async () => {
      const res = await window.yumaAPI.library.pickFolder();
      if (!res.canceled) {
        state.store.localFolders = res.folders;
        state.localTracks = res.tracks;
        renderFolders();
        renderLocalTracks();
        switchView('library');
        showToast(`Added ${res.tracks.length} local files`);
      }
    };
    $('addFolderBtn').addEventListener('click', handleAddFolder);
    $('heroAddFolderBtn').addEventListener('click', handleAddFolder);

    $('rescanBtn').addEventListener('click', async () => {
      const res = await window.yumaAPI.library.scan();
      state.localTracks = res.tracks;
      renderLocalTracks();
      showToast(`Scanned ${res.tracks.length} local files`);
    });

    $('openFilesQuickBtn').addEventListener('click', async () => {
      const res = await window.yumaAPI.library.pickFiles();
      if (!res.canceled && res.tracks.length > 0) {
        playTrackWithContext(res.tracks[0], res.tracks);
      }
    });

    $('heroRefreshFeedBtn').addEventListener('click', loadDiscovery);

    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files || []);
      const paths = files.map((f) => window.yumaAPI.getPathForFile(f)).filter(Boolean);
      if (paths.length > 0) {
        const tracks = await window.yumaAPI.library.parsePaths(paths);
        if (tracks.length > 0) {
          playTrackWithContext(tracks[0], tracks);
        }
      }
    });

    const localVid = $('localVideoPlayer');
    localVid.addEventListener('timeupdate', () => {
      if (state.activeBackend !== 'localVideo') return;
      const cur = localVid.currentTime || 0;
      const dur = Number.isFinite(localVid.duration) ? localVid.duration : 0;
      updateProgressUi(cur, dur);
      syncLyricsHighlight(cur);
    });
    localVid.addEventListener('ended', () => {
      if (state.activeBackend === 'localVideo') nextTrack();
    });

    $('playPauseBtn').addEventListener('click', toggleCurrentPlay);
    $('cinemaPlayBtn').addEventListener('click', toggleCurrentPlay);
    $('nextBtn').addEventListener('click', () => nextTrack());
    $('cinemaNextBtn').addEventListener('click', () => nextTrack());
    $('prevBtn').addEventListener('click', prevTrack);
    $('cinemaPrevBtn').addEventListener('click', prevTrack);

    const toggleShuffle = () => {
      state.shuffle = !state.shuffle;
      $('shuffleBtn').classList.toggle('active', state.shuffle);
      $('cinemaShuffleBtn').classList.toggle('active', state.shuffle);
    };
    $('shuffleBtn').addEventListener('click', toggleShuffle);
    $('cinemaShuffleBtn').addEventListener('click', toggleShuffle);

    const cycleRepeat = () => {
      const order = ['off', 'all', 'one'];
      state.repeatMode = order[(order.indexOf(state.repeatMode) + 1) % order.length];
      const active = state.repeatMode !== 'off';
      [$('repeatBtn'), $('cinemaRepeatBtn')].forEach((b) => {
        b.classList.toggle('active', active);
        b.title = `Repeat: ${state.repeatMode}`;
      });
      showToast(`Repeat: ${state.repeatMode}`);
    };
    $('repeatBtn').addEventListener('click', cycleRepeat);
    $('cinemaRepeatBtn').addEventListener('click', cycleRepeat);

    $('seekSlider').addEventListener('input', (e) => seekCurrent(parseFloat(e.target.value)));
    $('cinemaSeekSlider').addEventListener('input', (e) => seekCurrent(parseFloat(e.target.value)));

    const updateVolumeAll = async (vol) => {
      engine.setVolume(vol);
      window.yumaAPI.ytmPlayer.setVolume(vol);
      localVid.volume = vol;
      $('volumeSlider').value = vol;
      $('cinemaVolSlider').value = vol;
      await window.yumaAPI.store.updateSettings({ volume: vol });
    };
    $('volumeSlider').addEventListener('input', (e) => updateVolumeAll(parseFloat(e.target.value)));
    $('cinemaVolSlider').addEventListener('input', (e) => updateVolumeAll(parseFloat(e.target.value)));

    const cycleSpeed = () => {
      const nextIdx = (SPEED_STEPS.indexOf(state.playbackRate) + 1) % SPEED_STEPS.length;
      state.playbackRate = SPEED_STEPS[nextIdx];
      $('speedBtn').textContent = `${state.playbackRate}x`;
      if ($('cinemaSpeedBtn')) $('cinemaSpeedBtn').textContent = `${state.playbackRate}x`;
      engine.setPlaybackRate(state.playbackRate);
      window.yumaAPI.ytmPlayer.setPlaybackRate(state.playbackRate);
      localVid.playbackRate = state.playbackRate;
      showToast(`Speed: ${state.playbackRate}x`);
    };
    $('speedBtn').addEventListener('click', cycleSpeed);
    $('cinemaSpeedBtn')?.addEventListener('click', cycleSpeed);

    $('sleepTimerBtn').addEventListener('click', () => $('sleepModal').classList.remove('hidden'));
    $('cinemaSleepBtn')?.addEventListener('click', () => $('sleepModal').classList.remove('hidden'));
    $('closeSleepModal').addEventListener('click', () => $('sleepModal').classList.add('hidden'));
    document.querySelectorAll('.sleep-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        setSleepTimer(parseInt(btn.dataset.mins, 10));
        $('sleepModal').classList.add('hidden');
      });
    });

    $('quickLyricsBtn').addEventListener('click', () => switchSideTab('lyrics'));
    $('quickQueueBtn').addEventListener('click', () => switchSideTab('queue'));
    $('cinemaLyricsBtn')?.addEventListener('click', () => {
      const ov = $('cinemaOverlay');
      const showing = ov.classList.toggle('show-lyrics');
      $('cinemaLyricsBtn').classList.toggle('active', showing);
    });
    $('cinemaQueueBtn')?.addEventListener('click', () => {
      closeCinema();
      switchSideTab('queue');
      $('sidePanel')?.classList.add('mobile-open');
    });
    $('closeSidePanelBtn')?.addEventListener('click', () => {
      $('sidePanel')?.classList.remove('mobile-open');
    });

    $('npSwitchVideoBtn').addEventListener('click', toggleVideoMode);
    $('barVideoToggleBtn').addEventListener('click', toggleVideoMode);
    $('cinemaVideoToggleBtn').addEventListener('click', toggleVideoMode);

    $('cinemaBtn').addEventListener('click', openCinema);
    $('closeCinemaBtn').addEventListener('click', closeCinema);
    document.querySelector('.bar-left .bar-track-info')?.addEventListener('click', () => {
      if (window.innerWidth <= 900 && state.currentTrack) openCinema();
    });
    document.querySelector('.bar-left .bar-thumb-wrap')?.addEventListener('click', () => {
      if (window.innerWidth <= 900 && state.currentTrack) openCinema();
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
    $('cinemaLikeBtn')?.addEventListener('click', toggleCurrentLike);

    $('clearQueueBtn').addEventListener('click', () => {
      state.queue = state.currentTrack ? [state.currentTrack] : [];
      state.queueIndex = state.currentTrack ? 0 : -1;
      renderQueue();
    });

    $('createPlaylistBtn').addEventListener('click', async () => {
      const input = $('newPlaylistInput');
      if (!input.value.trim()) return;
      const pl = await window.yumaAPI.store.createPlaylist(input.value);
      state.store.playlists.push(pl);
      input.value = '';
      renderPlaylists();
    });
    $('closePlaylistModal').addEventListener('click', () => $('playlistModal').classList.add('hidden'));

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

    const setEndless = async (enabled) => {
      state.store.settings.endlessQueue = Boolean(enabled);
      $('endlessQueueToggle').checked = Boolean(enabled);
      $('endlessQueueBtn').classList.toggle('active', Boolean(enabled));
      await window.yumaAPI.store.updateSettings({ endlessQueue: Boolean(enabled) });
      if (enabled && state.currentTrack && state.queue.length - 1 - state.queueIndex <= 2) {
        ensureEndlessQueue(state.currentTrack);
      }
      showToast(enabled ? 'Endless Queue On' : 'Endless Queue Off');
    };
    $('endlessQueueToggle').addEventListener('change', (e) => setEndless(e.target.checked));
    $('endlessQueueBtn').addEventListener('click', () =>
      setEndless(!(state.store?.settings?.endlessQueue !== false))
    );

    $('ambientToggle').addEventListener('change', async (e) => {
      state.store.settings.ambientBackdrop = e.target.checked;
      updateAmbientFromArtwork(e.target.checked ? state.currentTrack?.artwork : null);
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

    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggleCurrentPlay();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInput.focus();
      } else if (e.key === 'F11') {
        e.preventDefault();
        if ($('cinemaOverlay').classList.contains('hidden')) openCinema();
        else closeCinema();
      } else if (e.key === 'Escape' && !$('cinemaOverlay').classList.contains('hidden')) {
        closeCinema();
      }
    });

    window.yumaAPI.onMediaCommand((cmd) => {
      if (cmd === 'toggle') toggleCurrentPlay();
      if (cmd === 'next') nextTrack();
      if (cmd === 'prev') prevTrack();
    });

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

    const ro = new ResizeObserver(() => syncVideoStageVisibility());
    ro.observe($('videoStageHost'));
    ro.observe($('cinemaVideoStage'));
    window.addEventListener('resize', syncVideoStageVisibility);
  }

  async function bootstrap() {
    hydrateIcons();
    dismissSplash();
    updateGreeting();
    const cfg = await window.yumaAPI.getConfig();
    state.streamPort = cfg.streamPort;
    $('sidebarVersion').textContent = `v${cfg.version}`;
    state.store = await window.yumaAPI.store.getState();

    const s = state.store.settings;
    engine = new DualDeckAudioEngine({
      onTimeUpdate: (cur, dur) => {
        if (state.activeBackend !== 'local') return;
        updateProgressUi(cur, dur);
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
      updateProgressUi(cur, dur);
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
    $('cinemaVolSlider').value = s.volume;
    $('crossfadeSlider').value = s.crossfadeSeconds;
    $('crossfadeValue').textContent = `${s.crossfadeSeconds}s`;
    $('bassSwapToggle').checked = s.bassSwap;
    $('sponsorBlockToggle').checked = s.sponsorBlockEnabled;
    const endlessOn = s.endlessQueue !== false;
    $('endlessQueueToggle').checked = endlessOn;
    $('endlessQueueBtn').classList.toggle('active', endlessOn);
    $('ambientToggle').checked = s.ambientBackdrop;
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
