import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUiServer } from '../../skills/pr-cycle/scripts/serve-kanban-ui.mjs';
import { trackingCommand } from '../../skills/pr-cycle/scripts/kanban-tracking-api.mjs';

export const project = '11111111-1111-4111-8111-111111111111';
export const ids = [1, 2, 3, 4].map(n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`);
const script = fileURLToPath(new URL('./tracking_fixture.py', import.meta.url));

export async function startFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pr-cycle-tracking-'));
  const database = path.join(directory, 'db.sqlite');
  const python = process.env.PYTHON || 'python';
  const native = (action, body) => new Promise((resolve, reject) => {
    const child = spawn(python, [script, database, action], { windowsHide: true });
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => { try { if (code) throw new Error(error); resolve(JSON.parse(output)); } catch (err) { reject(err); } });
    child.stdin.end(JSON.stringify(body ?? {}));
  });
  await native('init');
  const installed = await trackingCommand({ database, python, install: true });
  if (!installed.success) throw new Error(installed.message);
  await writeFile(path.join(directory, 'index.html'), '<html>test only</html>');
  const backend = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const result = await native(req.method === 'PUT' ? 'update' : 'list', body ? JSON.parse(body) : undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  let ui;
  const start = async () => {
    ui = createUiServer({ dist: directory, backendPort: backend.address().port, tracking: { database, python } });
    ui.listen(0, '127.0.0.1'); await once(ui, 'listening');
    return `http://127.0.0.1:${ui.address().port}`;
  };
  let base = await start();
  return {
    get base() { return base; }, database, native,
    async restart() { ui.shutdown(); base = await start(); },
    async close() {
      ui.shutdown(); backend.closeAllConnections(); backend.close();
      if (path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('Unexpected fixture path');
      await rm(directory, { recursive: true, force: true });
    },
  };
}
