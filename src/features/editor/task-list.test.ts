import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { compose, fromDisk } from '../../domain/documents';
import { sourceFilesField } from './source-model';
import { markdownTaskToggle, taskMarker } from './task-list';

function editor(content: string, all = false) {
  const file = fromDisk({ path: 'メモ/記録.md', content, revision: 'r' });
  let state = EditorState.create({ doc: content, selection: EditorSelection.single(all ? 0 : content.length, content.length), extensions: [sourceFilesField.init(() => [file])] });
  return { run() { markdownTaskToggle({ state, dispatch: tr => { state = tr.state; } }); }, text: () => state.doc.toString(), state: () => state };
}
describe('タスクの作成と切り替え', () => {
  it('通常行を未完了に変え、以後は完了・未完了を切り替える', () => {
    const edit = editor('確認する'); edit.run(); expect(edit.text()).toBe('- [ ] 確認する');
    expect(edit.state().selection.main.head).toBe(edit.text().length);
    edit.run(); expect(edit.text()).toBe('- [x] 確認する');
    edit.run(); expect(edit.text()).toBe('- [ ] 確認する');
  });
  it('空行・箇条書き・番号・引用・子項目でも既存の階層と記号を保持する', () => {
    for (const [text, expected] of [['', '- [ ] '], ['- 項目', '- [ ] 項目'], ['1. 項目', '1. [ ] 項目'], ['> 本文', '> - [ ] 本文'], ['- 親\n    - 子', '- 親\n    - [ ] 子']]) {
      const edit = editor(text); edit.run(); expect(edit.text()).toBe(expected);
    }
  });
  it('複数選択はまとめて作成し、混在した完了状態は全て完了→全て未完了に揃える', () => {
    const edit = editor('一\n- 二\n- [x] 三', true); edit.run();
    expect(edit.text()).toBe('- [ ] 一\n- [ ] 二\n- [x] 三');
    edit.run(); expect(edit.text()).toBe('- [x] 一\n- [x] 二\n- [x] 三');
    edit.run(); expect(edit.text()).toBe('- [ ] 一\n- [ ] 二\n- [ ] 三');
  });
  it('見出し・YAML・コード・HTMLは書き換えない', () => {
    const text = '---\nname: 値\n---\n# 題名\n```md\n- [ ] コード\n```\n\n    - [ ] インデントコード\n\n<div>\n- 本文\n</div>';
    const edit = editor(text, true); edit.run(); expect(edit.text()).toBe(text);
  });
  it('選択末尾が次行の先頭なら次行は変えない', () => {
    const file = fromDisk({ path: 'メモ/記録.md', content: '一\n二', revision: 'r' });
    let state = EditorState.create({ doc: file.content, selection: { anchor: 0, head: 2 }, extensions: [sourceFilesField.init(() => [file])] });
    markdownTaskToggle({ state, dispatch: tr => { state = tr.state; } });
    expect(state.doc.toString()).toBe('- [ ] 一\n二');
  });
  it('月をまたぐ選択でも仮想区切りを変えず、各月へ保存する', () => {
    const files = ['- 一', '- 二'].map((content, i) => fromDisk({ path: `テーマ/記録/2026-${10 + i}.md`, content, revision: 'r' }));
    const { text } = compose(files);
    let state = EditorState.create({ doc: text, selection: { anchor: 0, head: text.length }, extensions: [sourceFilesField.init(() => files)] });
    markdownTaskToggle({ state, dispatch: tr => { state = tr.state; } });
    expect(state.field(sourceFilesField).map(file => file.content)).toEqual(['- [ ] 一', '- [ ] 二']);
    expect(state.doc.toString()).toBe('- [ ] 一\n\n- [ ] 二');
  });
  it('大文字Xと空項目はタスクとして扱い、コード風文字や行の中の記号は誤認しない', () => {
    for (const text of ['- [ ] ', '- [X] 完了', '1. [x] 完了', '- [ ]']) expect(taskMarker(text, text.indexOf(' ') )).not.toBeNull();
    for (const text of ['- [a] text', '- [ ]text', '- 本文 [ ]']) expect(taskMarker(text, 1)).toBeNull();
    const edit = editor('- [X] 完了'); edit.run(); expect(edit.text()).toBe('- [ ] 完了');
  });
});
