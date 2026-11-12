import { StateEffect, StateField, type Transaction } from '@codemirror/state';
import { applyChanges, type SourceFile, type TextChange } from '../../domain/documents';

export const sourceFilesEffect = StateEffect.define<SourceFile[]>();

export function changesOf(transaction: Transaction): TextChange[] {
  const changes: TextChange[] = [];
  transaction.changes.iterChanges((from, to, _nextFrom, _nextTo, text) => changes.push({ from, to, insert: text.toString() }));
  return changes;
}

// Keep physical file boundaries in the editor's transaction state. React may
// batch updates; typing and preview must use the same current source model.
export const sourceFilesField = StateField.define<SourceFile[]>({
  create: () => [],
  update(files, transaction) {
    for (const effect of transaction.effects) if (effect.is(sourceFilesEffect)) return effect.value;
    return transaction.docChanged ? applyChanges(files, changesOf(transaction)) : files;
  },
});
