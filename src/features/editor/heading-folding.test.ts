import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { foldEffect, foldedRanges, unfoldEffect } from '@codemirror/language';
import { compose, fromDisk } from '../../domain/documents';
import { sourceFilesField } from './source-model';
import { headingFoldField, headingFolding } from './heading-folding';

function editor(contents: string[]) {
  const files = contents.map((content, i) => fromDisk({ content, revision: 'r', path: `テーマ/評価/2026-${10 + i}.md` }));
  return EditorState.create({ doc: compose(files).text, extensions: [sourceFilesField.init(() => files), headingFolding] });
}
describe('物理ファイルごとの見出し折り畳み', () => {
  it('親は子見出しを含め、同階層以上の次の見出しの直前で止まる', () => {
    const state = editor(['# 一日目\n本文\n## 条件\n子の本文\n### 補足\n詳細\n## 結果\n結果の本文\n# 二日目\n別の記録']);
    const folds = state.field(headingFoldField);
    expect(folds.map(fold => [fold.title, state.sliceDoc(fold.from, fold.to)])).toEqual([
      ['一日目', '\n本文\n## 条件\n子の本文\n### 補足\n詳細\n## 結果\n結果の本文'],
      ['条件', '\n子の本文\n### 補足\n詳細'], ['補足', '\n詳細'], ['結果', '\n結果の本文'], ['二日目', '\n別の記録'],
    ]);
  });
  it('最終見出しでも翌月を畳まず、コード・引用・空見出しを除外する', () => {
    const first = '# 先月\n本文\n```md\n## コード\n```\n> # 引用\n\n## 空';
    const state = editor([first, '# 今月\n記録']);
    expect(state.field(headingFoldField).map(fold => [fold.title, fold.to])).toEqual([['先月', first.length], ['今月', state.doc.length]]);
  });
  it('Setextは下線を残し、折り畳み自体はMarkdownを変更しない', () => {
    let state = editor(['題名\n====\n記録\n\n次の題\n----\n続き']);
    const fold = state.field(headingFoldField)[0], original = state.doc.toString();
    expect(state.sliceDoc(0, fold.from)).toBe('題名\n====');
    state = state.update({ effects: foldEffect.of(fold) }).state;
    expect(foldedRanges(state).size).toBe(1); expect(state.doc.toString()).toBe(original);
    state = state.update({ effects: unfoldEffect.of(fold) }).state;
    expect(foldedRanges(state).size).toBe(0);
  });
  it('見出しを削除・階層変更しても開閉できない本文を残さない', () => {
    let state = editor(['# 親\n記録\n## 子\n詳細\n# 次\n別の本文']);
    state = state.update({ effects: foldEffect.of(state.field(headingFoldField)[0]) }).state;
    state = state.update({ changes: { from: 0, to: 2, insert: '' } }).state;
    expect(foldedRanges(state).size).toBe(0);
    state = editor(['# 親\n記録\n## 子\n詳細\n# 次\n別の本文']);
    state = state.update({ effects: foldEffect.of(state.field(headingFoldField)[0]) }).state;
    state = state.update({ changes: { from: 0, insert: '#' } }).state;
    const fold = state.field(headingFoldField)[0];
    const actual: { from: number; to: number }[] = [];
    foldedRanges(state).between(0, state.doc.length, (from, to) => { actual.push({ from, to }); });
    expect(actual).toEqual([{ from: fold.from, to: fold.to }]);
    expect(state.sliceDoc(fold.from, fold.to)).toBe('\n記録');
  });
});
