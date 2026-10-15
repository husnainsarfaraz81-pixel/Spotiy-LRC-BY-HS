/*
 * Shared logic for the Spotify -> Synced Lyrics tool.
 * Used by server.js (local mode) and netlify/functions/* (hosted mode).
 * Zero npm dependencies.
 */

const https = require('https');

const USER_AGENT = 'StickWire-SpotifyLRC/1.0 (personal lyrics tool)';
const LRCLIB_THROTTLE_MS = 400; // lrclib asks clients to wait 200-500ms between batch requests

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal https client (no auto gzip -> we send Accept-Encoding: identity).
// NOTE: https.request's `timeout` option proved unreliable, so we enforce the
// deadline with AbortSignal.timeout instead — guaranteed to fire.
function httpsRequest(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let req;
    try {
      req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: { 'Accept-Encoding': 'identity', ...headers },
        signal: AbortSignal.timeout(timeout),
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch (_) { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      });
    } catch (e) { reject(e); return; }
    req.on('error', (e) => {
      reject(e && e.name === 'AbortError' ? new Error('Request timed out') : e);
    });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------

function parseSpotifyUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.trim().match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|playlist|album)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  return { type: m[1], id: m[2] };
}

// In-memory token cache (never persisted)
let tokenCache = { token: null, expiresAt: 0, key: '' };

async function getSpotifyToken(clientId, clientSecret) {
  if (!clientId || !clientSecret) throw new Error('Spotify Client ID / Secret missing');
  const key = clientId + ':' + clientSecret;
  if (tokenCache.token && tokenCache.key === key && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }
  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const r = await httpsRequest('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (r.status !== 200) {
    throw new Error(r.status === 400 || r.status === 401
      ? 'Spotify rejected the Client ID / Secret (invalid credentials)'
      : 'Spotify token request failed (HTTP ' + r.status + ')');
  }
  tokenCache = { token: r.json.access_token, expiresAt: Date.now() + (r.json.expires_in || 3600) * 1000, key };
  return tokenCache.token;
}

async function spotifyGet(path, token) {
  const r = await httpsRequest('https://api.spotify.com/v1' + path, {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (r.status === 401) { tokenCache.token = null; throw new Error('Spotify auth expired, please retry'); }
  if (r.status === 404) throw new Error('Not found on Spotify (private/deleted link?)');
  if (r.status !== 200) throw new Error('Spotify API error (HTTP ' + r.status + ')');
  return r.json;
}

const normTrack = (t, albumName) => ({
  name: t.name,
  artist: (t.artists || []).map((a) => a.name).join(', '),
  album: albumName || (t.album && t.album.name) || '',
  duration_ms: t.duration_ms || 0,
});

async function resolveSpotify(url, clientId, clientSecret) {
  // No keys? Use the keyless embed-page method (no Premium, no app, no sp_dc).
  // Keys (Premium owners only)? Use the official API with full pagination.
  if (!(clientId && clientSecret)) return resolveViaEmbed(url);
  const parsed = parseSpotifyUrl(url);
  if (!parsed) throw new Error('Yeh Spotify ka track/playlist/album link nahi lag raha');
  const token = await getSpotifyToken(clientId, clientSecret);

  if (parsed.type === 'track') {
    const t = await spotifyGet('/tracks/' + parsed.id, token);
    return { type: 'track', name: t.name, tracks: [normTrack(t)] };
  }

  if (parsed.type === 'album') {
    const album = await spotifyGet('/albums/' + parsed.id, token);
    const tracks = [];
    let next = '/albums/' + parsed.id + '/tracks?limit=50&offset=0';
    while (next) {
      const page = await spotifyGet(next.replace('https://api.spotify.com/v1', ''), token);
      for (const t of page.items || []) tracks.push(normTrack(t, album.name));
      next = page.next;
    }
    return { type: 'album', name: album.name, tracks };
  }

  // playlist
  const meta = await spotifyGet('/playlists/' + parsed.id + '?fields=name', token);
  const tracks = [];
  let next = '/playlists/' + parsed.id + '/tracks?limit=100&offset=0&fields=items(track(name,artists(name),album(name),duration_ms)),next,total';
  while (next) {
    const page = await spotifyGet(next.replace('https://api.spotify.com/v1', ''), token);
    for (const item of page.items || []) {
      if (item.track && item.track.name) tracks.push(normTrack(item.track));
    }
    next = page.next;
  }
  return { type: 'playlist', name: meta.name, tracks };
}

// ---------------------------------------------------------------------------
// Keyless Spotify resolve (no API keys, no Premium, no sp_dc):
// Spotify's public embed pages are server-rendered and contain the track
// metadata (title, artist, duration_ms) as JSON. Free forever.
// Limitation: playlists expose ~50 tracks this way.
// ---------------------------------------------------------------------------

const EMBED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchEmbedEntity(type, id) {
  const r = await httpsRequest(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: { 'User-Agent': EMBED_UA },
    timeout: 25000,
  });
  if (r.status !== 200) throw new Error('Spotify link khul nahi raha (private ya deleted link?)');
  const m = r.text.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) throw new Error('Spotify se data nahi mila, dobara try karo');
  const d = JSON.parse(m[1]);
  const entity = d && d.props && d.props.pageProps && d.props.pageProps.state &&
                 d.props.pageProps.state.data && d.props.pageProps.state.data.entity;
  if (!entity) throw new Error('Spotify se data nahi mila, dobara try karo');
  return entity;
}

async function resolveViaEmbed(url) {
  const parsed = parseSpotifyUrl(url);
  if (!parsed) throw new Error('Yeh Spotify ka track/playlist/album link nahi lag raha');
  const e = await fetchEmbedEntity(parsed.type, parsed.id);

  if (parsed.type === 'track') {
    const artist = Array.isArray(e.artists)
      ? e.artists.map((a) => a.name).filter(Boolean).join(', ')
      : (e.subtitle || '');
    return {
      type: 'track',
      name: e.title || e.name,
      tracks: [{
        name: e.title || e.name || '',
        artist,
        album: '',
        duration_ms: e.duration || 0,
      }],
    };
  }

  const list = Array.isArray(e.trackList) ? e.trackList : [];
  const tracks = list.map((t) => ({
    name: t.title || '',
    artist: t.subtitle || '',
    album: parsed.type === 'album' ? (e.title || e.name || '') : '',
    duration_ms: t.duration || 0,
  })).filter((t) => t.name);
  return {
    type: parsed.type,
    name: e.title || e.name || 'Spotify ' + parsed.type,
    tracks,
    capped: list.length >= 50, // embed page only carries ~50 tracks
  };
}

// ---------------------------------------------------------------------------
// LRCLIB (free, no key)
// ---------------------------------------------------------------------------

function lrcHeader(track) {
  const mm = String(Math.floor((track.duration_ms || 0) / 60000)).padStart(2, '0');
  const ss = String(Math.floor(((track.duration_ms || 0) % 60000) / 1000)).padStart(2, '0');
  return `[ti:${track.name}]\n[ar:${track.artist}]\n[al:${track.album}]\n[length:${mm}:${ss}]\n`;
}

function buildLrc(track, synced, plain, instrumental, source) {
  const head = lrcHeader(track);
  // NOTE: synced/plain win over the instrumental flag — lrclib's flag is
  // crowd-sourced and sometimes wrong (real lyrics exist but flag says true).
  if (synced) return { status: 'synced', lrc: head + synced.trim() + '\n', source: source || null };
  if (plain) return { status: 'plain', lrc: head + plain.trim() + '\n', source: source || null };
  if (instrumental) return { status: 'instrumental', lrc: head + '[00:00.00] Instrumental\n', source: source || null };
  return { status: 'none', lrc: null, source: null };
}

const firstArtist = (a) => String(a || '').split(',')[0].trim();

function decodeEntities(s) {
  return String(s || '')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ---------------------------------------------------------------------------
// Provider 1: LRCLIB (free, no key) — biggest free synced DB (crowd-sourced)
// ---------------------------------------------------------------------------

async function lrclibGet(name, artist, album, durSec) {
  const params = new URLSearchParams({ track_name: name, artist_name: artist });
  if (album) params.set('album_name', album);
  if (durSec > 0) params.set('duration', String(durSec));
  const r = await httpsRequest('https://lrclib.net/api/get?' + params.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (r.status === 200 && r.json) return r.json;
  return null;
}

// Keyword search fallback: pick the SMARTEST hit — synced first,
// then closest duration match to Spotify's duration.
async function lrclibSearchBest(track) {
  const sq = new URLSearchParams({ q: track.name + ' ' + firstArtist(track.artist) });
  const s = await httpsRequest('https://lrclib.net/api/search?' + sq.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (s.status !== 200 || !Array.isArray(s.json) || !s.json.length) return null;
  const wantDur = Math.round((track.duration_ms || 0) / 1000);
  const scored = s.json.map((x) => {
    let score = 0;
    if (x.syncedLyrics) score += 1000;                       // synced beats plain, always
    if (!x.instrumental && x.plainLyrics) score += 100;
    if (wantDur > 0 && x.duration) score -= Math.min(Math.abs(x.duration - wantDur), 60);
    return { x, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].x;
}

// ---------------------------------------------------------------------------
// Provider 2: BetterLyrics (free, no key for cached tracks)
// Apple Music TTML synced lyrics. Needs song+artist+album+duration for a
// cache hit; returns HTTP 401 when the track isn't cached (treated as miss).
// ---------------------------------------------------------------------------

function ttmlTimeToSec(t) {
  const parts = String(t || '0').split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + (isNaN(p) ? 0 : p);
  return sec;
}

function fmtLrcTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return '[' + String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0') + ']';
}

function ttmlToLrc(ttml) {
  const lines = [];
  const re = /<p\b[^>]*begin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(ttml))) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim());
    lines.push(fmtLrcTime(ttmlTimeToSec(m[1])) + text);
  }
  return lines.length ? lines.join('\n') + '\n' : null;
}

async function betterLyricsLrc(track, durSec) {
  const q = new URLSearchParams({ s: track.name, a: firstArtist(track.artist) || track.artist });
  if (track.album) q.set('al', track.album);
  if (durSec > 0) q.set('d', String(durSec));
  const r = await httpsRequest('https://api.betterlyrics.org/getLyrics?' + q.toString(), {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 12000,
  });
  if (r.status !== 200 || !r.json || !r.json.ttml) return null; // 401 = not cached
  return ttmlToLrc(r.json.ttml);
}

// ---------------------------------------------------------------------------
// Provider 3: KuGou Music (free, no key) — lyrics.kugou.com search + download
// returns base64-encoded LRC. Strong on Western/Chinese catalog.
// ---------------------------------------------------------------------------

async function kuGouLrc(track) {
  const durMs = Math.round(track.duration_ms || 0);
  const keyword = encodeURIComponent(track.name + ' - ' + (firstArtist(track.artist) || track.artist));
  let url = 'https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=' + keyword;
  if (durMs > 0) url += '&duration=' + durMs;
  const r = await httpsRequest(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 12000 });
  const cands = (r.json && r.json.candidates) || [];
  if (!cands.length) return null;
  let pick = cands[0];
  if (durMs > 0) {
    const wantSec = durMs / 1000;
    const close = cands.find((c) => Math.abs((c.duration || 0) - wantSec) <= 10);
    if (close) pick = close;
  }
  if (!pick.id || !pick.accesskey) return null;
  const d = await httpsRequest(
    `https://lyrics.kugou.com/download?fmt=lrc&charset=utf8&client=pc&ver=1&id=${pick.id}&accesskey=${pick.accesskey}`,
    { headers: { 'User-Agent': USER_AGENT }, timeout: 12000 }
  );
  if (!d.json || !d.json.content) return null;
  let lrc;
  try { lrc = Buffer.from(d.json.content, 'base64').toString('utf-8'); }
  catch (_) { return null; }
  // keep only real timestamped lines, drop KuGou's junk tags ([id:0], [sign:...] etc.)
  const lines = lrc.split('\n')
    .filter((ln) => /^\s*\[\d{1,3}:\d{2}[.:]/.test(ln))
    .map((ln) => decodeEntities(ln));
  if (!lines.length) return null;
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Chain: LRCLIB -> BetterLyrics -> KuGou -> lrclib plain/instrumental fallback
// ---------------------------------------------------------------------------

async function fetchLyricsForTrack(track) {
  const durSec = Math.round((track.duration_ms || 0) / 1000);
  const fa = firstArtist(track.artist);
  let plainFallback = null;  // lrclib plain lyrics (2nd weakest)
  let instrFallback = null;  // lrclib instrumental flag (weakest — flag is sometimes wrong)

  const consider = (r) => {
    if (!r || r.status === 'none') return false;
    if (r.status === 'synced') return true; // caller returns immediately
    if (r.status === 'plain' && !plainFallback) plainFallback = r;
    if (r.status === 'instrumental' && !instrFallback) instrFallback = r;
    return false;
  };

  // 1) lrclib exact lookups — several metadata variants, because album or
  //    multi-artist mismatches are the #1 reason exact lookup misses.
  const variants = [[track.artist, track.album], [fa, track.album], [fa, '']];
  const seen = new Set();
  for (const [artist, album] of variants) {
    const key = artist + '|' + album;
    if (!artist || seen.has(key)) continue;
    seen.add(key);
    let d = null;
    try { d = await lrclibGet(track.name, artist, album, durSec); } catch (_) { /* next */ }
    if (d && (d.syncedLyrics || d.plainLyrics || d.instrumental)) {
      const r = buildLrc(track, d.syncedLyrics, d.plainLyrics, d.instrumental, 'LRCLIB');
      if (r.status === 'synced') return r;
      consider(r);
    }
    await sleep(250); // stay polite to the free API between attempts
  }

  // 2) lrclib smart keyword-search fallback
  try {
    const hit = await lrclibSearchBest(track);
    if (hit && (hit.syncedLyrics || hit.plainLyrics || hit.instrumental)) {
      const r = buildLrc(track, hit.syncedLyrics, hit.plainLyrics, hit.instrumental, 'LRCLIB');
      if (r.status === 'synced') return r;
      consider(r);
    }
  } catch (_) { /* next provider */ }

  // 3+4) BetterLyrics (Apple Music TTML) + KuGou in parallel —
  // first synced result wins (Apple Music preferred on ties)
  try {
    const [b, k] = await Promise.all([
      betterLyricsLrc(track, durSec).catch(() => null),
      kuGouLrc(track).catch(() => null),
    ]);
    if (b) return { status: 'synced', lrc: lrcHeader(track) + b, source: 'Apple Music' };
    if (k) return { status: 'synced', lrc: lrcHeader(track) + k, source: 'KuGou' };
  } catch (_) { /* fall through */ }

  // 5) last resort: lrclib plain, then instrumental
  if (plainFallback) return plainFallback;
  if (instrFallback) return instrFallback;
  return { status: 'none', lrc: null, source: null };
}

async function fetchLyricsBatch(tracks, onProgress, throttleMs) {
  const wait = typeof throttleMs === 'number' ? throttleMs : LRCLIB_THROTTLE_MS;
  const out = [];
  for (let i = 0; i < tracks.length; i++) {
    if (i > 0) await sleep(wait); // be nice to the free API
    try {
      const r = await fetchLyricsForTrack(tracks[i]);
      out.push({ ...tracks[i], ...r });
    } catch (e) {
      out.push({ ...tracks[i], status: 'error', lrc: null, error: e.message });
    }
    if (onProgress) onProgress(i + 1, tracks.length);
  }
  return out;
}

module.exports = {
  USER_AGENT,
  LRCLIB_THROTTLE_MS,
  sleep,
  httpsRequest,
  parseSpotifyUrl,
  resolveSpotify,
  fetchLyricsForTrack,
  fetchLyricsBatch,
  firstArtist,
  ttmlToLrc,
  betterLyricsLrc,
  kuGouLrc,
  lrcHeader,
};
