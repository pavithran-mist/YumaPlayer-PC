const fs = require('fs');
const path = require('path');

const DEFAULT_DATA = {
  likedTracks: [],
  playlists: [],
  history: [],
  localFolders: [],
  settings: {
    crossfadeSeconds: 4,
    bassSwap: true,
    sponsorBlockEnabled: true,
    eqPreset: 'Flat',
    eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    preampDb: 0,
    volume: 0.85,
    ambientBackdrop: true
  }
};

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          ...structuredClone(DEFAULT_DATA),
          ...parsed,
          settings: {
            ...DEFAULT_DATA.settings,
            ...(parsed.settings || {})
          }
        };
      }
    } catch (err) {
      console.error('Failed to load store:', err.message);
    }
    return structuredClone(DEFAULT_DATA);
  }

  _save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  getState() {
    return this.data;
  }

  toggleLike(track) {
    const idx = this.data.likedTracks.findIndex((t) => t.id === track.id);
    let liked = false;
    if (idx >= 0) {
      this.data.likedTracks.splice(idx, 1);
    } else {
      this.data.likedTracks.unshift(track);
      liked = true;
    }
    this._save();
    return { liked, likedTracks: this.data.likedTracks };
  }

  addHistory(track) {
    this.data.history = [
      track,
      ...this.data.history.filter((t) => t.id !== track.id)
    ].slice(0, 50);
    this._save();
    return this.data.history;
  }

  createPlaylist(name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Playlist name cannot be empty');
    const playlist = {
      id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: clean,
      tracks: [],
      createdAt: new Date().toISOString()
    };
    this.data.playlists.push(playlist);
    this._save();
    return playlist;
  }

  deletePlaylist(playlistId) {
    this.data.playlists = this.data.playlists.filter((p) => p.id !== playlistId);
    this._save();
    return this.data.playlists;
  }

  addTrackToPlaylist(playlistId, track) {
    const pl = this.data.playlists.find((p) => p.id === playlistId);
    if (!pl) throw new Error('Playlist not found');
    if (!pl.tracks.some((t) => t.id === track.id)) {
      pl.tracks.push(track);
      this._save();
    }
    return pl;
  }

  removeTrackFromPlaylist(playlistId, trackId) {
    const pl = this.data.playlists.find((p) => p.id === playlistId);
    if (!pl) throw new Error('Playlist not found');
    pl.tracks = pl.tracks.filter((t) => t.id !== trackId);
    this._save();
    return pl;
  }

  addLocalFolder(folderPath) {
    const normalized = path.resolve(folderPath);
    if (!this.data.localFolders.includes(normalized)) {
      this.data.localFolders.push(normalized);
      this._save();
    }
    return this.data.localFolders;
  }

  removeLocalFolder(folderPath) {
    const normalized = path.resolve(folderPath);
    this.data.localFolders = this.data.localFolders.filter((f) => f !== normalized);
    this._save();
    return this.data.localFolders;
  }

  updateSettings(partial) {
    this.data.settings = { ...this.data.settings, ...partial };
    this._save();
    return this.data.settings;
  }
}

module.exports = { JsonStore, DEFAULT_DATA };
