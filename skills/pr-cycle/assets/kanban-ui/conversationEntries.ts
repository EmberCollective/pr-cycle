import type { PatchType } from 'shared/types';

// Claude's token-count notifications are telemetry, not conversation messages.
// Filter only the exact normalized system event. In particular, preserve errors,
// thinking text, approvals and raw stdout/stderr for diagnosis.
export function isVisibleConversationEntry(entry: PatchType): boolean {
  return !(
    entry.type === 'NORMALIZED_ENTRY' &&
    entry.content.entry_type.type === 'system_message' &&
    entry.content.content === 'System: thinking_tokens'
  );
}

function isModelRecognitionWarning(content: string): boolean {
  const prefix = '[claude-code:unrecognized_model] ';
  const line = content.trim();
  if (!line.startsWith(prefix)) return false;
  try {
    const payload = JSON.parse(line.slice(prefix.length));
    return (
      payload !== null &&
      typeof payload === 'object' &&
      Object.keys(payload).length === 2 &&
      typeof payload.model === 'string' &&
      payload.model.trim().length > 0 &&
      payload.query_source === 'sdk'
    );
  } catch {
    return false;
  }
}

// The legacy backend treats every stderr chunk as an error. Claude Code emits
// this specific diagnostic at warning level, even for working custom models.
// Reclassify only a complete known record; mixed/partial errors stay errors.
// Preserve the original text, patch identity, raw history and process status.
export function presentConversationEntries<T extends PatchType>(
  entries: readonly T[]
): T[] {
  return entries.filter(isVisibleConversationEntry).map((entry) => {
    if (
      entry.type !== 'NORMALIZED_ENTRY' ||
      entry.content.entry_type.type !== 'error_message' ||
      entry.content.entry_type.error_type.type !== 'other' ||
      !isModelRecognitionWarning(entry.content.content)
    ) {
      return entry;
    }
    return {
      ...entry,
      content: {
        ...entry.content,
        entry_type: { type: 'system_message' },
      },
    };
  });
}
