/*
 * StickWire Spotify -> Synced Lyrics (.lrc) tool — LOCAL mode
 * -----------------------------------------------------------
 * Zero npm dependencies. Run:  node server.js   ->  http://localhost:3000
 * Or just double-click start.bat (Windows) / start.sh (Mac/Linux).
 *
 * Same app also deploys to Netlify (free): see netlify.toml + netlify/functions/.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/resolve') {
      const { url, clientId, clientSecret } = await readJsonBody(req);
      const result = await lib.resolveSpotify(url, clientId, clientSecret);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && req.url === '/api/lyrics') {
      const { tracks } = await readJsonBody(req);
      if (!Array.isArray(tracks) || !tracks.length || tracks.length > 500) {
        return sendJson(res, 400, { ok: false, error: '1-500 tracks bhejo' });
      }
      const results = await lib.fetchLyricsBatch(tracks);
      return sendJson(res, 200, { ok: true, results });
    }

    if (req.method === 'GET') return serveStatic(req, res);

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log('Spotify -> LRC chal raha hai: http://localhost:' + PORT);
});
