import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { compose, fromDisk } from '../../domain/documents';
import { sourceFilesField } from './source-model';
import { formatLines, insertMarkdownLink, toggleCodeBlock, toggleInline } from './formatting';

function editor(marked: string) {
  const first = marked.indexOf('|'), last = marked.lastIndexOf('|'), content = marked.replaceAll('|', '');
  const file = fromDisk({ path: 'メモ/書式.md', content, revision: 'r' });
  let state = EditorState.create({ doc: content, selection: EditorSelection.single(first, last === first ? first : last - 1), extensions: [sourceFilesField.init(() => [file])] });
  return { run(command: StateCommand) { command({ state, dispatch: tr => { state = tr.state; } }); }, text: () => state.doc.toString(), state: () => state };
}
describe('Markdownの書式操作', () => {
  it('コードブロックを作成・解除し、内側のフェンスより長い記号を選ぶ', () => {
    const edit = editor('|const n = 1;|'); edit.run(toggleCodeBlock); expect(edit.text()).toBe('```\nconst n = 1;\n```');
    edit.run(toggleCodeBlock); expect(edit.text()).toBe('const n = 1;');
    const blank = editor('|'); blank.run(toggleCodeBlock); expect(blank.text()).toBe('```\n\n```'); expect(blank.state().selection.main.head).toBe(4);
    const nested = editor('|本文\n```ts\nconst n = 1;\n```\n本文|'); nested.run(toggleCodeBlock);
    expect(nested.text()).toBe('````\n本文\n```ts\nconst n = 1;\n```\n本文\n````');
  });
  it('太字・斜体・取り消し線は選択を囲み、同じ操作で解除する', () => {
    for (const [style, marker] of [['bold', '**'], ['italic', '*'], ['strike', '~~']] as const) {
      const edit = editor('前 |対象| 後'); edit.run(toggleInline(style)); expect(edit.text()).toBe(`前 ${marker}対象${marker} 後`);
      edit.run(toggleInline(style)); expect(edit.text()).toBe('前 対象 後');
    }
  });
  it('空の位置に記法を作り、内側にキャレットを置き、再度押すと空の記法を除く', () => {
    for (const [style, marker] of [['bold', '**'], ['italic', '*'], ['strike', '~~'], ['code', '`']] as const) {
      const edit = editor('前|後'); edit.run(toggleInline(style)); expect(edit.text()).toBe(`前${marker}${marker}後`);
      expect(edit.state().selection.main.head).toBe(1 + marker.length);
      edit.run(toggleInline(style)); expect(edit.text()).toBe('前後');
    }
  });
  it('既存のアンダースコアや入れ子の装飾も構文に基づいて解除する', () => {
    const bold = editor('__重|要__'); bold.run(toggleInline('bold')); expect(bold.text()).toBe('重要');
    const nested = editor('***|重要|***'); nested.run(toggleInline('bold')); expect(nested.text()).toBe('*重要*');
  });
  it('コード内のバッククォートと空白を壊さず囲み、解除する', () => {
    for (const text of ['token', 'a `token` b', ' both ', '```']) {
      const edit = editor(`前 |${text}| 後`); edit.run(toggleInline('code'));
      expect(edit.text()).toContain(text); edit.run(toggleInline('code')); expect(edit.text()).toBe(`前 ${text} 後`);
    }
  });
  it('行をまたぐ選択では構造記号を除き、本文を行ごとに装飾する', () => {
    const edit = editor('|# 見出し\n- 項目\n- [ ] タスク|'); edit.run(toggleInline('bold'));
    expect(edit.text()).toBe('# **見出し**\n- **項目**\n- [ ] **タスク**');
    edit.run(toggleInline('bold')); expect(edit.text()).toBe('# 見出し\n- 項目\n- [ ] タスク');
  });
  it('コード・YAML・HTML・リンク先を装飾しない', () => {
    for (const text of ['```md\n|本文|\n```', '---\nname: |値|\n---', '<script>|text|</script>', '`|token|`', '[本文](https://example.com/|a|)']) {
      const edit = editor(text); edit.run(toggleInline('bold')); expect(edit.text()).toBe(text.replaceAll('|', ''));
    }
  });
  it('リンクを挿入してURLを選択し、既存リンクでは参照先の編集へ戻る', () => {
    const edit = editor('|仕様書|'); edit.run(insertMarkdownLink); expect(edit.text()).toBe('[仕様書](https://)');
    expect(edit.state().sliceDoc(edit.state().selection.main.from, edit.state().selection.main.to)).toBe('https://');
    const existing = editor('[仕|様書](https://example.com)'); existing.run(insertMarkdownLink); expect(existing.text()).toBe('[仕様書](https://example.com)');
    expect(existing.state().sliceDoc(existing.state().selection.main.from, existing.state().selection.main.to)).toBe('https://example.com');
  });
  it('見出しレベルを変更・解除し、Setextの下線を残さない', () => {
    const edit = editor('本文|'); edit.run(formatLines(2)); expect(edit.text()).toBe('## 本文');
    edit.run(formatLines(3)); expect(edit.text()).toBe('### 本文'); edit.run(formatLines(0)); expect(edit.text()).toBe('本文');
    const setext = editor('|題名|\n====\n\n本文'); setext.run(formatLines(2)); expect(setext.text()).toBe('## 題名\n\n本文');
  });
  it('引用とリストの追加・解除・切り替えを行い、子の階層を保持する', () => {
    const edit = editor('|一\n二|'); edit.run(formatLines('bullet')); expect(edit.text()).toBe('- 一\n- 二');
    edit.run(formatLines('ordered')); expect(edit.text()).toBe('1. 一\n2. 二');
    edit.run(formatLines('quote')); expect(edit.text()).toBe('> 1. 一\n> 2. 二');
    edit.run(formatLines('quote')); expect(edit.text()).toBe('1. 一\n2. 二');
  });
  it('リストを解除すると子孫を昇格し、タスク記号を本文に残さない', () => {
    const parent = editor('- 親|\n    - 子\n        - 孫\n- 後'); parent.run(formatLines('bullet'));
    expect(parent.text()).toBe('親\n- 子\n    - 孫\n- 後');
    const all = editor('|- [ ] 親\n    - [x] 子\n        - 孫|'); all.run(formatLines('bullet'));
    expect(all.text()).toBe('親\n子\n孫');
    const setext = editor('|題名\n====|\n\n本文'); setext.run(formatLines(3)); expect(setext.text()).toBe('### 題名\n\n本文');
  });
  it('行頭の書式を変えても本文中のキャレットを行末へ飛ばさない', () => {
    for (const style of ['bullet', 'ordered', 'quote', 2] as const) {
      const edit = editor('前|後'); edit.run(formatLines(style));
      expect(edit.text().slice(edit.state().selection.main.head)).toBe('後');
    }
  });
  it('月別ファイルに個別に装飾を適用し、仮想区切りを保存しない', () => {
    const files = ['- 先月', '- 今月'].map((content, i) => fromDisk({ path: `テーマ/評価/2026-${10 + i}.md`, content, revision: 'r' }));
    const { text } = compose(files);
    let state = EditorState.create({ doc: text, selection: { anchor: 0, head: text.length }, extensions: [sourceFilesField.init(() => files)] });
    toggleInline('bold')({ state, dispatch: tr => { state = tr.state; } });
    expect(state.field(sourceFilesField).map(file => file.content)).toEqual(['- **先月**', '- **今月**']);
    expect(state.doc.toString()).toBe('- **先月**\n\n- **今月**');
  });
});
