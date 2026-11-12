import { describe, expect, it } from 'vitest';
import { compose, fromDisk } from './documents';
import { outlineHeadings } from './outline';
const file = (path: string, content: string) => fromDisk({ path, content, revision: path });
describe('本文の目次', () => {
  it('日付以外のH1からH6とSetext見出しを本文順・階層付きで拾う', () => {
    const files = [file('メモ/記録.md', '# 目的\n\n## 条件\n### 方法\n#### 結果\n##### 考察\n###### 補足\n\nまとめ\n======\n\n詳細\n------\n')];
    expect(outlineHeadings(files).map(({ title, level }) => ({ title, level }))).toEqual([{ title: '目的', level: 1 }, { title: '条件', level: 2 }, { title: '方法', level: 3 }, { title: '結果', level: 4 }, { title: '考察', level: 5 }, { title: '補足', level: 6 }, { title: 'まとめ', level: 1 }, { title: '詳細', level: 2 }]);
  });
  it('装飾記法やリンク先を除いた見出し名を表示する', () => {
    const headings = outlineHeadings([file('メモ/手順.md', '## **重要**な `code` と [資料](https://example.com) &amp; 確認 ##\n')]);
    expect(headings[0].title).toBe('重要な code と 資料 & 確認');
  });
  it('YAML・コード・引用やリスト内の見出しを拾わず、本文を維持する', () => {
    const content = '---\ntitle: metadata\n---\n# 本文\n\n```md\n## コード\n```\n\n> ## 引用\n\n- ## 項目\n\n    # インデントコード\n';
    const source = file('資料/ページ.md', content);
    expect(outlineHeadings([source]).map(heading => heading.title)).toEqual(['本文']); expect(source.content).toBe(content);
  });
  it('月ごとに構文を解析して、合成した本文の正しい位置へ移動できる', () => {
    const files = [file('テーマ/評価/2026-10.md', '# 2026-10-31\n## 前月\n```md\n'), file('テーマ/評価/2026-11.md', '# 2026-11-13\n## 今月の結論\n')];
    const headings = outlineHeadings(files), { text, segments } = compose(files);
    expect(headings.map(heading => heading.title)).toEqual(['2026-10-31', '前月', '2026-11-13', '今月の結論']);
    expect(headings[2].from).toBe(segments[1].from); expect(text.slice(headings[3].from)).toMatch(/^## 今月の結論/);
  });
});
