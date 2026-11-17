import { describe, expect, it } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { history, undoDepth, redoDepth } from '@codemirror/commands';
import { restoredHistory, retainHistory } from './editor-history';

describe('タブ間の編集履歴', () => {
  it('マウント固有の拡張を保持せずUndoとRedoを復元し、別ペインへ混ぜない', () => {
    let state = EditorState.create({ doc: '元', extensions: [history()] });
    state = state.update({ changes: { from: 1, insert: 'の追記' }, annotations: Transaction.userEvent.of('input.type') }).state;
    retainHistory('vault-a:0:note', state);
    const restored = EditorState.create({ doc: state.doc, extensions: [history(), restoredHistory('vault-a:0:note', state.doc.toString())] });
    expect(undoDepth(restored)).toBe(1); expect(redoDepth(restored)).toBe(0);
    expect(undoDepth(EditorState.create({ doc: state.doc, extensions: [history(), restoredHistory('vault-a:1:note', state.doc.toString())] }))).toBe(0);
  });
  it('外部で本文が変わった場合と別の保管庫では古いUndoを適用しない', () => {
    const state = EditorState.create({ doc: '元', extensions: [history()] }).update({ changes: { from: 1, insert: '追記' } }).state;
    retainHistory('vault-b:0:note', state);
    const changed = EditorState.create({ doc: '外部で更新', extensions: [history(), restoredHistory('vault-b:0:note', '外部で更新')] });
    expect(undoDepth(changed)).toBe(0);
    expect(undoDepth(EditorState.create({ doc: state.doc, extensions: [history(), restoredHistory('other-vault:0:note', state.doc.toString())] }))).toBe(0);
  });
});
