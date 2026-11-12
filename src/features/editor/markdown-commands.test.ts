import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { compose, fromDisk } from '../../domain/documents';
import { sourceFilesField } from './source-model';
import { markdownBackspace, markdownEnter, markdownListDedent, markdownListIndent, markdownSoftBreak } from './markdown-commands';

function editor(marked: string) {
  const anchor = marked.indexOf('|'), end = marked.lastIndexOf('|');
  const text = marked.replaceAll('|', '');
  const files = [fromDisk({ path: 'メモ/記録.md', content: text, revision: 'r' })];
  let state = EditorState.create({ doc: text, selection: EditorSelection.single(anchor, end === anchor ? anchor : end - 1), extensions: [markdown(), sourceFilesField.init(() => files)] });
  return { run(command: StateCommand) { return command({ state, dispatch: transaction => { state = transaction.state; } }); }, text: () => state.doc.toString(), state: () => state };
}

describe('箇条書きの構造を保つ入力', () => {
  it('親のない先頭項目と、親を飛ばす繰り返しの字下げを止める', () => {
    const first = editor('|- 親\n- 子'); expect(first.run(markdownListIndent)).toBe(true); expect(first.text()).toBe('- 親\n- 子');
    const second = editor('- 親\n- 子|'); second.run(markdownListIndent);
    expect(second.text()).toBe('- 親\n    - 子');
    second.run(markdownListIndent); second.run(markdownListIndent);
    expect(second.text()).toBe('- 親\n    - 子');
  });
  it('親と子孫・継続本文をひとまとまりで移動し、1段ずつ戻す', () => {
    const text = '- 前\n- 親\n    - 子\n        - 孫\n\n    継続する説明\n- 次';
    const edit = editor(text.replace('- 親', '- 親|'));
    edit.run(markdownListIndent);
    expect(edit.text()).toBe('- 前\n    - 親\n        - 子\n            - 孫\n    \n        継続する説明\n- 次');
    edit.run(markdownListDedent); expect(edit.text()).toBe(text);
    edit.run(markdownListDedent); expect(edit.text()).toBe(text);
  });
  it('選択した兄弟項目をまとめて字下げし、選択末尾の次の行は含めない', () => {
    const edit = editor('- 前\n|- 二\n- 三\n|- 四');
    edit.run(markdownListIndent); expect(edit.text()).toBe('- 前\n    - 二\n    - 三\n- 四');
    edit.run(markdownListDedent); expect(edit.text()).toBe('- 前\n- 二\n- 三\n- 四');
  });
  it('有効な親があれば複数階層を扱い、外部で作った2空白の階層も戻せる', () => {
    const edit = editor('- 親\n    - 一\n    - 二|'); edit.run(markdownListIndent);
    expect(edit.text()).toBe('- 親\n    - 一\n        - 二'); edit.run(markdownListDedent);
    expect(edit.text()).toBe('- 親\n    - 一\n    - 二');
    const compact = editor('- 親\n  - 子|'); compact.run(markdownListDedent); expect(compact.text()).toBe('- 親\n- 子');
  });
  it('番号付き・タスク・引用内のリストも構造を維持する', () => {
    for (const [text, nested] of [
      ['1. 親\n2. 子|', '1. 親\n    2. 子'],
      ['- [ ] 親\n- [x] 子|', '- [ ] 親\n    - [x] 子'],
      ['> - 親\n> - 子|', '> - 親\n>     - 子'],
    ]) { const edit = editor(text); edit.run(markdownListIndent); expect(edit.text()).toBe(nested); edit.run(markdownListDedent); expect(edit.text()).toBe(text.replace('|', '')); }
  });
  it('コード内や通常本文にはリストの制限をかけない', () => {
    for (const text of ['```md\n- コード|\n```', '通常の本文|']) { const edit = editor(text); expect(edit.run(markdownListIndent)).toBe(false); expect(edit.text()).toBe(text.replace('|', '')); }
  });
  it('Enterで項目を続け、空の子項目からは1段戻ってリストを終了する', () => {
    const edit = editor('- 親\n    - 子|'); edit.run(markdownEnter); expect(edit.text()).toBe('- 親\n    - 子\n    - ');
    edit.run(markdownEnter); expect(edit.text()).toBe('- 親\n    - 子\n- ');
    edit.run(markdownEnter); expect(edit.text()).toBe('- 親\n    - 子\n');
    const backspace = editor('- 親\n    - |'); backspace.run(markdownBackspace); expect(backspace.text()).toContain('- 親\n');
  });
  it('前の月を、次の月の先頭項目の親にしない', () => {
    const files = [fromDisk({ path: 'テーマ/評価/2026-10.md', content: '- 先月', revision: 'a' }), fromDisk({ path: 'テーマ/評価/2026-11.md', content: '- 今月', revision: 'b' })];
    const { text, segments } = compose(files);
    const state = EditorState.create({ doc: text, selection: { anchor: segments[1].to }, extensions: [sourceFilesField.init(() => files)] });
    let changed = false; expect(markdownListIndent({ state, dispatch: () => { changed = true; } })).toBe(true); expect(changed).toBe(false);
  });
  it('Shift+Enterは同じ項目の継続文を作り、次のEnterで項目を続ける', () => {
    const edit = editor('- 親\n    - 項目|'); edit.run(markdownSoftBreak);
    expect(edit.text()).toBe('- 親\n    - 項目\n      ');
    const task = editor('- [ ] 確認|'); task.run(markdownSoftBreak); expect(task.text()).toBe('- [ ] 確認\n      ');
    const quote = editor('> - 項目|'); quote.run(markdownSoftBreak); expect(quote.text()).toBe('> - 項目\n>   ');
  });
  it('子項目の本文先頭でBackspaceすると子孫ごと1段戻す', () => {
    const edit = editor('- 親\n    - |子\n        - 孫'); edit.run(markdownBackspace);
    expect(edit.text()).toBe('- 親\n- 子\n    - 孫');
  });
  it('選択項目に含まれるコードと空行は一緒に移し、コードだけの選択は通常編集に任せる', () => {
    const edit = editor('- 前\n|- 項目\n\n    ```ts\n    const n = 1;\n    ```|\n- 次');
    edit.run(markdownListIndent);
    expect(edit.text()).toBe('- 前\n    - 項目\n    \n        ```ts\n        const n = 1;\n        ```\n- 次');
    const code = editor('- 項目\n\n    ```ts\n    |const n = 1;|\n    ```');
    expect(code.run(markdownListIndent)).toBe(false);
  });
});
