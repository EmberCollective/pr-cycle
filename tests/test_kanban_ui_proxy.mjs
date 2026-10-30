import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createUiServer } from '../skills/pr-cycle/scripts/serve-kanban-ui.mjs';

test('the backend automatic browser address serves the replacement while API uses the internal loopback', async (t) => {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'pr-cycle-entry-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await writeFile(path.join(dist, 'index.html'), '<html>replacement frontend</html>');
  const backend = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ internal: true, url: req.url }));
  });
  backend.listen(0, '127.0.0.2');
  await once(backend, 'listening');
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const port = backend.address().port;
  const ui = createUiServer({ dist, backendHost: '127.0.0.2', backendPort: port });
  ui.listen(port, '127.0.0.1');
  await once(ui, 'listening');
  t.after(() => ui.shutdown());
  const base = `http://127.0.0.1:${port}`;
  assert.match(await (await fetch(base)).text(), /replacement frontend/);
  assert.match(await (await fetch(`${base}/projects/a/tasks/b`)).text(), /replacement frontend/);
  assert.deepEqual(await (await fetch(`${base}/api/info`)).json(), { internal: true, url: '/api/info' });
  assert.equal((await (await fetch(`${base}/__pr_cycle_ui`)).json()).backendHost, '127.0.0.2');
});

test('frontend serves SPA, proxies requests and streams, and rejects foreign origins', async (t) => {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'pr-cycle-ui-'));
  t.after(() => {
    assert.equal(path.dirname(dist), path.resolve(os.tmpdir()));
    return rm(dist, { recursive: true, force: true });
  });
  await writeFile(path.join(dist, 'index.html'), '<html>local board</html>');
  await writeFile(path.join(dist, 'app.js'), 'console.log("local")');
  const backend = http.createServer(async (req, res) => {
    if (req.url === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      // The test closes after the first event: buffering until EOF would hang.
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, body, host: req.headers.host, origin: req.headers.origin }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const ui = createUiServer({ dist, backendPort: backend.address().port });
  ui.listen(0, '127.0.0.1');
  await once(ui, 'listening');
  t.after(() => ui.shutdown());
  const base = `http://127.0.0.1:${ui.address().port}`;
  assert.match(await (await fetch(`${base}/projects/test`)).text(), /local board/);
  assert.match((await fetch(`${base}/app.js`)).headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%2fsecret.txt`)).status, 403);
  assert.equal((await fetch(`${base}/api/test`, { headers: { Origin: 'https://example.org' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/test`, { headers: { Host: 'attacker.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  const result = await fetch(`${base}/api/test`, {
    method: 'POST', headers: { Origin: base }, body: 'message=hello',
  });
  assert.equal(result.status, 201);
  assert.deepEqual(await result.json(), {
    method: 'POST', body: 'message=hello', host: new URL(base).host, origin: base,
  });
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/stream`, { signal: controller.signal });
  const first = await stream.body.getReader().read();
  assert.match(new TextDecoder().decode(first.value), /data: first/);
  controller.abort();
});

test('WebSocket upgrade and bidirectional bytes survive the proxy', async (t) => {
  const backend = http.createServer();
  const remotes = new Set();
  backend.on('upgrade', (req, socket, head) => {
    remotes.add(socket);
    socket.on('close', () => remotes.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nready');
    if (head.length) socket.write(head);
    socket.on('data', (bytes) => socket.write(bytes));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => { for (const s of remotes) s.destroy(); backend.close(); });
  const ui = createUiServer({ dist: '.', backendPort: backend.address().port });
  ui.listen(0, '127.0.0.1');
  await once(ui, 'listening');
  t.after(() => ui.shutdown());
  const port = ui.address().port;
  const client = net.connect(port, '127.0.0.1');
  t.after(() => client.destroy());
  client.setTimeout(3000, () => client.destroy(new Error('WebSocket proxy timed out')));
  let received = '';
  const echoed = new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('data', (bytes) => {
      received += bytes.toString();
      if (received.includes('client-frame')) resolve();
    });
  });
  client.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nclient-frame`);
  await echoed;
  assert.match(received, /101 Switching Protocols/);
  assert.match(received, /ready/);
});
