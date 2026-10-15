/*
 * Shared logic for the Spotify -> Synced Lyrics tool.
 * Used by server.js (local mode) and netlify/functions/* (hosted mode).
 * Zero npm dependencies.
 */

const https = require('https');

const USER_AGENT = 'StickWire-SpotifyLRC/1.0 (personal lyrics tool)';
const LRCLIB_THROTTLE_MS = 400; // lrclib asks clients to wait 200-500ms between batch requests

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal https client (no auto gzip -> we send Accept-Encoding: identity)
function httpsRequest(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      timeout,
      headers: { 'Accept-Encoding': 'identity', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
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

function buildLrc(track, synced, plain, instrumental) {
  const mm = String(Math.floor((track.duration_ms || 0) / 60000)).padStart(2, '0');
  const ss = String(Math.floor(((track.duration_ms || 0) % 60000) / 1000)).padStart(2, '0');
  const head = `[ti:${track.name}]\n[ar:${track.artist}]\n[al:${track.album}]\n[length:${mm}:${ss}]\n`;
  if (instrumental) return { status: 'instrumental', lrc: head + '[00:00.00] Instrumental\n' };
  if (synced) return { status: 'synced', lrc: head + synced.trim() + '\n' };
  if (plain) return { status: 'plain', lrc: head + plain.trim() + '\n' };
  return { status: 'none', lrc: null };
}

async function fetchLyricsForTrack(track) {
  const dur = Math.round((track.duration_ms || 0) / 1000);
  const params = new URLSearchParams({ track_name: track.name, artist_name: track.artist });
  if (track.album) params.set('album_name', track.album);
  if (dur > 0) params.set('duration', String(dur));

  const r = await httpsRequest('https://lrclib.net/api/get?' + params.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (r.status === 200 && r.json) {
    const d = r.json;
    return buildLrc(track, d.syncedLyrics, d.plainLyrics, d.instrumental);
  }

  // Fallback: keyword search, then pick the SMARTEST hit:
  // prefer synced lyrics, then closest duration match to Spotify's duration.
  const sq = new URLSearchParams({ q: track.name + ' ' + track.artist });
  const s = await httpsRequest('https://lrclib.net/api/search?' + sq.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (s.status === 200 && Array.isArray(s.json) && s.json.length) {
    const wantDur = Math.round((track.duration_ms || 0) / 1000);
    const scored = s.json.map((x) => {
      let score = 0;
      if (x.syncedLyrics) score += 1000;                       // synced beats plain, always
      if (!x.instrumental && x.plainLyrics) score += 100;
      if (wantDur > 0 && x.duration) score -= Math.min(Math.abs(x.duration - wantDur), 60); // closer duration wins
      return { x, score };
    }).sort((a, b) => b.score - a.score);
    const hit = scored[0].x;
    if (hit.syncedLyrics || hit.plainLyrics || hit.instrumental) {
      return buildLrc(track, hit.syncedLyrics, hit.plainLyrics, hit.instrumental);
    }
  }
  return { status: 'none', lrc: null };
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
};
