#!/usr/bin/env node
/* Production static server for dist/.
 *
 * Serves the .br/.gz files the build precompressed (nothing is compressed
 * per-request), negotiates on Accept-Encoding, and applies the two-tier
 * caching the hashed filenames make safe:
 *
 *   assets/<name>.<hash>.<ext>  immutable, one year
 *   *.html                      revalidate every time, cheap 304s
 *
 * ETags are per *representation* — the brotli, gzip and identity bodies of
 * one file get different tags, which is what RFC 9110 requires and what
 * keeps intermediary caches from handing a client an encoding it did not
 * ask for.
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.resolve(fileURLToPath(new URL('.', import.meta.url))), 'dist');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const HASHED = /\.[0-9a-f]{10}\.[a-z0-9]+$/i;
const COMPRESSIBLE = /\.(html|css|js|json|svg|txt|xml)$/i;

const cache = new Map(); // absolute path -> { buf, etag, mtime, size }

async function load(file) {
  const st = await stat(file);
  const key = file + ':' + st.mtimeMs + ':' + st.size;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit;
  const buf = await readFile(file);
  const entry = {
    key,
    buf,
    size: buf.length,
    mtime: st.mtime,
    etag: '"' + createHash('sha256').update(buf).digest('base64url').slice(0, 22) + '"'
  };
  cache.set(file, entry);
  return entry;
}

function pickEncoding(accept, file) {
  if (!COMPRESSIBLE.test(file)) return null;
  const a = (accept || '').toLowerCase();
  if (/\bbr\b/.test(a) && existsSync(file + '.br')) return { ext: '.br', name: 'br' };
  if (/\bgzip\b/.test(a) && existsSync(file + '.gz')) return { ext: '.gz', name: 'gzip' };
  return null;
}

function resolveTarget(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p += 'index.html';
  // Precompressed siblings are an implementation detail, never a URL.
  if (/\.(br|gz)$/i.test(p)) return null;

  let file = path.join(ROOT, p);
  if (path.relative(ROOT, file).startsWith('..') || path.isAbsolute(path.relative(ROOT, file))) {
    return null;
  }
  if (!existsSync(file) && !path.extname(file) && existsSync(file + '.html')) file += '.html';
  return existsSync(file) ? file : null;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }

    const file = resolveTarget(req.url);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(file).toLowerCase();
    const enc = pickEncoding(req.headers['accept-encoding'], file);
    const served = enc ? file + enc.ext : file;
    const entry = await load(served);

    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': String(entry.size),
      'ETag': entry.etag,
      'Last-Modified': entry.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': HASHED.test(path.basename(file))
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate'
    };
    if (COMPRESSIBLE.test(file)) headers['Vary'] = 'Accept-Encoding';
    if (enc) headers['Content-Encoding'] = enc.name;

    // Conditional requests. ETag wins over the date when both are present.
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    const etagMatch = inm && inm.split(',').some((t) => t.trim() === entry.etag || t.trim() === 'W/' + entry.etag);
    const dateMatch = !inm && ims && new Date(ims) >= new Date(Math.floor(entry.mtime.getTime() / 1000) * 1000);
    if (etagMatch || dateMatch) {
      delete headers['Content-Length'];
      res.writeHead(304, headers);
      return res.end();
    }

    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    res.end(entry.buf);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + e.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`  Hardnest production: http://${HOST}:${PORT}/`);
  console.log('  Ctrl+C to stop');
});
