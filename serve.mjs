/**
 * serve.mjs — a static server for local development. Zero dependencies.
 *
 *   node serve.mjs        then open http://localhost:8080
 *
 * This exists only because browsers refuse to load ES modules over file://,
 * and because getUserMedia and service workers require a secure context.
 * localhost counts as secure; a LAN IP does not, which is why the deployed
 * app needs real HTTPS.
 *
 * The application itself needs no server, no build and no dependencies. This
 * file is never deployed: GitHub Pages serves the static files directly.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = process.cwd();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const rel = normalize(path === '/' ? 'index.html' : path.slice(1));

  // Refuse to serve anything outside the project directory.
  if (rel.startsWith('..')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, {
      'Content-Type': TYPES[extname(rel)] || 'application/octet-stream',
      // Never cache during development: a stale service worker serving
      // yesterday's JavaScript is the single most confusing failure here.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Sehat Ledger on http://localhost:${PORT}`);
});
