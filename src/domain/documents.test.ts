import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { applyChanges, compose, dateHeadings, ensureToday, fromDisk, projectChanges, serializeFile, type OpenDocument } from './documents';

const file = (month: string, content: string) => fromDisk({ path: `テーマ/試験/${month}.md`, content, revision: month });
const theme = (...files: ReturnType<typeof file>[]): OpenDocument => ({ id: 'テーマ/試験', label: '試験', kind: 'theme', files });

describe('月別ファイルと連続した編集本文', () => {
  it('跨月の置換でも区切りを保存せず、前後の月を正しく編集する', () => {
    const files = [file('2026-10', '先月の記録'), file('2026-11', '今月の記録')];
    const doc = compose(files);
    const change = { from: 2, to: doc.segments[1].from + 2, insert: '検討を継続' };
    const normalized = projectChanges(files, [change]);
    const editorResult = ChangeSet.of(normalized, doc.text.length).apply(Text.of(doc.text.split('\n')));
    expect(editorResult.toString()).toBe(compose(applyChanges(files, [change])).text);
    expect(applyChanges(files, [change]).map(f => f.content)).toEqual(['先月検討を継続', 'の記録']);
  });

  it('保存する各月には表示用の改行を混ぜない', () => {
    const files = [file('2026-10', 'abc'), file('2026-11', 'def')];
    const updated = applyChanges(files, [{ from: 1, to: 7, insert: 'X' }]);
    expect(updated.map(f => f.content)).toEqual(['aX', 'f']);
    expect(compose(updated).text).toBe('aX\n\nf');
    expect(updated[0].revision).toBe('2026-10');
    expect(updated[0].savedContent).toBe('abc');
  });

  it('区切りだけの削除でファイルを結合しない', () => {
    const files = [file('2026-10', 'abc'), file('2026-11', 'def')];
    expect(applyChanges(files, [{ from: 3, to: 5, insert: '' }])).toEqual(files);
  });

  it('一度の操作で複数箇所を編集してもオフセットがずれない', () => {
    const files = [file('2026-10', 'abc'), file('2026-11', 'def')];
    const updated = applyChanges(files, [{ from: 1, to: 2, insert: '長い記録' }, { from: 6, to: 7, insert: 'Z' }]);
    expect(updated.map(f => f.content)).toEqual(['a長い記録c', 'dZf']);
  });

  it('空の月や絵文字を含む月でも挿入先を維持する', () => {
    const files = [file('2026-10', ''), file('2026-11', '🛠️ 試験')];
    const start = compose(files).segments[1].from;
    const updated = applyChanges(files, [{ from: start, to: start, insert: '再試験：' }]);
    expect(updated.map(f => f.content)).toEqual(['', '再試験：🛠️ 試験']);
  });
});

describe('今日へ移動', () => {
  it('月と見出しを一度だけ生成し、繰り返しで重複しない', () => {
    const first = ensureToday(theme(file('2026-10', '# 2026-10-31\n試験完了')), '2026-11-12');
    const second = ensureToday(first.document, '2026-11-12');
    expect(first.document.files[0].content).toBe('# 2026-10-31\n試験完了');
    expect(first.document.files[1].path).toBe('テーマ/試験/2026-11.md');
    expect(first.document.files[1].content).toBe('# 2026-11-12\n\n');
    expect(second.document.files).toEqual(first.document.files);
  });

  it('未来の日付があっても時系列の位置へ追加する', () => {
    const result = ensureToday(theme(file('2026-11', '# 2026-11-01\n記録\n\n# 2026-11-30\n予定')), '2026-11-12');
    expect(result.document.files[0].content).toBe('# 2026-11-01\n記録\n\n# 2026-11-12\n\n# 2026-11-30\n予定');
  });

  it('コードブロックや見出し2内の日付を今日の記録と誤認しない', () => {
    const content = '```md\n# 2026-11-12\n```\n\n## 2026-11-12\n';
    expect(dateHeadings(content)).toEqual([]);
    const result = ensureToday(theme(file('2026-11', content)), '2026-11-12');
    expect(dateHeadings(result.document.files[0].content)).toHaveLength(1);
  });

  it('既存のCRLFを維持する', () => {
    const result = ensureToday(theme(file('2026-11', '# 2026-11-11\r\n記録\r\n')), '2026-11-12');
    expect(serializeFile(result.document.files[0])).toBe('# 2026-11-11\r\n記録\r\n\r\n# 2026-11-12\r\n\r\n');
  });

  it('BOMとCRLFを本文座標へ混ぜず、保存時に復元する', () => {
    const document = theme(file('2026-11', '\uFEFF# 2026-11-12\r\n\r\n記録\r\n'));
    expect(compose(document.files).text).toBe('# 2026-11-12\n\n記録\n');
    const result = ensureToday(document, '2026-11-12');
    expect(serializeFile(result.document.files[0])).toBe('\uFEFF# 2026-11-12\r\n\r\n記録\r\n');
  });
});
