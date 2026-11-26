const { BrowserWindow } = require('electron');

class YtmPlayer {
  constructor(onState) {
    this.onState = onState;
    this.win = null;
    this.pollTimer = null;
    this.currentVideoId = null;
    this.volume = 0.85;
    this.lastEndedSentFor = null;
  }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      show: false,
      width: 640,
      height: 360,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    this.win.on('closed', () => {
      this.stopPolling();
      this.win = null;
    });
    return this.win;
  }

  async play(videoId) {
    if (!videoId) throw new Error('Missing videoId');
    this.currentVideoId = videoId;
    this.lastEndedSentFor = null;

    const win = this._ensureWindow();
    this.stopPolling();

    const targetUrl = `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    await win.loadURL(targetUrl);
    await this.setVolume(this.volume);
    this._startPolling(videoId);
  }

  async pause() {
    if (!this.win || this.win.isDestroyed()) return;
    await this.win.webContents
      .executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) v.pause(); })()`)
      .catch(() => {});
  }

  async resume() {
    if (!this.win || this.win.isDestroyed()) return;
    await this.win.webContents
      .executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) v.play(); })()`)
      .catch(() => {});
  }

  async stop() {
    this.stopPolling();
    this.currentVideoId = null;
    if (this.win && !this.win.isDestroyed()) {
      await this.pause();
      await this.win.loadURL('about:blank').catch(() => {});
    }
  }

  async seek(seconds) {
    if (!this.win || this.win.isDestroyed()) return;
    const sec = Math.max(0, Number(seconds) || 0);
    await this.win.webContents
      .executeJavaScript(
        `(() => { const v = document.querySelector('video'); if (v && Number.isFinite(v.duration)) v.currentTime = ${sec}; })()`
      )
      .catch(() => {});
  }

  async setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, Number(vol) || 0));
    if (!this.win || this.win.isDestroyed()) return;
    await this.win.webContents
      .executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) v.volume = ${this.volume}; })()`)
      .catch(() => {});
  }

  _startPolling(videoId) {
    this.stopPolling();
    this.pollTimer = setInterval(async () => {
      if (!this.win || this.win.isDestroyed() || this.currentVideoId !== videoId) {
        this.stopPolling();
        return;
      }
      try {
        const state = await this.win.webContents.executeJavaScript(`(() => {
          const player = document.querySelector('#movie_player');
          const isAd = player && player.classList.contains('ad-showing');
          const v = document.querySelector('video');
          if (!v) return null;
          if (isAd) {
            v.muted = true;
            const skipBtn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button');
            if (skipBtn) skipBtn.click();
            return { isAd: true, currentTime: 0, duration: 0, paused: false, ended: false };
          }
          if (v.muted) v.muted = false;
          if (v.volume !== ${this.volume}) v.volume = ${this.volume};
          // Prevent YouTube Music's own queue from auto-playing a different track on end
          if (v.ended) v.pause();
          return {
            isAd: false,
            currentTime: v.currentTime || 0,
            duration: Number.isFinite(v.duration) ? v.duration : 0,
            paused: v.paused,
            ended: v.ended
          };
        })()`);

        if (!state) return;
        this.onState?.({ videoId, ...state });
        if (state.ended && this.lastEndedSentFor !== videoId) {
          this.lastEndedSentFor = videoId;
          this.stopPolling();
        }
      } catch {
        // page navigating
      }
    }, 300);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  destroy() {
    this.stopPolling();
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}

module.exports = { YtmPlayer };
