const { WebContentsView } = require('electron');

class YtmPlayer {
  constructor(getMainWindow, onState) {
    this.getMainWindow = getMainWindow;
    this.onState = onState;
    this.view = null;
    this.pollTimer = null;
    this.currentVideoId = null;
    this.isLoadingTrack = false;
    this.volume = 0.85;
    this.playbackRate = 1.0;
    this.lastEndedSentFor = null;
    this.videoVisible = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
  }

  _ensureView() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const mainWin = this.getMainWindow();
    if (!mainWin || mainWin.isDestroyed()) return null;

    this.view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    mainWin.contentView.addChildView(this.view);
    this._applyBounds();

    this.view.webContents.on('did-finish-load', () => {
      this._injectCleanVideoCss();
    });

    // Catch YouTube / YouTube Music auto-advancing its own queue via SPA navigation
    this.view.webContents.on('did-navigate-in-page', (_e, newUrl) => {
      if (this.isLoadingTrack || !this.currentVideoId) return;
      try {
        const parsed = new URL(newUrl);
        const navId = parsed.searchParams.get('v');
        if (navId && navId !== this.currentVideoId && this.lastEndedSentFor !== this.currentVideoId) {
          const finishedId = this.currentVideoId;
          this.lastEndedSentFor = finishedId;
          this.stopPolling();
          this.pause();
          this.onState?.({
            videoId: finishedId,
            isAd: false,
            currentTime: 0,
            duration: 0,
            paused: true,
            ended: true
          });
        }
      } catch {
        // ignore invalid URL
      }
    });

    return this.view;
  }

  _injectCleanVideoCss() {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.view.webContents
      .insertCSS(`
        html, body { background: #000 !important; overflow: hidden !important; margin: 0 !important; }
        ytmusic-nav-bar, ytmusic-player-bar, ytmusic-guide-renderer,
        #masthead-container, #secondary, #below, #comments,
        .ytp-chrome-top, .ytp-watermark, ytmusic-player-page #side-panel {
          display: none !important;
        }
        #player, ytmusic-player, #movie_player, .html5-video-container, video.html5-main-video {
          position: fixed !important;
          inset: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          max-width: 100vw !important;
          max-height: 100vh !important;
          object-fit: contain !important;
          z-index: 9999 !important;
          background: #000 !important;
        }
      `)
      .catch(() => {});
  }

  _applyBounds() {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (this.videoVisible && this.bounds.width > 20 && this.bounds.height > 20) {
      this.view.setBounds({
        x: Math.round(this.bounds.x),
        y: Math.round(this.bounds.y),
        width: Math.round(this.bounds.width),
        height: Math.round(this.bounds.height)
      });
    } else {
      this.view.setBounds({ x: -2000, y: -2000, width: 320, height: 180 });
    }
  }

  setVideoStage(visible, bounds = null) {
    this.videoVisible = Boolean(visible);
    if (bounds && typeof bounds.width === 'number') {
      this.bounds = bounds;
    }
    this._applyBounds();
  }

  async prewarm() {
    try {
      const view = this._ensureView();
      if (view && !view.webContents.getURL()) {
        await view.webContents.loadURL('https://music.youtube.com').catch(() => {});
      }
    } catch {
      // ignore prewarm errors
    }
  }

  async play(videoId, { preferVideo = false } = {}) {
    if (!videoId) throw new Error('Missing videoId');
    this.currentVideoId = videoId;
    this.lastEndedSentFor = null;
    this.isLoadingTrack = true;

    const view = this._ensureView();
    if (!view) {
      this.isLoadingTrack = false;
      return;
    }
    this.stopPolling();

    const targetHost = preferVideo ? 'www.youtube.com' : 'music.youtube.com';
    const currentUrl = view.webContents.getURL() || '';
    let switchedInPage = false;

    // Instant zero-reload SPA track switch when already on matching YouTube host
    if (currentUrl.includes(targetHost)) {
      try {
        const res = await view.webContents.executeJavaScript(`(() => {
          const p = document.querySelector('#movie_player');
          if (!p || typeof p.loadVideoById !== 'function') return false;
          try {
            history.replaceState(null, '', '/watch?v=' + ${JSON.stringify(videoId)});
          } catch {}
          p.loadVideoById(${JSON.stringify(videoId)});
          const v = document.querySelector('video');
          if (v && v.paused) v.play().catch(() => {});
          return true;
        })()`);
        switchedInPage = Boolean(res);
      } catch {
        switchedInPage = false;
      }
    }

    if (!switchedInPage) {
      const base = preferVideo
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
        : `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

      try {
        await view.webContents.loadURL(base);
      } finally {
        this.isLoadingTrack = false;
      }
    } else {
      this.isLoadingTrack = false;
    }

    if (this.currentVideoId !== videoId) return;
    this.setVolume(this.volume);
    this.setPlaybackRate(this.playbackRate);
    this._startPolling(videoId);
  }

  async pause() {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    await this.view.webContents
      .executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) v.pause(); })()`)
      .catch(() => {});
  }

  async resume() {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    await this.view.webContents
      .executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) v.play(); })()`)
      .catch(() => {});
  }

  async stop() {
    this.stopPolling();
    this.currentVideoId = null;
    this.isLoadingTrack = false;
    this.setVideoStage(false);
    if (this.view && !this.view.webContents.isDestroyed()) {
      await this.pause();
      await this.view.webContents.loadURL('about:blank').catch(() => {});
    }
  }

  async seek(seconds) {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    const sec = Math.max(0, Number(seconds) || 0);
    await this.view.webContents
      .executeJavaScript(
        `(() => { const v = document.querySelector('video'); if (v && Number.isFinite(v.duration)) v.currentTime = ${sec}; })()`
      )
      .catch(() => {});
  }

  async setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, Number(vol) || 0));
    if (!this.view || this.view.webContents.isDestroyed()) return;
    await this.view.webContents
      .executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) v.volume = ${this.volume}; })()`)
      .catch(() => {});
  }

  async setPlaybackRate(rate) {
    this.playbackRate = Math.max(0.5, Math.min(2, Number(rate) || 1));
    if (!this.view || this.view.webContents.isDestroyed()) return;
    await this.view.webContents
      .executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) v.playbackRate = ${this.playbackRate}; })()`)
      .catch(() => {});
  }

  _startPolling(videoId) {
    this.stopPolling();
    const safeId = JSON.stringify(videoId);
    this.pollTimer = setInterval(async () => {
      if (!this.view || this.view.webContents.isDestroyed() || this.currentVideoId !== videoId) {
        this.stopPolling();
        return;
      }
      try {
        const state = await this.view.webContents.executeJavaScript(`(() => {
          const expectedId = ${safeId};
          const pageV = new URLSearchParams(location.search).get('v');
          const v = document.querySelector('video');

          // Disable YouTube Music's own autoplay toggle if present
          const autoplayToggle = document.querySelector('tp-yt-paper-toggle-button.autoplay[checked], .ytp-autonav-toggle-button[aria-checked="true"]');
          if (autoplayToggle) autoplayToggle.click();

          if (pageV && pageV !== expectedId) {
            if (v) v.pause();
            return { isAd: false, currentTime: 0, duration: 0, paused: true, ended: true };
          }

          const player = document.querySelector('#movie_player');
          const isAd = player && player.classList.contains('ad-showing');
          if (!v) return null;

          if (!v.__yumaHookedFor || v.__yumaHookedFor !== expectedId) {
            v.__yumaHookedFor = expectedId;
            window.__yumaEndedForId = null;
            v.addEventListener('ended', () => {
              window.__yumaEndedForId = expectedId;
              v.pause();
            });
          }

          if (isAd) {
            v.muted = true;
            const skipBtn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button');
            if (skipBtn) skipBtn.click();
            return { isAd: true, currentTime: 0, duration: 0, paused: false, ended: false };
          }

          if (v.muted) v.muted = false;
          if (Math.abs(v.volume - ${this.volume}) > 0.01) v.volume = ${this.volume};
          if (Math.abs(v.playbackRate - ${this.playbackRate}) > 0.01) v.playbackRate = ${this.playbackRate};

          const dur = Number.isFinite(v.duration) ? v.duration : 0;
          const cur = v.currentTime || 0;
          const hasEnded =
            window.__yumaEndedForId === expectedId ||
            v.ended ||
            (dur > 5 && cur >= dur - 0.35);

          if (hasEnded) {
            v.pause();
          }

          return {
            isAd: false,
            currentTime: cur,
            duration: dur,
            paused: hasEnded ? true : v.paused,
            ended: hasEnded
          };
        })()`);

        if (!state || this.currentVideoId !== videoId) return;
        if (state.ended) {
          if (this.lastEndedSentFor !== videoId) {
            this.lastEndedSentFor = videoId;
            this.stopPolling();
            this.onState?.({ videoId, ...state });
          }
          return;
        }
        this.onState?.({ videoId, ...state });
      } catch {
        // page navigating
      }
    }, 250);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  destroy() {
    this.stopPolling();
    try {
      const mainWin = this.getMainWindow();
      if (this.view && mainWin && !mainWin.isDestroyed()) {
        mainWin.contentView.removeChildView(this.view);
      }
      if (this.view && !this.view.webContents.isDestroyed()) {
        this.view.webContents.close();
      }
    } catch {
      // ignore teardown errors
    }
    this.view = null;
  }
}

module.exports = { YtmPlayer };
