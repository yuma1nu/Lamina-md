import { describe, expect, it } from 'vitest';
import { imageMarkup, imagePath, imageReferences, relativeImagePath, validateAnnotation } from './images';
import { makeIndex, movedSnapshot, rewriteLinks } from './note-links';

describe('画像の保存記法と参照', () => {
  it('日本語・空白・括弧のパスと属性を安全に往復できる', () => {
    const source = 'メモ/設計/記録.md', target = '添付/温度 (1)#&.png';
    const markup = imageMarkup(source, target, '温度 "上昇" <確認>', 480);
    const ref = imageReferences(markup)[0];
    expect(imagePath(source, ref.path)).toBe(target);
    expect(ref.alt).toBe('温度 "上昇" <確認>'); expect(ref.width).toBe(480);
    expect(imagePath(source, relativeImagePath(source, target))).toBe(target);
    expect(imagePath(source, '../../../../outside.png')).toBeNull();
    expect(imagePath(source, 'https://example.com/a.png')).toBeNull();
  });
  it('通常画像と参照形式を解析し、コード・コメント・HTMLの囲み内は扱わない', () => {
    const content = '![測定](../添付/a.png)\n\n![条件][image]\n\n[image]: <../添付/b%20c.png>\n\n`![コード](x.png)`\n\n```\n<img src="x.png">\n```\n\n<!-- <img src="x.png"> -->\n\n<script><img src="x.png"></script>\n\n<img src="../添付/d.png" width="300" onerror="unsafe()">';
    expect(imageReferences(content).map(ref => [ref.path, ref.alt, ref.width])).toEqual([['../添付/a.png', '測定', undefined], ['../添付/b%20c.png', '条件', undefined], ['../添付/d.png', '', 300]]);
  });
  it('メモの移動で画像の相対パスも更新し、サイズを保持する', () => {
    const snapshot = { root: 'vault', name: 'vault', themes: [], notes: [{ path: 'メモ/記録.md', name: '記録.md' }] };
    const before = makeIndex(snapshot, [{ path: 'メモ/記録.md', content: '<img src="../添付/1/rendered.png" alt="測定" width="320">', revision: 'r' }]);
    const moves = [{ from: 'メモ/記録.md', to: 'メモ/整理/記録.md' }];
    const after = makeIndex(movedSnapshot(snapshot, moves), []);
    const result = rewriteLinks(before, after, moves, before.files)[0];
    expect(result.content).toBe('<img src="../../添付/1/rendered.png" alt="測定" width="320">');
  });
  it('未知の注釈形式や不正な形状は上書き前に拒否する', () => {
    expect(validateAnnotation({ version: 1, width: 800, height: 600, shapes: [] }).width).toBe(800);
    expect(() => validateAnnotation({ version: 2, width: 800, height: 600, shapes: [] } as never)).toThrow();
    expect(() => validateAnnotation({ version: 1, width: 800, height: 600, shapes: [{ id: 'broken' }] } as never)).toThrow();
  });
});
