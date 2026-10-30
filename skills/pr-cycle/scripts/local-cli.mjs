#!/usr/bin/env node
// Resolve on every launch, like agent-orchestrator's local binary adapters.
// No downloads, shell command assembly, credentials, or machine-specific paths.
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function resolveCli(name, { env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (!['codex', 'claude'].includes(name)) throw new Error(`Unsupported local CLI: ${name}`);
  const explicit = env[`PR_CYCLE_${name.toUpperCase()}_PATH`];
  if (explicit && !isAbsolute(explicit)) throw new Error(`PR_CYCLE_${name.toUpperCase()}_PATH must be absolute.`);
  const windows = platform === 'win32';
  const exists = (path) => {
    try { return statSync(path).isFile(); } catch { return false; }
  };
  const candidates = explicit ? [explicit] : (env.PATH ?? env.Path ?? '').split(delimiter)
    .filter((entry) => isAbsolute(entry.replace(/^"|"$/g, '')))
    .flatMap((entry) => (windows ? ['.exe', '.cmd', '.bat', '.ps1'] : [''])
      .map((suffix) => join(entry.replace(/^"|"$/g, ''), name + suffix)));
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const path = realpathSync(candidate);
    const extension = extname(path).toLowerCase();
    if (windows && ['.cmd', '.bat', '.ps1'].includes(extension)) {
      const modules = join(dirname(candidate), 'node_modules');
      const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
      const pkg = join(modules, name === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code');
      const native = name === 'codex' ? [
        join(pkg, `node_modules/@openai/codex-win32-${arch}/vendor/${target}/bin/codex.exe`),
        join(modules, `@openai/codex-win32-${arch}/vendor/${target}/bin/codex.exe`),
        join(pkg, `vendor/${target}/codex/codex.exe`), join(pkg, 'bin/codex.exe'),
      ] : [join(pkg, 'bin/claude.exe')];
      const executable = native.find(exists);
      if (executable) return { command: executable, args: [], source: candidate };
      const script = join(pkg, name === 'codex' ? 'bin/codex.js' : 'cli.js');
      if (exists(script)) return { command: process.execPath, args: [script], source: candidate };
      throw new Error(`Cannot resolve ${name}'s shim: ${candidate}. Set PR_CYCLE_${name.toUpperCase()}_PATH to its executable or JS entry.`);
    }
    if (['.js', '.mjs', '.cjs'].includes(extension)) return { command: process.execPath, args: [path], source: candidate };
    if (!windows) {
      try { accessSync(path, constants.X_OK); } catch { continue; }
    }
    return { command: path, args: [], source: candidate };
  }
  throw new Error(`${name} is not installed/on PATH. Install and configure it locally, or set PR_CYCLE_${name.toUpperCase()}_PATH. No CLI will be downloaded automatically.`);
}

export function probeCli(name, options) {
  const launch = resolveCli(name, options);
  const result = spawnSync(launch.command, [...launch.args, '--version'], {
    encoding: 'utf8', timeout: 15000, windowsHide: true, env: options?.env ?? process.env,
  });
  if (result.error || result.status !== 0) throw new Error(`${name} --version failed; check the local installation.`);
  return { ...launch, version: result.stdout.trim() };
}

// Each wrapper owns its child tree; stopping a board worker also stops its CLI.
const stoppingChildren = new WeakSet();
export function stopCli(child) {
  if (!child.pid || stoppingChildren.has(child)) return;
  stoppingChildren.add(child);
  if (process.platform === 'win32') {
    if (child.exitCode != null) return;
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    const signalGroup = (signal) => {
      try { process.kill(-child.pid, signal); return true; }
      catch (error) {
        if (error.code === 'ESRCH') return false;
        if (child.exitCode == null) child.kill(signal);
        return true;
      }
    };
    if (!signalGroup('SIGTERM')) return;
    // Keep the timer alive even if the leader exits: descendants can survive it.
    // Finish before Kanban escalates from a termination signal to SIGKILL (2s).
    setTimeout(() => signalGroup('SIGKILL'), 1000);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--probe') {
    const names = args[1] ? [args[1]] : ['codex', 'claude'];
    const results = Object.fromEntries(names.map((name) => {
      try { return [name, { available: true, ...probeCli(name) }]; }
      catch (error) { return [name, { available: false, error: error.message }]; }
    }));
    process.stdout.write(`${JSON.stringify(results)}\n`);
    return;
  }
  const [name, ...tail] = args;
  const launch = resolveCli(name);
  const child = spawn(launch.command, [...launch.args, ...tail], {
    stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32',
  });
  child.on('error', (error) => { process.stderr.write(`Local ${name}: ${error.message}\n`); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stopCli(child));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
