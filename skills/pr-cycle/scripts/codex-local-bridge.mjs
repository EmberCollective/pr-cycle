#!/usr/bin/env node
// Vibe Kanban 0.0.166 speaks Codex v1; installed Codex speaks app-server v2.
// Keep credentials/configuration in Codex. stdout is exclusively JSON-RPC.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCli, stopCli } from './local-cli.mjs';

const duration = (ms = 0) => ({ secs: Math.floor((ms || 0) / 1000), nanos: ((ms || 0) % 1000) * 1e6 });
const nonNull = (value) => Object.fromEntries(Object.entries(value).filter(([, v]) => v != null));
const decisions = { approved: 'accept', approved_for_session: 'acceptForSession', denied: 'decline', abort: 'cancel' };

export function threadOptions(params = {}) {
  const { profile, compactPrompt, includeApplyPatchTool, ...options } = nonNull(params);
  // These old per-thread overrides no longer exist. Never silently ignore them.
  if (profile != null || compactPrompt != null || includeApplyPatchTool != null) {
    throw new Error('Local Codex bridge does not support profile/compactPrompt/includeApplyPatchTool overrides; configure the local CLI instead.');
  }
  if (options.approvalPolicy === 'on-failure') {
    throw new Error('Installed Codex removed on-failure approval policy; select a supported policy explicitly.');
  }
  return options;
}

export function fileChanges(changes = []) {
  return Object.fromEntries(changes.map(({ path, kind, diff }) => [path,
    kind.type === 'add' || kind.type === 'delete'
      ? { type: kind.type, content: diff }
      : { type: 'update', unified_diff: diff, move_path: kind.move_path ?? null },
  ]));
}

function userInput(items) {
  if (!Array.isArray(items)) throw new Error('Legacy message items must be an array.');
  return items.map((item, index) => {
    // v1 InputItem nests its payload under data; v2 UserInput is flat and
    // renames image_url to url. Do not forward the old tagged enum unchanged.
    switch (item?.type) {
      case 'text':
        if (typeof item.data?.text === 'string') return { type: 'text', text: item.data.text };
        break;
      case 'image':
        if (typeof item.data?.image_url === 'string') return { type: 'image', url: item.data.image_url };
        break;
      case 'localImage':
        if (typeof item.data?.path === 'string') return { type: 'localImage', path: item.data.path };
        break;
    }
    throw new Error(`Invalid or unsupported legacy message item at index ${index}.`);
  });
}

export class CodexBridge {
  constructor({ upstream, downstream, fatal, interrupted = () => {}, active = () => {} }) {
    Object.assign(this, { upstream, downstream, fatal, interrupted, active });
    this.pending = new Map();
    this.approvals = new Map();
    this.items = new Map();
    this.threads = new Map();
    this.lastMessage = new Map();
    this.sequence = 0;
  }

  event(type, fields = {}, threadId) {
    this.downstream({ method: `codex/event/${type}`, params: {
      conversationId: threadId, id: String(++this.sequence), msg: { type, ...fields },
    } });
  }

  fromClient(message) {
    const { id, method, params = {} } = message;
    if (!method) {
      const approval = this.approvals.get(id);
      if (!approval) return;
      this.approvals.delete(id);
      const decision = decisions[message.result?.decision];
      if (!decision || (approval.available && !approval.available.includes(decision))) {
        this.upstream({ id: approval.id, error: { code: -32602, message: 'Unsupported approval decision; no permission granted.' } });
        this.fatal('Unsupported approval decision; no permission granted.');
        return;
      }
      this.upstream({ id: approval.id, result: { decision } });
      return;
    }
    if (method === 'initialized') return this.upstream(message);
    try {
      let mapped = method;
      let data = params;
      switch (method) {
        case 'initialize':
          data = { ...params, capabilities: { ...params.capabilities, experimentalApi: true } };
          break;
        case 'newConversation':
          mapped = 'thread/start';
          data = { ...threadOptions(params), historyMode: 'legacy' };
          break;
        case 'resumeConversation':
          if (!params.path && !params.conversationId) throw new Error('Resume requires a rollout path or conversationId.');
          if (params.history) throw new Error('Inline legacy history is unsupported; resume using the rollout path.');
          mapped = 'thread/resume';
          data = { ...threadOptions(params.overrides ?? {}), threadId: params.conversationId ?? randomUUID(), excludeTurns: true };
          if (params.path) data.path = params.path;
          break;
        case 'addConversationListener':
          if (!this.threads.has(params.conversationId)) throw new Error('Unknown conversation.');
          this.downstream({ id, result: { subscriptionId: randomUUID() } });
          return;
        case 'sendUserMessage':
          mapped = 'turn/start';
          data = { threadId: params.conversationId, input: userInput(params.items) };
          this.active();
          break;
        case 'review/start':
          this.active();
          break;
        case 'getAuthStatus':
          // Vibe only checks the auth mode; do not expose a token to its raw logs.
          data = { ...params, includeToken: false };
          break;
        case 'mcpServerStatus/list':
          break;
        default:
          throw new Error(`Unsupported legacy request: ${method}`);
      }
      const upstreamId = `client:${++this.sequence}`;
      this.pending.set(upstreamId, { id, method });
      this.upstream({ id: upstreamId, method: mapped, params: data });
    } catch (error) {
      this.downstream({ id, error: { code: -32602, message: error.message } });
    }
  }

  fromServer(message) {
    const { id, method, params: p = {} } = message;
    if (!method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) return this.downstream({ id: pending.id, error: message.error });
      let result = message.result;
      if (['newConversation', 'resumeConversation'].includes(pending.method)) {
        const { thread, model, reasoningEffort } = result;
        if (!thread?.path) {
          this.downstream({ id: pending.id, error: { code: -32603, message: 'Local Codex did not return a legacy rollout path; cannot safely resume this session.' } });
          return this.fatal('Missing legacy rollout path.');
        }
        this.threads.set(thread.id, thread);
        const effort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort) ? reasoningEffort : null;
        result = { conversationId: thread.id, rolloutPath: thread.path, model, reasoningEffort: effort, initialMessages: null };
        this.downstream({ id: pending.id, result });
        this.downstream({ method: 'sessionConfigured', params: {
          sessionId: thread.id, rolloutPath: thread.path, model, reasoningEffort: effort,
          initialMessages: null, historyEntryCount: 0, historyLogId: 0,
        } });
        return;
      }
      if (pending.method === 'sendUserMessage') result = {};
      if (pending.method === 'getAuthStatus') result = { ...result, authToken: null };
      this.downstream({ id: pending.id, result });
      return;
    }
    if (id != null) return this.serverRequest(message);
    const emit = (type, fields) => this.event(type, fields, p.threadId);
    switch (method) {
      case 'turn/started':
        this.active();
        this.lastMessage.delete(p.threadId);
        emit('task_started', {});
        break;
      case 'turn/completed':
        if (p.turn.status === 'completed') emit('task_complete', { last_agent_message: this.lastMessage.get(p.threadId) ?? null });
        else if (p.turn.status === 'interrupted') {
          emit('turn_aborted', { reason: 'interrupted' });
          // Vibe may send queued denial feedback after turn_aborted.
          this.interrupted();
        } else {
          const text = p.turn.error?.message || `Codex turn ${p.turn.status}`;
          emit('error', { message: text });
          this.fatal(text);
        }
        break;
      case 'item/agentMessage/delta': emit('agent_message_delta', { delta: p.delta }); break;
      case 'item/reasoning/summaryTextDelta': emit('agent_reasoning_delta', { delta: p.delta }); break;
      case 'item/reasoning/summaryPartAdded': emit('agent_reasoning_section_break', {}); break;
      case 'item/commandExecution/outputDelta':
        emit('exec_command_output_delta', { call_id: p.itemId, stream: 'stdout', chunk: Buffer.from(p.delta).toString('base64') });
        break;
      case 'turn/plan/updated':
        emit('plan_update', { explanation: p.explanation, plan: p.plan.map((step) => ({ ...step, status: step.status === 'inProgress' ? 'in_progress' : step.status })) });
        break;
      case 'warning': case 'configWarning':
        emit('warning', { message: p.message ?? p.summary ?? 'Local Codex configuration warning' });
        break;
      case 'error':
        emit(p.willRetry ? 'stream_error' : 'error', { message: p.error?.message ?? 'Local Codex error' });
        break;
      case 'item/started': case 'item/completed':
        this.item(p, method === 'item/completed');
        break;
    }
  }

  serverRequest({ id, method, params: p }) {
    let legacyMethod;
    let params;
    if (method === 'item/commandExecution/requestApproval') {
      // v1 cannot display stdin, managed network, or additional-permission grants.
      if ((p.kind && p.kind !== 'command') || p.additionalPermissions || p.networkApprovalContext || !p.command || !p.cwd) {
        return this.unsupportedRequest(id, method);
      }
      legacyMethod = 'execCommandApproval';
      params = { callId: p.itemId, conversationId: p.threadId, command: [p.command], cwd: p.cwd, parsedCmd: [], reason: p.reason ?? null };
      this.event('exec_approval_request', { call_id: p.itemId, command: [p.command], cwd: p.cwd, parsed_cmd: [], reason: p.reason ?? null }, p.threadId);
    } else if (method === 'item/fileChange/requestApproval') {
      const item = this.items.get(`${p.threadId}:${p.itemId}`);
      if (!item?.changes?.length) return this.unsupportedRequest(id, 'file approval without a visible diff');
      legacyMethod = 'applyPatchApproval';
      params = { callId: p.itemId, conversationId: p.threadId, fileChanges: fileChanges(item.changes), grantRoot: p.grantRoot ?? null, reason: p.reason ?? null };
      this.event('apply_patch_approval_request', { call_id: p.itemId, changes: params.fileChanges, grant_root: params.grantRoot, reason: params.reason }, p.threadId);
    } else return this.unsupportedRequest(id, method);
    const downstreamId = `approval:${++this.sequence}`;
    this.approvals.set(downstreamId, { id, available: p.availableDecisions });
    this.downstream({ id: downstreamId, method: legacyMethod, params });
  }

  unsupportedRequest(id, method) {
    const message = `The legacy Kanban cannot display ${method}. Use the native Codex CLI for this interaction; no approval was granted.`;
    this.upstream({ id, error: { code: -32601, message } });
    this.event('error', { message });
    this.fatal(message);
  }

  item(p, completed) {
    const item = p.item;
    const key = `${p.threadId}:${item.id}`;
    if (!completed) this.items.set(key, item);
    const emit = (type, fields) => this.event(type, fields, p.threadId);
    const common = { call_id: item.id, turn_id: p.turnId };
    switch (item.type) {
      case 'agentMessage':
        if (completed) { this.lastMessage.set(p.threadId, item.text); emit('agent_message', { message: item.text }); }
        break;
      case 'reasoning':
        if (completed && item.summary?.length) emit('agent_reasoning', { text: item.summary.join('\n\n') });
        break;
      case 'commandExecution': {
        const command = { ...common, command: [item.command], cwd: item.cwd, parsed_cmd: [] };
        if (!completed) emit('exec_command_begin', command);
        else emit('exec_command_end', { ...command, duration: duration(item.durationMs), exit_code: item.exitCode ?? -1,
          formatted_output: item.aggregatedOutput ?? '', stdout: item.aggregatedOutput ?? '', stderr: '', aggregated_output: item.aggregatedOutput ?? '' });
        break;
      }
      case 'fileChange':
        if (!completed) emit('patch_apply_begin', { ...common, auto_approved: false, changes: fileChanges(item.changes) });
        else emit('patch_apply_end', { ...common, changes: fileChanges(item.changes), success: item.status === 'completed', stdout: '', stderr: item.status === 'completed' ? '' : item.status });
        break;
      case 'mcpToolCall': {
        const invocation = { server: item.server, tool: item.tool, arguments: item.arguments };
        if (!completed) emit('mcp_tool_call_begin', { ...common, invocation });
        else emit('mcp_tool_call_end', { ...common, invocation, duration: duration(item.durationMs),
          result: item.error || item.status === 'failed' ? { Err: item.error?.message ?? 'MCP tool failed' } : { Ok: item.result ?? { content: [] } } });
        break;
      }
      case 'webSearch': emit(completed ? 'web_search_end' : 'web_search_begin', { ...common, query: item.query }); break;
      case 'imageView': if (completed) emit('view_image_tool_call', { ...common, path: item.path }); break;
      case 'plan': if (completed) emit('agent_message', { message: item.text }); break;
      case 'userMessage': case 'contextCompaction': case 'enteredReviewMode': case 'exitedReviewMode': break;
      default:
        if (completed) emit('warning', { message: `Local Codex item ${item.type} is not rendered by this Kanban version. Native session history retains it.` });
    }
    if (completed) this.items.delete(key);
  }
}

function main() {
  let args = process.argv.slice(2);
  let env = process.env;
  if (args[0] === '--cli' && args[1]) {
    env = { ...env, PR_CYCLE_CODEX_PATH: args[1] };
    args = args.slice(2);
  }
  if (args[0] !== 'app-server') throw new Error('Usage: node codex-local-bridge.mjs app-server [CLI options]');
  const launch = resolveCli('codex', { env });
  const child = spawn(launch.command, [...launch.args, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env,
  });
  let stopping = false;
  let interruptTimer;
  let shutdownTimer;
  const cleanup = () => {
    clearTimeout(shutdownTimer);
    stopCli(child);
  };
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(interruptTimer);
    process.exitCode = code;
    input.close();
    process.stdin.pause();
    child.stdin.end();
    // Keep cleanup alive even when the CLI and all its pipes close first.
    shutdownTimer = setTimeout(cleanup, 2000);
  };
  const write = (stream, message) => { if (!stream.destroyed && !stream.writableEnded) stream.write(`${JSON.stringify(message)}\n`); };
  const bridge = new CodexBridge({
    upstream: (message) => write(child.stdin, message),
    downstream: (message) => write(process.stdout, message),
    fatal: (message) => { process.stderr.write(`Local CLI bridge: ${message}\n`); stop(1); },
    interrupted: () => { interruptTimer = setTimeout(() => stop(1), 3000); },
    active: () => clearTimeout(interruptTimer),
  });
  const input = createInterface({ input: process.stdin });
  const output = createInterface({ input: child.stdout });
  const parse = (line, handler) => {
    if (stopping) return;
    try { handler(JSON.parse(line)); }
    catch { bridge.fatal('Invalid JSON-RPC message or incompatible local CLI response.'); }
  };
  input.on('line', (line) => parse(line, (message) => bridge.fromClient(message)));
  output.on('line', (line) => parse(line, (message) => bridge.fromServer(message)));
  input.on('close', () => stop(0));
  // Codex diagnostics go to stderr, never mix them into the protocol stream.
  child.stderr.pipe(process.stderr);
  child.on('error', () => bridge.fatal('Could not launch the configured local Codex executable. Run use_local_clis.py again.'));
  child.stdin.on('error', () => stop(1));
  process.stdout.on('error', () => stop(1));
  // `exit` can precede `close`: surviving descendants may still hold the pipes.
  // Keep reading buffered protocol output until close, while cleaning the group.
  child.on('exit', cleanup);
  child.on('close', (code) => {
    if (!stopping) stop(code || 1);
    cleanup();
  });
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
      stop(code);
      // A backend termination signal has a shorter deadline than stdin EOF.
      cleanup();
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
