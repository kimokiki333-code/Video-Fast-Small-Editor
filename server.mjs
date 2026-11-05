/* Dependency-free static server for local use and deployment smoke tests. */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.gz': 'application/gzip',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.zip': 'application/zip'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html';
    const resolved = path.resolve(ROOT, `.${pathname}`);
    if (!resolved.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
    const info = await stat(resolved);
    if (!info.isFile()) { res.writeHead(404).end('Not found'); return; }
    const ext = path.extname(resolved).toLowerCase();
    const body = await readFile(resolved);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': resolved.includes(`${path.sep}engine${path.sep}`) || resolved.includes(`${path.sep}vendor${path.sep}`)
        ? 'public, max-age=86400' : 'no-cache'
    };
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Make it Fast Edit Arsenal ready at http://${HOST}:${PORT}`);
});
