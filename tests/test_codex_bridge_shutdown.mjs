import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function launch(t, source) {
  const root = mkdtempSync(join(tmpdir(), 'pr-cycle bridge EOF '));
  const cli = join(root, 'fake-cli.mjs');
  writeFileSync(cli, source);
  const child = spawn(process.execPath, [resolve('skills/pr-cycle/scripts/codex-local-bridge.mjs'), 'app-server'], {
    cwd: root,
    env: { ...process.env, PR_CYCLE_CODEX_PATH: cli },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const closed = once(child, 'close');
  const messages = [];
  child.stdout.on('data', (data) => messages.push(data.toString()));
  const ready = new Promise((resolveReady, reject) => {
    let output = '';
    child.on('error', reject);
    child.on('exit', () => reject(new Error(`Bridge exited before ready: ${output}`)));
    child.stderr.on('data', (data) => {
      output += data;
      if (output.includes('READY')) resolveReady();
    });
  });
  t.after(async () => {
    if (child.pid && child.exitCode == null && child.signalCode == null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else child.kill('SIGKILL');
      await closed;
    }
    // Also clean a detached Unix CLI group if a regression left it running.
    if (process.platform !== 'win32' && existsSync(join(root, 'leader.pid'))) {
      try { process.kill(-Number(readFileSync(join(root, 'leader.pid'), 'utf8')), 'SIGKILL'); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, child, closed, ready, messages };
}

for (const cooperative of [true, false]) {
  test(`bridge EOF shutdown completes (cooperative CLI: ${cooperative})`, { timeout: 10000 }, async (t) => {
    const fixture = launch(t, `
      process.stdin.resume();
      setInterval(() => {}, 1000);
      ${cooperative ? "process.stdin.on('end', () => process.exit(0));" : ''}
      process.stderr.write('READY\\n');
    `);
    await fixture.ready;
    const started = Date.now();
    fixture.child.stdin.end();
    const [code] = await fixture.closed;
    assert.equal(code, 0);
    if (cooperative) assert.ok(Date.now() - started < 1800, 'normal exit should cancel the 2s grace timer');
    assert.deepEqual(fixture.messages, [], 'shutdown must not add non-protocol stdout');
  });
}

test('unexpected CLI exit preserves its error code and buffered protocol output', { timeout: 10000 }, async (t) => {
  const event = { method: 'item/agentMessage/delta', params: { threadId: 'test-thread', delta: 'final buffered output' } };
  const fixture = launch(t, `
    process.stdin.once('data', () => {
      process.stdout.write(${JSON.stringify(JSON.stringify(event) + '\n')}, () => process.exit(17));
    });
    process.stderr.write('READY\\n');
  `);
  await fixture.ready;
  fixture.child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '1' } } }) + '\n');
  const [code] = await fixture.closed;
  assert.equal(code, 17);
  const message = JSON.parse(fixture.messages.join('').trim());
  assert.equal(message.method, 'codex/event/agent_message_delta');
  assert.equal(message.params.msg.delta, 'final buffered output');
});

for (const holdsPipes of [false, true]) {
  test(`EOF cleans a Unix descendant after leader exit (holds pipes: ${holdsPipes})`, {
    skip: process.platform === 'win32', timeout: 10000,
  }, async (t) => {
    const descendant = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      const beat = () => fs.writeFileSync('heartbeat', String(Date.now()));
      beat();setInterval(beat, 25);
      process.send('ready');process.disconnect();
    `;
    const fixture = launch(t, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      writeFileSync('leader.pid', String(process.pid));
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
        stdio: ['ignore', '${holdsPipes ? 'inherit' : 'ignore'}', '${holdsPipes ? 'inherit' : 'ignore'}', 'ipc'],
      });
      descendant.on('message', () => process.stderr.write('READY\\n'));
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `);
    await fixture.ready;
    fixture.child.stdin.end();
    const [code] = await fixture.closed;
    assert.equal(code, 0);
    const heartbeat = readFileSync(join(fixture.root, 'heartbeat'), 'utf8');
    await delay(200);
    assert.equal(readFileSync(join(fixture.root, 'heartbeat'), 'utf8'), heartbeat,
      'the descendant must stop even when no inherited pipe keeps the bridge alive');
  });
}
