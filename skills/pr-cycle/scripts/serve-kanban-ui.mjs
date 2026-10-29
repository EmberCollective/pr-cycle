import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export function createUiServer({ dist, backendPort, backendHost = '127.0.0.1' }) {
  if (!['127.0.0.1', '127.0.0.2'].includes(backendHost)) throw new Error('Backend must use a loopback address.');
  const root = path.resolve(dist);
  const sockets = new Set();
  const upstreamSockets = new Set();
  const server = http.createServer(handleRequest);

  function allowed(req) {
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    return hosts.includes(req.headers.host) &&
      (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`);
  }

  function upstream(req) {
    // Preserve Host and Origin together: the backend still enforces same origin.
    return http.request({
      hostname: backendHost, port: backendPort,
      path: req.url, method: req.method, headers: req.headers,
    });
  }

  async function handleRequest(req, res) {
    if (!allowed(req)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (req.url === '/__pr_cycle_ui') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ component: 'react-virtuoso', backendPort, backendHost }));
      return;
    }
    if (req.url === '/api' || req.url.startsWith('/api/')) {
      const proxy = upstream(req);
      proxy.on('response', (response) => {
        res.writeHead(response.statusCode, response.headers);
        res.flushHeaders();
        response.pipe(res);
        response.on('error', () => res.destroy());
      });
      proxy.on('error', () => {
        if (res.headersSent) res.destroy();
        else res.writeHead(502).end('Kanban backend unavailable');
      });
      req.on('aborted', () => proxy.destroy());
      res.on('close', () => proxy.destroy());
      req.pipe(proxy);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      const filename = path.resolve(root, `.${pathname}`);
      if (pathname.includes('\\') || pathname.includes('\0') ||
          (filename !== root && !filename.startsWith(root + path.sep))) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      let file = filename;
      let info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        if (path.extname(pathname)) {
          res.writeHead(404).end('Not found');
          return;
        }
        file = path.join(root, 'index.html');
        info = await stat(file);
      }
      res.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch {
      if (res.headersSent) res.destroy();
      else res.writeHead(400).end('Invalid request');
    }
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (!allowed(req) || !req.url.startsWith('/api/')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const proxy = upstream(req);
    proxy.on('upgrade', (response, remote, remoteHead) => {
      upstreamSockets.add(remote);
      remote.on('close', () => { upstreamSockets.delete(remote); socket.destroy(); });
      remote.on('error', () => socket.destroy());
      socket.on('close', () => remote.destroy());
      const headers = response.rawHeaders;
      let message = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
      for (let i = 0; i < headers.length; i += 2) message += `${headers[i]}: ${headers[i + 1]}\r\n`;
      socket.write(message + '\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket).pipe(remote);
    });
    proxy.on('response', (response) => {
      socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`);
      response.resume();
    });
    proxy.on('error', () => socket.destroy());
    socket.on('error', () => proxy.destroy());
    socket.on('close', () => proxy.destroy());
    proxy.end();
  });
  server.shutdown = () => {
    for (const socket of [...sockets, ...upstreamSockets]) socket.destroy();
    server.close();
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    dist: { type: 'string' },
    port: { type: 'string', default: '13681' },
    'backend-port': { type: 'string', default: '13680' },
    'backend-host': { type: 'string', default: '127.0.0.1' },
    'alias-port': { type: 'string', multiple: true, default: [] },
  } });
  const port = Number(values.port);
  const backendPort = Number(values['backend-port']);
  const backendHost = values['backend-host'];
  const ports = [...new Set([port, ...values['alias-port'].map(Number)])];
  if (![...ports, backendPort].every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535) ||
      (backendHost === '127.0.0.1' && ports.includes(backendPort))) {
    throw new Error('Frontend and backend need distinct loopback endpoints and valid ports.');
  }
  if (!values.dist || !existsSync(path.join(values.dist, 'index.html'))) {
    throw new Error('Build the frontend with setup-kanban-ui.ps1 first.');
  }
  const servers = ports.map(() => createUiServer({ dist: values.dist, backendPort, backendHost }));
  const shutdown = () => servers.forEach((server) => server.shutdown());
  servers.forEach((server, index) => {
    server.on('error', (error) => { console.error(error.message); process.exitCode = 1; shutdown(); });
    server.listen(ports[index], '127.0.0.1', () => {
      console.log(`PR cycle board: http://127.0.0.1:${ports[index]} (backend ${backendHost}:${backendPort})`);
    });
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
