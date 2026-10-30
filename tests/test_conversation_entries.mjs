import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVisibleConversationEntry, presentConversationEntries } from '../skills/pr-cycle/assets/kanban-ui/conversationEntries.ts';

const normalized = (type, content, key) => ({
  type: 'NORMALIZED_ENTRY', patchKey: key,
  content: { timestamp: null, entry_type: type === 'error_message' ? { type, error_type: { type: 'other' } } : { type }, content },
});

const warning = '[claude-code:unrecognized_model] {"model":"glm-5.3-flash","query_source":"sdk"}';

test('standalone model recognition warning becomes informational without altering raw logs or process status', () => {
  const entry = normalized('error_message', warning + '\n', 'process:1');
  entry.executionProcessId = 'process';
  const failure = normalized('error_message', '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null', 'process:2');
  const next = normalized('next_action', '', 'process:next');
  next.content.entry_type.failed = true;
  const result = presentConversationEntries([entry, failure, next]);
  assert.deepEqual(result[0], { ...entry, content: { ...entry.content, entry_type: { type: 'system_message' } } });
  assert.equal(entry.content.entry_type.type, 'error_message');
  assert.equal(result[1], failure);
  assert.equal(result[2], next);
  assert.deepEqual(presentConversationEntries(result), result);
});

test('real errors, mixed stderr, partial records, unknown schemas and quoted warnings stay unchanged', () => {
  const entries = [
    ...[
      warning + '\nAPI Error: 401 unauthorized',
      warning + '\n' + warning,
      'API Error: 429 rate limited\n' + warning,
      'model_not_found: glm-5.3-flash',
      warning.slice(0, -1),
      warning.replace('"sdk"', '"unknown"'),
      warning.replace('glm-5.3-flash', ''),
      warning.replace('"glm-5.3-flash"', 'null'),
      warning.replace('}', ',"error":"Request failed"}'),
      '[claude-code:unrecognized_model] null',
      '[claude-code:unrecognized_model] []',
    ].map((content, n) => normalized('error_message', content, `error:${n}`)),
    normalized('user_message', warning, 'user'),
    normalized('assistant_message', warning, 'assistant'),
    { type: 'STDERR', content: warning },
    { type: 'STDOUT', content: warning },
    { ...normalized('error_message', warning, 'setup'), content: { content: warning, timestamp: null, entry_type: { type: 'error_message', error_type: { type: 'setup_required' } } } },
  ];
  const result = presentConversationEntries(entries);
  result.forEach((entry, i) => assert.equal(entry, entries[i]));
});

test('incremental updates can upgrade a warning back to an error when stderr adds failure details', () => {
  const entry = normalized('error_message', warning, 'process:0');
  assert.equal(presentConversationEntries([entry])[0].content.entry_type.type, 'system_message');
  const updated = { ...entry, content: { ...entry.content, content: warning + '\nAPI Error: 500' } };
  assert.equal(presentConversationEntries([updated])[0], updated);
  assert.equal(presentConversationEntries([normalized('system_message', 'System: thinking_tokens', 'process:1')]).length, 0);
});

test('token notifications do not flood history or streaming updates; original keys survive', () => {
  const thinking = normalized('thinking', 'Actual reasoning', 'process:0');
  const spam = Array.from({ length: 217 }, (_, n) => normalized('system_message', 'System: thinking_tokens', `process:${n + 1}`));
  const error = normalized('error_message', 'Provider response incomplete', 'process:218');
  const all = [thinking, ...spam, error];
  assert.deepEqual(all.filter(isVisibleConversationEntry), [thinking, error]);
  for (let i = 1; i < all.length; i++) {
    assert.deepEqual(all.slice(0, i).filter(isVisibleConversationEntry), [thinking]);
  }
  assert.equal(all.length, 219, 'the raw event history is retained');
});

test('errors, approvals, raw output and unknown system events remain visible', () => {
  for (const entry of [
    normalized('error_message', 'System: thinking_tokens', 'error'),
    normalized('user_message', 'System: thinking_tokens', 'user'),
    normalized('assistant_message', 'System: thinking_tokens', 'assistant'),
    normalized('tool_use', 'Approval required', 'approval'),
    normalized('system_message', 'System: hook_started', 'hook'),
    normalized('system_message', 'System: thinking_tokens failed', 'unknown'),
    { type: 'STDERR', content: 'System: thinking_tokens' },
    { type: 'STDOUT', content: 'System: thinking_tokens' },
  ]) assert.equal(isVisibleConversationEntry(entry), true);
});
