// POST /.netlify/functions/lyrics   { tracks: [...] }
// Free-tier functions time out after ~10s, so the frontend sends small
// chunks (5 tracks); throttle is gentler here to stay inside the limit.
const lib = require('../../lib');

exports.handler = async (event) => {
  try {
    const { tracks } = JSON.parse(event.body || '{}');
    if (!Array.isArray(tracks) || !tracks.length || tracks.length > 10) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: '1-10 tracks per request' }),
      };
    }
    const results = await lib.fetchLyricsBatch(tracks, null, 300);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, results }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message || 'Lyrics fetch failed' }),
    };
  }
};
