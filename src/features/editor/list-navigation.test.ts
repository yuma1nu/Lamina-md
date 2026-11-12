import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { compose, fromDisk } from '../../domain/documents';
import { listCaretGuard, listPrefixes, listPrefixField } from './list-navigation';
import { sourceFilesField } from './source-model';

function state(text: string) {
  const files = [fromDisk({ path: 'メモ/記録.md', content: text, revision: 'r' })];
  return EditorState.create({ doc: text, extensions: [sourceFilesField.init(() => files), listPrefixField, listCaretGuard] });
}
describe('リストのキャレット位置', () => {
  it('実際のリストだけで記号と字下げを判定し、コードの同じ文字列を除く', () => {
    const text = '- 親\n    - 子\n    1. 番号\n\n```md\n- コード\n```\n\n    - インデントコード';
    expect(listPrefixes(text).map(prefix => text.slice(prefix.from, prefix.to))).toEqual(['- ', '    - ', '    1. ']);
    expect(listPrefixes('- [ ] タスク')[0].to).toBe(2);
  });
  it('Home・左右・マウスなどの単一キャレットを本文先頭へ寄せる', () => {
    const original = state('- 親\n    - 子');
    for (const anchor of [0, 1, 4, 5, 6, 7, 8, 9]) {
      const updated = original.update({ selection: { anchor } }).state;
      expect(updated.selection.main.head).toBe(anchor < 3 ? 2 : 10);
      expect(updated.doc.toString()).toBe(original.doc.toString());
    }
  });
  it('上下移動の目標列と選択方向を保持し、全選択では記号も含められる', () => {
    const original = state('- 親\n    - 子');
    const moved = original.update({ selection: EditorSelection.create([EditorSelection.cursor(5, -1, undefined, 46)]) }).state;
    expect(moved.selection.main.head).toBe(10); expect(moved.selection.main.goalColumn).toBe(46);
    const all = original.update({ selection: { anchor: 0, head: original.doc.length } }).state;
    expect(all.selection.main.from).toBe(0); expect(all.selection.main.to).toBe(original.doc.length);
  });
  it('文字入力でリストができた直後とUndo相当の変更でも位置を照合する', () => {
    const original = state('本文');
    const changed = original.update({ changes: { from: 0, insert: '- ' }, selection: { anchor: 0 } }).state;
    expect(changed.selection.main.head).toBe(2);
    const plain = changed.update({ changes: { from: 0, to: 2, insert: '' }, selection: { anchor: 0 } }).state;
    expect(plain.selection.main.head).toBe(0); expect(plain.doc.toString()).toBe('本文');
  });
  it('前月の未完了コードに影響されず、今月のリストを判定する', () => {
    const files = [fromDisk({ path: 'テーマ/記録/2026-10.md', content: '```md\n- コード', revision: 'a' }), fromDisk({ path: 'テーマ/記録/2026-11.md', content: '- 今月', revision: 'b' })];
    const { text, segments } = compose(files);
    const original = EditorState.create({ doc: text, extensions: [sourceFilesField.init(() => files), listPrefixField, listCaretGuard] });
    expect(original.field(listPrefixField)).toEqual([{ from: segments[1].from, to: segments[1].from + 2 }]);
  });
});
