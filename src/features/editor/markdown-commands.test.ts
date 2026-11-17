import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { compose, fromDisk } from '../../domain/documents';
import { sourceFilesField } from './source-model';
import { markdownBackspace, markdownDelete, markdownEnter, markdownListDedent, markdownListIndent, markdownListMoveUp, markdownListMoveDown, markdownSoftBreak } from './markdown-commands';

function editor(marked: string) {
  const anchor = marked.indexOf('|'), end = marked.lastIndexOf('|');
  const text = marked.replaceAll('|', '');
  const files = [fromDisk({ path: 'メモ/記録.md', content: text, revision: 'r' })];
  let state = EditorState.create({ doc: text, selection: EditorSelection.single(anchor, end === anchor ? anchor : end - 1), extensions: [markdown(), sourceFilesField.init(() => files)] });
  return { run(command: StateCommand) { return command({ state, dispatch: transaction => { state = transaction.state; } }); }, text: () => state.doc.toString(), state: () => state };
}

describe('箇条書きの構造を保つ入力', () => {
  it('番号付きタスクは未完了で継続し、空項目で終了・親へ戻る', () => {
    const edit = editor('1. [x] 確認|'); edit.run(markdownEnter); expect(edit.text()).toBe('1. [x] 確認\n2. [ ] ');
    edit.run(markdownEnter); expect(edit.text()).toBe('1. [x] 確認\n');
    const nested = editor('1. [x] 親\n    1. [ ] |'); nested.run(markdownEnter); expect(nested.text()).toBe('1. [x] 親\n2. [ ] ');
    const split = editor('1. [ ] 前|後'); split.run(markdownEnter); expect(split.text()).toBe('1. [ ] 前\n2. [ ] 後');
  });
  it('長い月次記録の末尾でもEnterの補完を継続する', () => {
    const prefix = '# 2026-11-01\n\n' + '実験条件と結果を記録する。\n\n'.repeat(800);
    const edit = editor(prefix + '- 今回の結果|');
    edit.run(markdownEnter);
    expect(edit.text()).toBe(prefix + '- 今回の結果\n- ');
  });
  it('長文末尾でも番号・タスク・子項目・引用を繰り返し補完する', () => {
    const prefix = '記録。\n\n'.repeat(1000);
    for (const [body, continuation] of [['1. 確認', '2. '], ['- [x] 確認', '- [ ] '], ['- 親\n    - 子', '    - '], ['> - 確認', '> - ']]) {
      const edit = editor(prefix + body + '|'); edit.run(markdownEnter);
      expect(edit.text()).toBe(prefix + body + '\n' + continuation);
    }
  });
  it('Deleteで次の項目の記号・チェック欄と字下げを残さず結合する', () => {
    for (const [marked, expected] of [
      ['- 前|\n- 後', '- 前後'], ['1. 前|\n2. 後', '1. 前後'],
      ['- [ ] 前|\n- [x] 後', '- [ ] 前後'], ['> - 前|\n> - 後', '> - 前後'],
      ['- 前|\n    - 子\n        - 孫\n- 次', '- 前子\n    - 孫\n- 次'],
      ['- 前\n  継続|\n- 後', '- 前\n  継続後'],
    ]) { const edit = editor(marked); expect(edit.run(markdownDelete)).toBe(true); expect(edit.text()).toBe(expected); }
    const normal = editor('- 本文|\n```\n- コード\n```'); expect(normal.run(markdownDelete)).toBe(false);
  });
  it('項目を子孫・複数段落・コードと一緒に上下へ移し、キャレットも追従する', () => {
    const body = '- 前\n- 親\n    - 子\n        - 孫\n\n    ```ts\n    const n = 1;\n    ```\n- 後';
    const edit = editor(body.replace('親', '親|')); edit.run(markdownListMoveDown);
    expect(edit.text()).toBe('- 前\n- 後\n- 親\n    - 子\n        - 孫\n\n    ```ts\n    const n = 1;\n    ```');
    expect(edit.text().slice(0, edit.state().selection.main.head)).toBe('- 前\n- 後\n- 親');
    edit.run(markdownListMoveUp); expect(edit.text()).toBe(body);
  });
  it('兄弟の複数選択をまとめて移動し、親・日付見出しの外へ出さない', () => {
    const edit = editor('# 日付\n- 一\n|- 二\n- 三\n|- 四'); edit.run(markdownListMoveDown);
    expect(edit.text()).toBe('# 日付\n- 一\n- 四\n- 二\n- 三');
    expect(edit.state().sliceDoc(edit.state().selection.main.from, edit.state().selection.main.to)).toBe('- 二\n- 三');
    const child = editor('- 親\n    - 子|\n- 次'); child.run(markdownListMoveDown); child.run(markdownListMoveUp);
    expect(child.text()).toBe('- 親\n    - 子\n- 次');
    const first = editor('# 日付\n- 一|\n- 二'); first.run(markdownListMoveUp); expect(first.text()).toBe('# 日付\n- 一\n- 二');
  });
  it('空項目と同階層の子項目も上下移動できる', () => {
    for (const [marked, expected] of [['- 一\n- |\n- 三', '- 一\n- 三\n- '], ['- 親\n    - 一|\n    - 二\n- 次', '- 親\n    - 二\n    - 一\n- 次']]) {
      const edit = editor(marked); edit.run(markdownListMoveDown); expect(edit.text()).toBe(expected);
    }
  });
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
  it('長い翌月の改行はその月へ保存し、移動やDeleteで月境界を越えない', () => {
    const files = [fromDisk({ path: 'テーマ/評価/2026-10.md', content: '- 先月', revision: 'a' }), fromDisk({ path: 'テーマ/評価/2026-11.md', content: '# 記録\n\n' + '結果\n\n'.repeat(1000) + '- 今月', revision: 'b' })];
    const { text, segments } = compose(files);
    let state = EditorState.create({ doc: text, selection: { anchor: segments[1].to }, extensions: [sourceFilesField.init(() => files)] });
    const run = (command: StateCommand) => command({ state, dispatch: tr => { state = tr.state; } });
    run(markdownListMoveDown); expect(state.doc.toString()).toBe(text);
    run(markdownEnter); expect(state.field(sourceFilesField)[1].content).toBe(files[1].content + '\n- ');
    state = state.update({ selection: { anchor: segments[0].to } }).state;
    const before = state.doc.toString(); run(markdownDelete); run(markdownListMoveDown);
    expect(state.doc.toString()).toBe(before); expect(state.field(sourceFilesField)[0].content).toBe(files[0].content);
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
