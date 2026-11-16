const marker = 'PR_CYCLE_RESULT:';
const invalidResult = () => new Error('Agent 未返回有效的阶段结果。请打开会话检查输出后重试本阶段；退出成功不等于审查通过。');

function resultObject(message) {
  if (typeof message !== 'string') throw invalidResult();
  const offset = message.lastIndexOf(marker);
  if (offset < 0) throw invalidResult();
  const source = message.slice(offset + marker.length).trimStart().replace(/^```(?:json)?\s*/i, '');
  if (source[0] !== '{') throw invalidResult();
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        const value = JSON.parse(source.slice(0, index + 1));
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      } catch { /* A balanced but malformed object is not a verdict. */ }
      throw invalidResult();
    }
  }
  throw invalidResult();
}

// Decode only known log/protocol envelopes; never search tool output for a verdict.
export function extractResult(logs) {
  if (typeof logs !== 'string') throw invalidResult();
  let buffer = '', rawSeen = false, rawMessage, normalizedMessage, terminalSeen = false, terminalFailed = false;
  let rawPosition = -1, normalizedPosition = -1, position = 0;
  const raw = (message) => { rawSeen = true; rawMessage = message; rawPosition = position; };
  function protocol(line) {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
      // Some log exporters JSON-encode the protocol line once more.
      if (typeof event === 'string') event = JSON.parse(event);
    } catch { raw(null); return; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    if (event.parent_tool_use_id != null) return;
    if (event.type === 'result') {
      terminalSeen = true;
      terminalFailed ||= event.is_error !== false || Boolean(event.subtype?.startsWith('error'));
      raw(terminalFailed ? null : event.result);
    } else if (event.type === 'assistant') {
      if (terminalSeen) return;
      if (event.message?.role && event.message.role !== 'assistant') return;
      raw(Array.isArray(event.message?.content)
        ? event.message.content.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n')
        : null);
    } else if (event.type === 'error') { terminalFailed = true; raw(null); }
    else if (event.method === 'codex/event/agent_message' && !terminalSeen) raw(event.params?.msg?.message);
    else if (event.method === 'codex/event/task_complete') { terminalSeen = true; raw(event.params?.msg?.last_agent_message); }
    else if (['codex/event/error', 'codex/event/turn_aborted'].includes(event.method)) { terminalFailed = true; raw(null); }
  }
  for (const line of logs.split('\n')) {
    position++;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event?.Stdout === 'string') {
      buffer += event.Stdout;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        protocol(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    for (const patch of Array.isArray(event?.JsonPatch) ? event.JsonPatch : []) {
      if (!['add', 'replace'].includes(patch.op) || !/^\/entries\/\d+$/.test(patch.path ?? '')) continue;
      const entry = patch.value;
      if (entry?.entry_type?.type === 'assistant_message') {
        normalizedMessage = entry.content; normalizedPosition = position;
      } else if (entry?.entry_type?.type === 'error_message') {
        normalizedMessage = null; normalizedPosition = position;
      }
    }
  }
  if (buffer.trim()) protocol(buffer);
  // Raw terminal failures cannot be replaced by an older normalized assistant message.
  if (rawSeen) {
    if (terminalFailed) throw invalidResult();
    if (normalizedPosition > rawPosition && normalizedMessage === null) throw invalidResult();
    return resultObject(rawMessage);
  }
  return resultObject(normalizedMessage);
}
