import { historyField } from '@codemirror/commands';
import type { EditorState, Extension } from '@codemirror/state';

// Store history only, not EditorState extensions that close over a mounted view.
// A changed source (including an external edit) must never revive a stale undo.
const readHistory = (state: EditorState) => state.field(historyField);
const histories = new Map<string, { text: string; history: ReturnType<typeof readHistory> }>();
export function restoredHistory(key: string, text: string): Extension {
  const saved = histories.get(key);
  if (!saved || saved.text !== text) { histories.delete(key); return []; }
  return historyField.init(() => saved.history);
}
export function retainHistory(key: string, state: EditorState) {
  histories.delete(key);
  histories.set(key, { text: state.doc.toString(), history: state.field(historyField) });
  while (histories.size > 60) histories.delete(histories.keys().next().value!);
}
