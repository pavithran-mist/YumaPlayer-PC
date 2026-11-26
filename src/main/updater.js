const { app } = require('electron');

const UPSTREAM_REPO = 'MuwMx/YumaPlayer';
const PC_REPO = 'pavithran-mist/YumaPlayer-PC';

function normalizeVersion(v) {
  return String(v || '').replace(/^v/i, '').trim();
}

function compareSemver(a, b) {
  const pa = normalizeVersion(a).split(/[-.]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split(/[-.]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function fetchLatestGithubRelease(repo) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'YumaPlayer-PC/1.0.0',
        Accept: 'application/vnd.github+json'
      }
    });
    if (!res.ok) {
      // Fallback to tags if no formal release exists yet
      const tagsRes = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=1`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'YumaPlayer-PC/1.0.0' }
      });
      if (!tagsRes.ok) return null;
      const tags = await tagsRes.json();
      if (!Array.isArray(tags) || tags.length === 0) return null;
      return {
        tag: tags[0].name,
        name: tags[0].name,
        url: `https://github.com/${repo}/releases`,
        publishedAt: null,
        notes: ''
      };
    }
    const data = await res.json();
    return {
      tag: data.tag_name,
      name: data.name || data.tag_name,
      url: data.html_url,
      publishedAt: data.published_at,
      notes: (data.body || '').slice(0, 600)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

class UpdateManager {
  constructor(getWindow) {
    this.getWindow = getWindow;
    this.autoUpdater = null;
    this.status = {
      state: 'idle',
      currentVersion: app.getVersion(),
      availableVersion: null,
      progress: 0,
      message: 'Ready',
      upstream: null,
      pcRelease: null
    };
  }

  init() {
    if (!app.isPackaged) {
      return;
    }
    try {
      const { autoUpdater } = require('electron-updater');
      this.autoUpdater = autoUpdater;
      this.autoUpdater.autoDownload = false;
      this.autoUpdater.autoInstallOnAppExit = true;

      this.autoUpdater.on('checking-for-update', () => {
        this._emit({ state: 'checking', message: 'Checking GitHub Releases...' });
      });

      this.autoUpdater.on('update-available', (info) => {
        this._emit({
          state: 'available',
          availableVersion: info.version,
          message: `Update v${info.version} is available!`
        });
      });

      this.autoUpdater.on('update-not-available', () => {
        this._emit({
          state: 'up-to-date',
          message: `You are on the latest version (v${this.status.currentVersion})`
        });
      });

      this.autoUpdater.on('download-progress', (prog) => {
        this._emit({
          state: 'downloading',
          progress: Math.round(prog.percent || 0),
          message: `Downloading update: ${Math.round(prog.percent || 0)}%`
        });
      });

      this.autoUpdater.on('update-downloaded', (info) => {
        this._emit({
          state: 'downloaded',
          availableVersion: info.version,
          progress: 100,
          message: `v${info.version} ready! Restart to install.`
        });
      });

      this.autoUpdater.on('error', (err) => {
        this._emit({
          state: 'error',
          message: `Update check failed: ${err?.message || 'Unknown error'}`
        });
      });
    } catch (err) {
      console.warn('electron-updater unavailable:', err.message);
    }
  }

  _emit(patch) {
    this.status = { ...this.status, ...patch };
    this.getWindow()?.webContents.send('updater:status', this.status);
  }

  async checkForUpdates() {
    this._emit({ state: 'checking', message: 'Checking for updates...' });

    const [upstream, pcRelease] = await Promise.all([
      fetchLatestGithubRelease(UPSTREAM_REPO),
      fetchLatestGithubRelease(PC_REPO)
    ]);

    if (this.autoUpdater && app.isPackaged) {
      this._emit({ upstream, pcRelease });
      try {
        await this.autoUpdater.checkForUpdates();
      } catch (err) {
        this._emit({ state: 'error', message: err.message });
      }
      return this.status;
    }

    // Unpackaged / GitHub API fallback check
    if (pcRelease && compareSemver(pcRelease.tag, this.status.currentVersion) > 0) {
      this._emit({
        state: 'available',
        availableVersion: normalizeVersion(pcRelease.tag),
        upstream,
        pcRelease,
        message: `New release ${pcRelease.tag} available on GitHub!`
      });
    } else {
      this._emit({
        state: 'up-to-date',
        upstream,
        pcRelease,
        message: pcRelease
          ? `Up to date (v${this.status.currentVersion})`
          : `Running v${this.status.currentVersion} (publish to GitHub to enable OTA .exe updates)`
      });
    }
    return this.status;
  }

  async downloadUpdate() {
    if (this.autoUpdater && app.isPackaged) {
      await this.autoUpdater.downloadUpdate();
      return { started: true };
    }
    return {
      started: false,
      url: this.status.pcRelease?.url || `https://github.com/${PC_REPO}/releases`
    };
  }

  quitAndInstall() {
    if (this.autoUpdater && app.isPackaged) {
      this.autoUpdater.quitAndInstall();
    }
  }
}

module.exports = {
  UPSTREAM_REPO,
  PC_REPO,
  normalizeVersion,
  compareSemver,
  fetchLatestGithubRelease,
  UpdateManager
};
