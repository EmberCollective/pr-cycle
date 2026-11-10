import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { extractResult, stageProfile, buildPrompt, createWorkflowService, handleWorkflowRequest } from '../skills/pr-cycle/scripts/kanban-workflow-api.mjs';

const answer = { passed: true, summary: '已核对', details: '功能及失败路径测试通过' };
const output = `PR_CYCLE_RESULT:${JSON.stringify(answer)}`;
test('collector accepts only complete assistant results across stdout chunks', () => {
  const raw = JSON.stringify({ type: 'result', is_error: false, result: output }) + '\n';
  const logs = [raw.slice(0, 12), raw.slice(12)].map(Stdout => JSON.stringify({ Stdout })).join('\n');
  assert.deepEqual(extractResult(logs), answer);
  assert.throws(() => extractResult(JSON.stringify({ Stdout: JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: output }] } }) })), /有效/);
  assert.throws(() => extractResult(JSON.stringify({ Stdout: JSON.stringify({ type: 'result', is_error: true, result: output }) })), /有效/);
  assert.throws(() => extractResult(JSON.stringify({ Stdout: output })), /有效/);
  const early = { type: 'assistant', message: { content: [{ type: 'text', text: output }] } };
  const final = { type: 'result', is_error: false, result: '发现了权限漏洞，尚未完成' };
  assert.throws(() => extractResult(JSON.stringify({ Stdout: JSON.stringify(early) + '\n' + JSON.stringify(final) + '\n' })), /有效/);
});

test('read-only roles cannot inherit bypass flags or executable tool permissions', () => {
  const baseline = { base_command_override: 'node local-cli.mjs claude', dangerously_skip_permissions: true, additional_params: ['--tools=Bash'], env: { KEEP: 'value' } };
  for (const role of ['plan', 'functional', 'security']) {
    const config = stageProfile(baseline, 'CLAUDE_CODE', role);
    assert.equal(config.dangerously_skip_permissions, false);
    assert.ok(config.additional_params.includes('--tools=Read,Glob,Grep'));
    assert.ok(config.additional_params.some(p => p.includes('ExitPlanMode')));
    assert.deepEqual(config.env, baseline.env);
  }
  const implementation = stageProfile(baseline, 'CLAUDE_CODE', 'implementation');
  assert.equal(implementation.approvals, false);
  assert.equal(implementation.dangerously_skip_permissions, true);
  assert.equal(implementation.additional_params, undefined);
  assert.equal(baseline.dangerously_skip_permissions, true);
  assert.equal(stageProfile({}, 'CODEX', 'functional').sandbox, 'read-only');
});

test('stage prompts include task and approved plan, honor task overrides, retain mandatory output contract', () => {
  const runtime = { task: { title: '添加导出', description: '导出 CSV' }, workflow: {
    revision: 2, risk: 'P1', plan: '先验证输入', prompts: { functional: '检查空列表' }, events: [],
  } };
  const prompt = buildPrompt('functional', runtime, { prompts: { functional: '默认提示' } }, [{ head_sha: 'abc' }]);
  assert.match(prompt, /检查空列表/); assert.doesNotMatch(prompt, /默认提示/);
  for (const text of ['导出 CSV', '先验证输入', 'PR_CYCLE_RESULT', '只读', 'abc']) assert.ok(prompt.includes(text));
});

test('public dispatcher never accepts fabricated results or internal launch permits', async () => {
  const calls = [];
  const service = createWorkflowService({ config: {}, command: async (...args) => { calls.push(args); return {}; } });
  for (const action of ['save_plan', 'record_result', 'record_child_result', 'prepare_launch', 'complete', 'bind_session']) {
    await assert.rejects(service.dispatch({ action, project_id: 'p', task_id: 't' }), /不允许/);
  }
  assert.equal(calls.length, 1); // schema initialization only
});

test('HTTP mutations require a same-origin browser request and valid JSON', async t => {
  const service = { read: async () => ({}), dispatch: async () => ({ ok: true }) };
  const server = http.createServer((req, res) => handleWorkflowRequest(req, res, service));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(base, options)).status, 403);
  assert.equal((await fetch(base, { ...options, headers: { ...options.headers, Origin: 'http://evil.invalid' } })).status, 403);
  assert.equal((await fetch(base, { ...options, headers: { ...options.headers, Origin: base } })).status, 200);
  assert.equal((await fetch(base, { ...options, headers: { ...options.headers, Origin: base }, body: '{bad' })).status, 400);
});
