const fs = require('fs');
const path = require('path');

function findSidecarLrc(audioFilePath) {
  if (!audioFilePath) return null;
  const parsed = path.parse(audioFilePath);
  const lrcPath = path.join(parsed.dir, `${parsed.name}.lrc`);
  if (fs.existsSync(lrcPath)) {
    return fs.readFileSync(lrcPath, 'utf8');
  }
  return null;
}

async function fetchLyrics({ title, artist, album, duration, filePath }) {
  // 1. Prefer local .lrc sidecar if available
  if (filePath) {
    try {
      const localLrc = findSidecarLrc(filePath);
      if (localLrc) {
        return { syncedLyrics: localLrc, plainLyrics: null, source: 'Local .lrc' };
      }
    } catch {
      // ignore local read error
    }
  }

  const cleanTitle = String(title || '')
    .replace(/\(Official.*?\)|\[Official.*?\]|\(Lyrics.*?\)|\[Lyrics.*?\]|\(Audio.*?\)/gi, '')
    .trim();
  const cleanArtist = String(artist || '').split(',')[0].trim();

  if (!cleanTitle) {
    return { syncedLyrics: null, plainLyrics: null, source: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    // 2. Try exact match on LRCLIB
    const params = new URLSearchParams({ track_name: cleanTitle });
    if (cleanArtist && cleanArtist !== 'Unknown Artist') {
      params.set('artist_name', cleanArtist);
    }
    if (album) params.set('album_name', album);
    if (duration && Number.isFinite(duration)) {
      params.set('duration', String(Math.round(duration)));
    }

    let res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'YumaPlayer-PC/1.0.0' }
    });

    if (res.ok) {
      const data = await res.json();
      if (data.syncedLyrics || data.plainLyrics) {
        return {
          syncedLyrics: data.syncedLyrics || null,
          plainLyrics: data.plainLyrics || null,
          source: 'LRCLIB'
        };
      }
    }

    // 3. Fallback search on LRCLIB
    const q = cleanArtist && cleanArtist !== 'Unknown Artist'
      ? `${cleanTitle} ${cleanArtist}`
      : cleanTitle;
    res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'YumaPlayer-PC/1.0.0' }
    });
    if (res.ok) {
      const results = await res.json();
      if (Array.isArray(results) && results.length > 0) {
        const best = results.find((r) => r.syncedLyrics) || results[0];
        return {
          syncedLyrics: best.syncedLyrics || null,
          plainLyrics: best.plainLyrics || null,
          source: 'LRCLIB'
        };
      }
    }
  } catch {
    // offline or timed out
  } finally {
    clearTimeout(timeout);
  }

  return { syncedLyrics: null, plainLyrics: null, source: null };
}

module.exports = { fetchLyrics, findSidecarLrc };
