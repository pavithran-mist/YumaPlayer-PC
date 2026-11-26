let innertubePromise = null;
const streamCache = new Map(); // videoId -> { url, mimeType, expiresAt }

async function getClient() {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      const { Innertube } = await import('youtubei.js');
      return Innertube.create({ generate_session_locally: true });
    })().catch((err) => {
      innertubePromise = null;
      throw err;
    });
  }
  return innertubePromise;
}

function parseDurationText(text) {
  if (!text || typeof text !== 'string') return 0;
  const parts = text.trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function pickThumbnail(thumbs) {
  if (!Array.isArray(thumbs) || thumbs.length === 0) return null;
  const sorted = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || null;
}

function normalizeYtmSong(item, mediaType = 'audio') {
  if (!item) return null;
  const videoId = item.id || item.video_id;
  if (!videoId) return null;

  const title = item.title?.text || item.title || item.name || 'Untitled';
  const artistsList = Array.isArray(item.artists)
    ? item.artists.map((a) => a.name).filter(Boolean)
    : [];
  const artist =
    artistsList.join(', ') ||
    item.author?.name ||
    item.authors?.[0]?.name ||
    item.subtitle?.text ||
    'YouTube Music';

  const album = item.album?.name || (mediaType === 'video' ? 'Music Video' : 'YouTube Music');
  const duration =
    typeof item.duration === 'number'
      ? item.duration
      : item.duration?.seconds || parseDurationText(item.duration?.text);

  const artwork =
    pickThumbnail(item.thumbnails || item.thumbnail?.contents || item.thumbnail) ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return {
    id: `yt_${videoId}`,
    videoId,
    source: 'youtube',
    mediaType,
    title: String(title),
    artist: String(artist),
    album: String(album),
    duration: Number(duration) || 0,
    artwork,
    codec: mediaType === 'video' ? 'VIDEO' : 'OPUS',
    lossless: false
  };
}

async function searchMusic(query, mode = 'all') {
  const clean = String(query || '').trim();
  if (!clean) return [];

  const yt = await getClient();
  const tracks = [];
  const seen = new Set();

  if (mode === 'all' || mode === 'songs') {
    try {
      const res = await yt.music.search(clean, { type: 'song' });
      const shelves = res.results || res.contents || [];
      for (const shelf of shelves) {
        const items = shelf.contents || [shelf];
        for (const item of items) {
          const track = normalizeYtmSong(item, 'audio');
          if (track && !seen.has(track.videoId)) {
            seen.add(track.videoId);
            tracks.push(track);
          }
        }
      }
    } catch (err) {
      console.warn('YTM music.search fallback:', err.message);
    }
  }

  if (mode === 'videos' || (mode === 'all' && tracks.length < 18)) {
    try {
      const ytQuery = mode === 'videos' ? `${clean} official music video` : clean;
      const res = await yt.search(ytQuery, { type: 'video' });
      const videos = res.videos || res.results || [];
      for (const v of videos) {
        const track = normalizeYtmSong(v, 'video');
        if (track && !seen.has(track.videoId)) {
          seen.add(track.videoId);
          tracks.push(track);
        }
        if (tracks.length >= 28) break;
      }
    } catch (err) {
      console.warn('YouTube video search failed:', err.message);
    }
  }

  return tracks.slice(0, 28);
}

async function getHomeDiscovery() {
  const yt = await getClient();
  const sections = [];

  try {
    const feed = await yt.music.getHomeFeed();
    const rawSections = feed.sections || [];
    for (const sec of rawSections) {
      const title = sec.header?.title?.text || sec.title?.text || 'Featured Mixes';
      const items = [];
      for (const item of sec.contents || []) {
        const track = normalizeYtmSong(item);
        if (track) items.push(track);
      }
      if (items.length > 0) {
        sections.push({ title, tracks: items.slice(0, 12) });
      }
      if (sections.length >= 4) break;
    }
  } catch (err) {
    console.warn('Home feed fallback:', err.message);
  }

  // Fallback discovery queries if home feed had no playable song items
  if (sections.length === 0) {
    const queries = [
      { title: 'Trending Music Hits', q: 'Top Trending Songs 2026 official audio' },
      { title: 'Chill & Lo-Fi Beats', q: 'lofi hip hop chill beats' },
      { title: 'Acoustic & Indie Vibes', q: 'indie acoustic chill playlist' }
    ];
    for (const group of queries) {
      try {
        const tracks = await searchMusic(group.q);
        if (tracks.length > 0) {
          sections.push({ title: group.title, tracks: tracks.slice(0, 10) });
        }
      } catch {
        // ignore offline
      }
    }
  }

  return sections;
}

async function resolveAudioStream(videoId) {
  const cached = streamCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const yt = await getClient();
  const clientsToTry = ['IOS', 'TV_EMBEDDED', 'WEB_EMBEDDED', 'WEB'];
  let format = null;
  let url = null;

  for (const client of clientsToTry) {
    try {
      const info = await yt.getBasicInfo(videoId, client);
      const candidate = info.chooseFormat({ type: 'audio', quality: 'best' });
      const candidateUrl = candidate?.url || candidate?.decipher(yt.session.player);
      if (candidate && candidateUrl) {
        format = candidate;
        url = candidateUrl;
        break;
      }
    } catch {
      // try next client
    }
  }

  if (!url) {
    const info = await yt.music.getInfo(videoId);
    format = info.chooseFormat({ type: 'audio', quality: 'best' });
    if (format) {
      url = format.url || format.decipher(yt.session.player);
    }
  }

  if (!url) {
    throw new Error(`No playable audio format found for ${videoId}`);
  }

  const entry = {
    url,
    mimeType: format.mime_type?.split(';')[0] || 'audio/mp4',
    contentLength: format.content_length ? Number(format.content_length) : null,
    expiresAt: Date.now() + 45 * 60 * 1000
  };
  streamCache.set(videoId, entry);
  return entry;
}

module.exports = {
  parseDurationText,
  normalizeYtmSong,
  searchMusic,
  getHomeDiscovery,
  resolveAudioStream
};
