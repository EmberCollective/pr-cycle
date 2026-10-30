import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridge, threadOptions } from '../skills/pr-cycle/scripts/codex-local-bridge.mjs';

function fixture() {
  const up = [], down = [], failures = [];
  let interruptions = 0;
  const bridge = new CodexBridge({ upstream: (m) => up.push(m), downstream: (m) => down.push(m),
    fatal: (m) => failures.push(m), interrupted: () => interruptions++ });
  return { bridge, up, down, failures, get interruptions() { return interruptions; } };
}
const notify = (bridge, method, params) => bridge.fromServer({ method, params });
const messages = (f, type) => f.down.filter((m) => m.method === `codex/event/${type}`).map((m) => m.params.msg);

test('new session inherits model/provider, preserves sandbox, and returns resumable legacy history', () => {
  const f = fixture();
  f.bridge.fromClient({ id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '1' } } });
  assert.equal(f.up[0].params.capabilities.experimentalApi, true);
  f.bridge.fromClient({ id: 2, method: 'newConversation', params: { model: null, profile: null, sandbox: 'read-only', approvalPolicy: 'untrusted', cwd: 'C:/scratch' } });
  assert.deepEqual(f.up[1].params, { sandbox: 'read-only', approvalPolicy: 'untrusted', cwd: 'C:/scratch', historyMode: 'legacy' });
  f.bridge.fromServer({ id: f.up[1].id, result: { model: 'local-model', reasoningEffort: 'high', thread: { id: 'thread-a', path: 'C:/sessions/a.jsonl' } } });
  assert.equal(f.down[0].id, 2);
  assert.equal(f.down[0].result.conversationId, 'thread-a');
  assert.equal(f.down[1].method, 'sessionConfigured');
  assert.equal(f.down[1].params.rolloutPath, 'C:/sessions/a.jsonl');
  f.bridge.fromClient({ id: 3, method: 'addConversationListener', params: { conversationId: 'thread-a' } });
  assert.match(f.down[2].result.subscriptionId, /^[a-f0-9-]{36}$/);
});

test('resume uses the forked rollout path and errors are forwarded with the original ID', () => {
  const f = fixture();
  f.bridge.fromClient({ id: 'resume', method: 'resumeConversation', params: { path: 'C:/fork.jsonl', overrides: { cwd: 'C:/worktree', sandbox: 'workspace-write' } } });
  assert.equal(f.up[0].method, 'thread/resume');
  assert.equal(f.up[0].params.path, 'C:/fork.jsonl');
  assert.equal(f.up[0].params.sandbox, 'workspace-write');
  assert.ok(f.up[0].params.threadId);
  const error = { code: -32600, message: 'No such rollout' };
  f.bridge.fromServer({ id: f.up[0].id, error });
  assert.deepEqual(f.down[0], { id: 'resume', error });
});

test('pinned Kanban review/start reaches Codex and preserves result/error routing', () => {
  // The pinned backend uses v2's slash-separated review method even though its
  // conversation methods are v1. These are ReviewStartParams from its schema.
  const params = { threadId: 'review-thread', target: { type: 'custom', instructions: 'Review this branch' }, delivery: null };
  for (const response of [
    { result: { reviewThreadId: 'review-thread', turn: { id: 'review-turn', status: 'inProgress', items: [], error: null } } },
    { error: { code: -32602, message: 'Review target is unavailable' } },
  ]) {
    const f = fixture();
    f.bridge.fromClient({ id: 'review-client', method: 'review/start', params });
    assert.equal(f.up.length, 1);
    assert.equal(f.up[0].method, 'review/start');
    assert.deepEqual(f.up[0].params, params);
    assert.deepEqual(f.down, [], 'wait for the real server response');
    f.bridge.fromServer({ id: f.up[0].id, ...response });
    assert.deepEqual(f.down, [{ id: 'review-client', ...response }]);
    assert.deepEqual(f.failures, []);
  }
});

test('pinned v1 sendUserMessage payloads become v2 input in order without changing content', () => {
  // v1 InputItem uses serde's content="data", including for denial feedback.
  const items = [
    { type: 'text', data: { text: '修复\n  keep whitespace 😀' } },
    { type: 'image', data: { image_url: 'data:image/png;base64,AA==' } },
    { type: 'localImage', data: { path: 'C:/images/a b.png' } },
    { type: 'text', data: { text: '' } },
  ];
  const original = structuredClone(items);
  for (const response of [
    { result: { turn: { id: 'turn-a', status: 'inProgress' } } },
    { error: { code: -32602, message: 'Thread not found' } },
  ]) {
    const f = fixture();
    f.bridge.fromClient({ id: 'message-client', method: 'sendUserMessage', params: { conversationId: 'thread-a', items } });
    assert.equal(f.up.length, 1);
    assert.equal(f.up[0].method, 'turn/start');
    assert.deepEqual(f.up[0].params, { threadId: 'thread-a', input: [
      { type: 'text', text: items[0].data.text },
      { type: 'image', url: items[1].data.image_url },
      { type: 'localImage', path: items[2].data.path },
      { type: 'text', text: '' },
    ] });
    f.bridge.fromServer({ id: f.up[0].id, ...response });
    assert.deepEqual(f.down, [{ id: 'message-client', ...(response.error ? response : { result: {} }) }]);
    assert.deepEqual(f.failures, []);
  }
  assert.deepEqual(items, original);
});

test('invalid legacy input is rejected without forwarding partial messages or echoing content', () => {
  for (const items of [undefined, {}, [null], [{ type: 'text' }],
    [{ type: 'text', data: { text: 123 } }], [{ type: 'image', data: {} }],
    [{ type: 'localImage', data: { path: null } }],
    [{ type: 'unknown-sensitive-input', data: { text: 'private content' } }],
    [{ type: 'text', data: { text: 'private content' } }, { type: 'image' }],
  ]) {
    const f = fixture();
    f.bridge.fromClient({ id: 'invalid', method: 'sendUserMessage', params: { conversationId: 'thread-a', items } });
    assert.deepEqual(f.up, []);
    assert.equal(f.bridge.pending.size, 0);
    assert.equal(f.down[0].id, 'invalid');
    assert.equal(f.down[0].error.code, -32602);
    assert.doesNotMatch(f.down[0].error.message, /private content|unknown-sensitive-input/);
  }
});

test('does not expose auth tokens or silently drop unsupported settings', () => {
  const f = fixture();
  f.bridge.fromClient({ id: 1, method: 'getAuthStatus', params: { includeToken: true } });
  assert.equal(f.up[0].params.includeToken, false);
  f.bridge.fromServer({ id: f.up[0].id, result: { authToken: 'secret', authMethod: 'apikey' } });
  assert.equal(f.down[0].result.authToken, null);
  assert.throws(() => threadOptions({ approvalPolicy: 'on-failure' }), /removed/);
  assert.throws(() => threadOptions({ profile: 'custom' }), /configure the local CLI/);
});

test('streamed text becomes a legacy task completion; failed/interrupted turns never succeed', () => {
  const f = fixture();
  notify(f.bridge, 'turn/started', { threadId: 'a', turn: { id: 't' } });
  notify(f.bridge, 'item/agentMessage/delta', { threadId: 'a', delta: 'OK' });
  notify(f.bridge, 'item/completed', { threadId: 'a', item: { type: 'agentMessage', id: 'm', text: 'OK' } });
  notify(f.bridge, 'turn/completed', { threadId: 'a', turn: { status: 'completed' } });
  assert.equal(messages(f, 'agent_message_delta')[0].delta, 'OK');
  assert.equal(messages(f, 'task_complete')[0].last_agent_message, 'OK');
  notify(f.bridge, 'turn/completed', { threadId: 'a', turn: { status: 'failed', error: { message: 'provider unavailable' } } });
  notify(f.bridge, 'turn/completed', { threadId: 'a', turn: { status: 'interrupted' } });
  assert.equal(messages(f, 'task_complete').length, 1);
  assert.deepEqual(f.failures, ['provider unavailable']);
  assert.equal(f.interruptions, 1);
});

test('command output, exit status, patch changes and MCP errors remain visible', () => {
  const f = fixture();
  const p = { threadId: 'a', turnId: 't' };
  const command = { type: 'commandExecution', id: 'cmd', command: 'echo hello', cwd: 'C:/work' };
  notify(f.bridge, 'item/started', { ...p, item: command });
  notify(f.bridge, 'item/commandExecution/outputDelta', { ...p, itemId: 'cmd', delta: '你好\n' });
  notify(f.bridge, 'item/completed', { ...p, item: { ...command, exitCode: 7, durationMs: 1234, aggregatedOutput: '你好\n' } });
  assert.equal(Buffer.from(messages(f, 'exec_command_output_delta')[0].chunk, 'base64').toString(), '你好\n');
  assert.equal(messages(f, 'exec_command_end')[0].exit_code, 7);
  assert.deepEqual(messages(f, 'exec_command_end')[0].duration, { secs: 1, nanos: 234000000 });
  const patch = { type: 'fileChange', id: 'edit', changes: [{ path: 'x.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b' }] };
  notify(f.bridge, 'item/started', { ...p, item: patch });
  notify(f.bridge, 'item/completed', { ...p, item: { ...patch, status: 'failed' } });
  assert.equal(messages(f, 'patch_apply_end')[0].success, false);
  assert.equal(messages(f, 'patch_apply_end')[0].changes['x.txt'].unified_diff, patch.changes[0].diff);
  notify(f.bridge, 'item/completed', { ...p, item: { type: 'mcpToolCall', id: 'tool', server: 'local', tool: 'read', arguments: {}, status: 'failed', error: { message: 'denied' } } });
  assert.deepEqual(messages(f, 'mcp_tool_call_end')[0].result, { Err: 'denied' });
});

for (const [oldDecision, expected] of Object.entries({ approved: 'accept', approved_for_session: 'acceptForSession', denied: 'decline', abort: 'cancel' })) {
  test(`command approval preserves ${oldDecision} and request ID routing`, () => {
    const f = fixture();
    f.bridge.fromServer({ id: 19, method: 'item/commandExecution/requestApproval', params: { threadId: 'a', itemId: 'cmd', command: 'write file', cwd: 'C:/work' } });
    const request = f.down.find((m) => m.method === 'execCommandApproval');
    assert.equal(request.params.command[0], 'write file');
    assert.equal(f.up.length, 0, 'must wait for backend approval');
    f.bridge.fromClient({ id: request.id, result: { decision: oldDecision } });
    assert.deepEqual(f.up[0], { id: 19, result: { decision: expected } });
  });
}

test('file approval displays actual cached changes and a denial is preserved', () => {
  const f = fixture();
  notify(f.bridge, 'item/started', { threadId: 'a', item: { id: 'patch', type: 'fileChange', changes: [{ path: 'x', kind: { type: 'add' }, diff: 'hello\n' }] } });
  f.bridge.fromServer({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'a', itemId: 'patch', reason: 'write' } });
  const request = f.down.find((m) => m.method === 'applyPatchApproval');
  assert.deepEqual(request.params.fileChanges, { x: { type: 'add', content: 'hello\n' } });
  f.bridge.fromClient({ id: request.id, result: { decision: 'denied' } });
  assert.deepEqual(f.up[0], { id: 2, result: { decision: 'decline' } });
});

test('unsupported grants, missing diffs and invalid decisions never produce an approval', () => {
  for (const request of [
    { method: 'item/tool/requestUserInput', params: {} },
    { method: 'item/fileChange/requestApproval', params: { threadId: 'a', itemId: 'missing' } },
    { method: 'item/commandExecution/requestApproval', params: { command: 'echo test', cwd: 'C:/', additionalPermissions: { network: true } } },
  ]) {
    const f = fixture();
    f.bridge.fromServer({ id: 1, ...request });
    assert.ok(f.up[0].error);
    assert.equal(f.failures.length, 1);
    assert.equal(f.down.some((m) => m.result?.decision), false);
  }
  const f = fixture();
  f.bridge.fromServer({ id: 2, method: 'item/commandExecution/requestApproval', params: { threadId: 'a', itemId: 'cmd', command: 'echo test', cwd: 'C:/', availableDecisions: ['decline'] } });
  f.bridge.fromClient({ id: f.down.at(-1).id, result: { decision: 'approved' } });
  assert.ok(f.up[0].error);
  assert.equal(f.failures.length, 1);
});
