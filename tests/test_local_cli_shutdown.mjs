import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stopCli } from '../skills/pr-cycle/scripts/local-cli.mjs';

// Verify the Unix branch on Windows too, without sending any real signals.
function unixSignals(t, missing = false) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const signals = [], timers = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push([pid, signal]);
    if (missing) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => { timers.push({ callback, ms }); });
  return { signals, timers };
}

test('termination escalates before backend timeout and repeated stop does not extend it', (t) => {
  const { signals, timers } = unixSignals(t);
  const child = { pid: 12345, exitCode: null };
  stopCli(child);
  stopCli(child);
  assert.deepEqual(signals, [[-12345, 'SIGTERM']]);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms > 0 && timers[0].ms < 2000);
  child.exitCode = 0; // leader exits, but a descendant can still ignore SIGTERM
  timers[0].callback();
  assert.deepEqual(signals.at(-1), [-12345, 'SIGKILL']);
});

test('cleanup still reaches descendants of an exited Unix leader', (t) => {
  const { signals, timers } = unixSignals(t);
  stopCli({ pid: 12346, exitCode: 0 });
  timers[0].callback();
  assert.deepEqual(signals, [[-12346, 'SIGTERM'], [-12346, 'SIGKILL']]);
});

test('an already absent process group needs no timer or individual-PID fallback', (t) => {
  const { signals, timers } = unixSignals(t, true);
  stopCli({ pid: 12347, exitCode: null, kill() { assert.fail('PID fallback for absent group'); } });
  assert.equal(signals.length, 1);
  assert.equal(timers.length, 0);
  stopCli({ exitCode: null }); // spawn failed before assigning a PID
  assert.equal(signals.length, 1);
});

for (const adapter of ['local-cli.mjs', 'codex-local-bridge.mjs']) {
  for (const leaderExits of [false, true]) {
    test(`${adapter} stops a real Unix CLI tree (leader exits: ${leaderExits})`, {
      skip: process.platform === 'win32', timeout: 10000,
    }, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'pr-cycle shutdown '));
      const cli = join(root, 'fake-cli.mjs');
      const descendant = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready:'+process.pid);`;
      writeFileSync(cli, `import {spawn} from 'node:child_process';
        process.on('SIGTERM',()=>{${leaderExits ? 'process.exit(0)' : ''}});
        process.stdin.resume();setInterval(()=>{},1000);
        const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']});
        child.stdout.on('data',chunk=>process.stderr.write(chunk));
        process.stderr.write('leader:'+process.pid+'\\n');`);
      const child = spawn(process.execPath, [resolve('skills/pr-cycle/scripts', adapter),
        adapter === 'local-cli.mjs' ? 'claude' : 'app-server'], {
        env: { ...process.env, PR_CYCLE_CLAUDE_PATH: cli, PR_CYCLE_CODEX_PATH: cli },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '', leader, descendantPid;
      t.after(() => {
        if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch {} }
        if (child.exitCode == null) child.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
      });
      const exited = once(child, 'exit');
      await new Promise((resolveReady, reject) => {
        child.on('error', reject);
        child.stderr.on('data', (data) => {
          output += data;
          leader = Number(output.match(/leader:(\d+)/)?.[1]);
          descendantPid = Number(output.match(/ready:(\d+)/)?.[1]);
          if (leader && descendantPid) resolveReady();
        });
      });
      const start = Date.now();
      // Model the backend's final 2s grace period after SIGTERM.
      child.kill('SIGTERM');
      await exited;
      assert.ok(Date.now() - start < 2000, 'wrapper must finish before backend SIGKILL');
      // SIGKILL terminates the descendant and closes its inherited pipe too.
      if (!child.stderr.readableEnded) await once(child.stderr, 'end');
      assert.ok(descendantPid > 0);
    });
  }
}
