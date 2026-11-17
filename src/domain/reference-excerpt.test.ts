import { describe, expect, it } from 'vitest';
import { excerptText } from './reference-excerpt';
import { referenceContext } from './note-links';

describe('参照元の読みやすい抜粋', () => {
  it('長いリンク先を表示名へ変え、Wiki別名とコード内の文字列を保つ', () => {
    expect(excerptText('## **比較** [試験表](https://example.com/long?token=abc) と [[メモ/結果|結論]]')).toBe('比較 試験表 と 結論');
    expect(excerptText('`[コード](https://example.com)`')).toBe('[コード](https://example.com)');
  });
  it('先頭の空行を取り除いた場合も該当行の位置を保つ', () => {
    expect(referenceContext('\n参照した行\n次の行', 2)).toEqual({ context: '参照した行\n次の行', contextLine: 0 });
    expect(referenceContext('前の行\n参照した行\n次の行', 2)).toEqual({ context: '前の行\n参照した行\n次の行', contextLine: 1 });
  });
});
