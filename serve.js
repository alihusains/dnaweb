const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = '/Users/alihusainsorathiya/Documents/projects/dnaweb';
const PORT = 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '86400',
};

const NO_CACHE = {
  'cache-control': 'no-cache, no-store, must-revalidate',
  'pragma': 'no-cache',
  'expires': '0',
};

function proxyToTurso(req, res, tursoHost) {
  const targetUrl = `https://${tursoHost}${req.url}`;
  const u = new URL(targetUrl);
  const options = {
    hostname: u.hostname,
    port: 443,
    path: u.pathname + u.search,
    method: req.method,
    headers: { ...req.headers, host: u.hostname },
  };
  delete options.headers['origin'];
  delete options.headers['accept-encoding'];

  const proxyReq = https.request(options, (proxyRes) => {
    // Determine encoding for decompression
    const encoding = proxyRes.headers['content-encoding'];
    let decompress;
    if (encoding === 'gzip') {
      decompress = zlib.createGunzip();
    } else if (encoding === 'deflate') {
      decompress = zlib.createInflate();
    } else {
      decompress = null;
    }

    const headers = {
      ...proxyRes.headers,
      ...CORS_HEADERS,
      'access-control-expose-headers': '*',
    };
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
    delete headers['content-length'];

    res.writeHead(proxyRes.statusCode, headers);

    if (decompress) {
      proxyRes.pipe(decompress).pipe(res);
    } else {
      proxyRes.pipe(res);
    }
  });
  proxyReq.on('error', (e) => {
    console.error(`Proxy error to ${tursoHost}: ${e.message}`);
    res.writeHead(502, { 'Content-Type': 'text/plain', ...CORS_HEADERS, ...NO_CACHE });
    res.end('Proxy error');
  });
  req.pipe(proxyReq);
}

function onRequest(req, res) {
  const host = req.headers['host'] || '';
  const url = new URL(req.url, `http://${host}`);
  console.log(`  ${req.method} ${host}${url.pathname}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS_HEADERS, ...NO_CACHE });
    return res.end();
  }

  const localhostMatch = host.match(/^(.+)\.localhost(?::\d+)?$/);
  if (localhostMatch) {
    const subdomain = localhostMatch[1];
    if (subdomain.endsWith('.turso.io')) {
      return proxyToTurso(req, res, subdomain);
    }
  }

  const filePath = path.join(ROOT, url.pathname === '/' ? '/index.html' : url.pathname);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...NO_CACHE });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...NO_CACHE });
    res.end(data);
  });
}

const server = http.createServer(onRequest);
server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
  console.log(`Turso proxy: *.turso.io.localhost:${PORT} -> proxied with CORS`);
});
