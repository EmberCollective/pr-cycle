import test from 'node:test';
import assert from 'node:assert/strict';
import { extractResult } from '../skills/pr-cycle/scripts/workflow-result.mjs';

const answer = { passed: true, summary: '已核对', details: '嵌套 { 大括号 }、引号 " 和反斜杠 \\ 不应截断', nested: { values: ['}', '{'] } };
const marked = `PR_CYCLE_RESULT:${JSON.stringify(answer)}`;
const result = (text = marked, fields = {}) => ({ type: 'result', is_error: false, result: text, ...fields });
const assistant = (text = marked, fields = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...fields });
const logs = (...events) => JSON.stringify({ Stdout: events.map(event => JSON.stringify(event)).join('\n') + '\n' });

test('terminal result permits a code fence and ponytail note after the bounded JSON object', () => {
  assert.deepEqual(extractResult(logs(result(`说明\n\`\`\`json\n${marked}\n\`\`\`\n未执行真实部署。风险：需要最终人工批准。`))), answer);
  assert.deepEqual(extractResult(logs(result(`PR_CYCLE_RESULT:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``))), answer);
});

test('native JSON-escaped stdout split across arbitrary chunks is reassembled before decoding', () => {
  const raw = JSON.stringify(result(marked + '\n未跑测试（规划阶段）。')) + '\n';
  const chunks = [raw.slice(0, 7), raw.slice(7, 31), raw.slice(31, 90), raw.slice(90)];
  assert.deepEqual(extractResult(chunks.map(Stdout => JSON.stringify({ Stdout })).join('\n')), answer);
  assert.deepEqual(extractResult(JSON.stringify({ Stdout: JSON.stringify(JSON.stringify(result())) })), answer);
});

test('tool and subagent output cannot provide the parent stage result', () => {
  for (const event of [
    { type: 'user', message: { content: [{ type: 'tool_result', content: marked }] } },
    { type: 'tool_result', result: marked },
    assistant(marked, { parent_tool_use_id: 'child-tool' }),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_result', content: marked }] } },
    { type: 'assistant', message: { role: 'user', content: [{ type: 'text', text: marked }] } },
  ]) assert.throws(() => extractResult(logs(event)), /有效/);
  assert.throws(() => extractResult(JSON.stringify({ Stdout: marked })), /有效/);
  assert.throws(() => extractResult(JSON.stringify({ Stderr: JSON.stringify(result()) })), /有效/);
});

test('later error, incomplete or non-verdict terminal response supersedes an earlier pass', () => {
  for (const final of [result(marked, { is_error: true }), result('尚未完成'), result(marked, { subtype: 'error_max_turns' }), { type: 'error', message: 'Failed' }]) {
    assert.throws(() => extractResult(logs(assistant(), final)), /有效/);
  }
  assert.throws(() => extractResult(JSON.stringify({ Stdout: JSON.stringify(assistant()) + '\n{"type":"result"' })), /有效/);
  assert.deepEqual(extractResult(logs(assistant(), result('PR_CYCLE_RESULT:{"passed":false,"summary":"未通过"}'))), { passed: false, summary: '未通过' });
  assert.throws(() => extractResult(logs(result(marked, { is_error: true }), assistant())), /有效/);
  assert.throws(() => extractResult(logs(result('尚未完成'), assistant())), /有效/);
  assert.throws(() => extractResult(logs(result(marked, { is_error: true }), result())), /有效/);
});

test('only the final marker is eligible and malformed objects fail closed', () => {
  for (const text of [marked + '\nPR_CYCLE_RESULT:{broken}', 'PR_CYCLE_RESULT:[]', 'PR_CYCLE_RESULT:null', 'PR_CYCLE_RESULT:{"passed":true', 'PR_CYCLE_RESULT:{"passed":true,}']) {
    assert.throws(() => extractResult(logs(result(text))), /有效/);
  }
});

test('Codex completion is authoritative and subsequent error invalidates it', () => {
  const event = (kind, msg) => ({ method: `codex/event/${kind}`, params: { msg } });
  assert.deepEqual(extractResult(logs(event('agent_message', { message: marked }), event('task_complete', { last_agent_message: marked + '\n未发布。' }))), answer);
  assert.throws(() => extractResult(logs(event('agent_message', { message: marked }), event('error', { message: 'Failed' }))), /有效/);
  assert.throws(() => extractResult(logs(event('agent_message', { message: marked }), event('task_complete', { last_agent_message: null }))), /有效/);
});

test('normalized assistant messages are fallback only and cannot hide a raw terminal error', () => {
  const patch = (type, content) => JSON.stringify({ JsonPatch: [{ op: 'add', path: '/entries/0', value: { entry_type: { type }, content } }] });
  assert.deepEqual(extractResult(patch('assistant_message', marked)), answer);
  assert.throws(() => extractResult(patch('tool_use', marked)), /有效/);
  assert.throws(() => extractResult(patch('assistant_message', marked) + '\n' + logs(result(marked, { is_error: true }))), /有效/);
  assert.throws(() => extractResult(logs(result()) + '\n' + patch('error_message', 'Failed')), /有效/);
});
