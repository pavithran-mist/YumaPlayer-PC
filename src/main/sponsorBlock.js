const DEFAULT_CATEGORIES = [
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
  'music_offtopic'
];

function normalizeSegments(rawSegments) {
  if (!Array.isArray(rawSegments)) return [];
  return rawSegments
    .filter((s) => Array.isArray(s.segment) && s.segment.length === 2)
    .map((s) => ({
      start: Number(s.segment[0]),
      end: Number(s.segment[1]),
      category: s.category || 'music_offtopic'
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
}

function findActiveSkipSegment(segments, currentTime) {
  if (!Array.isArray(segments) || !Number.isFinite(currentTime)) return null;
  for (const seg of segments) {
    if (currentTime >= seg.start && currentTime < seg.end - 0.35) {
      return seg;
    }
  }
  return null;
}

async function fetchSponsorSegments(videoId, categories = DEFAULT_CATEGORIES) {
  if (!videoId) return [];
  const params = new URLSearchParams({ videoID: videoId });
  for (const cat of categories) {
    params.append('category', cat);
  }
  const url = `https://sponsor.ajay.app/api/skipSegments?${params.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return normalizeSegments(data);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  DEFAULT_CATEGORIES,
  normalizeSegments,
  findActiveSkipSegment,
  fetchSponsorSegments
};
