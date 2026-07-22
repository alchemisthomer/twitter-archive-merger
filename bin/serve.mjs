#!/usr/bin/env node
// Zero-dependency static file server for the viewer.
// Serves src/viewer/ at / and .data/ at /data/.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.json'), 'utf8'));

const viewerDir = path.join(repoRoot, 'src', 'viewer');
const dataDir = path.resolve(repoRoot, config.outputDir || '.data');
const port = Number(process.env.PORT || config.servePort || 7716);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.mp4':  'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(base)) return null;
  return p;
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404');
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      // "bytes=start-end"; end optional. Honor a single range only.
      const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'content-range': `bytes */${st.size}` });
          return res.end();
        }
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${st.size}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache',
        });
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  if (urlPath.startsWith('/data/')) {
    const rel = urlPath.slice('/data/'.length);
    const p = safeJoin(dataDir, rel);
    if (!p) { res.writeHead(400); return res.end('bad path'); }
    return serveFile(req, res, p);
  }

  const p = safeJoin(viewerDir, urlPath.slice(1));
  if (!p) { res.writeHead(400); return res.end('bad path'); }
  serveFile(req, res, p);
});

server.listen(port, () => {
  console.log(`\n🐢  twitter-archive-merger serving on  →  http://localhost:${port}\n`);
  console.log(`    viewer:  ${path.relative(repoRoot, viewerDir)}`);
  console.log(`    data:    ${path.relative(repoRoot, dataDir)}\n`);
});
