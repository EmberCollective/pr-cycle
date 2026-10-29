import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { probeCli, resolveCli } from '../skills/pr-cycle/scripts/local-cli.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'pr-cycle cli '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(path, content = '') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, { mode: 0o755 });
  return path;
}

test('two machines discover their own npm installs; changing PATH picks up the new CLI', (t) => {
  const root = workspace(t);
  for (const machine of ['machine A', 'machine B']) {
    const bin = join(root, machine, 'npm');
    file(join(bin, 'codex.cmd'), '@echo off');
    file(join(bin, 'node_modules/@openai/codex/bin/codex.js'), `process.stdout.write(${JSON.stringify(machine)});`);
    const env = { PATH: bin };
    const result = probeCli('codex', { env, platform: 'win32' });
    assert.equal(result.version, machine);
    assert.equal(result.command, process.execPath);
    assert.equal(result.source, join(bin, 'codex.cmd'));
  }
});

test('native npm packages follow machine architecture, independent of username/install drive', (t) => {
  const root = workspace(t);
  file(join(root, 'codex.cmd'));
  for (const [arch, target] of [['x64', 'x86_64'], ['arm64', 'aarch64']]) {
    const exe = file(join(root, `node_modules/@openai/codex/node_modules/@openai/codex-win32-${arch}/vendor/${target}-pc-windows-msvc/bin/codex.exe`));
    assert.equal(resolveCli('codex', { env: { PATH: root }, platform: 'win32', arch }).command, exe);
  }
  file(join(root, 'claude.cmd'));
  const claude = file(join(root, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
  assert.equal(resolveCli('claude', { env: { PATH: root }, platform: 'win32' }).command, claude);
});

test('explicit install overrides are opt-in and missing CLIs never fall back to npx', (t) => {
  const root = workspace(t);
  const path = file(join(root, 'my custom CLI.mjs'), 'process.stdout.write("custom");');
  assert.equal(probeCli('codex', { env: { PATH: '', PR_CYCLE_CODEX_PATH: path } }).version, 'custom');
  assert.throws(() => resolveCli('claude', { env: { PATH: root } }), /No CLI will be downloaded/);
  assert.throws(() => resolveCli('codex', { env: { PATH: root, PR_CYCLE_CODEX_PATH: 'relative.exe' } }), /must be absolute/);
});

test('PATH precedence is honored and relative/current-directory entries are ignored', (t) => {
  const root = workspace(t);
  const first = join(root, 'one');
  const second = join(root, 'two');
  file(join(first, 'claude.exe'));
  file(join(second, 'claude.exe'));
  assert.equal(resolveCli('claude', { env: { PATH: ['', '.', first, second].join(delimiter) }, platform: 'win32' }).command, join(first, 'claude.exe'));
});

test('Unix native CLI is launched directly and npm JS entries use Node', { skip: process.platform === 'win32' }, (t) => {
  const root = workspace(t);
  const native = file(join(root, 'claude'), '#!/bin/sh\nprintf "native-version"\n');
  assert.equal(probeCli('claude', { env: { PATH: root } }).version, 'native-version');
  assert.equal(resolveCli('claude', { env: { PATH: root } }).command, native);
});
