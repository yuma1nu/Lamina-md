import { describe, expect, it } from 'vitest';
import { fromDisk, type VaultSnapshot } from './documents';
import { canonicalTarget, makeIndex, mapPath, movedSnapshot, noteReferences, referenceHits, resolveNote, rewriteLinks, searchNotes } from './note-links';

const vault = (paths: string[], themes = ['テーマ/評価']): VaultSnapshot => ({ root: 'test', name: 'test', notes: paths.map(path => ({ path, name: path.split('/').at(-1)! })), themes: themes.map(path => ({ path, name: path.split('/').at(-1)!, files: [{ path: path + '/2026-11.md', name: '2026-11.md' }] })) });
const disk = (path: string, content = '') => ({ path, content, revision: path });
describe('ノートリンクと参照元', () => {
  it('同名候補はパスで区別し、テーマ日付を正しい月次ファイルへ解決する', () => {
    const snapshot = vault(['メモ/a/仕様.md', 'メモ/b/仕様.md']);
    const index = makeIndex(snapshot, [disk('テーマ/評価/2026-11.md', '# 2026-11-12\n内容'), disk('メモ/a/仕様.md'), disk('メモ/b/仕様.md')]);
    expect(resolveNote(index, '仕様', 'メモ/test.md').ambiguous).toBe(true);
    expect(canonicalTarget(index, index.targets.find(target => target.id === 'メモ/a/仕様.md')!)).toBe('メモ/a/仕様');
    expect(resolveNote(index, '評価#2026-11-12', 'メモ/a/仕様.md')).toMatchObject({ target: { id: 'テーマ/評価' }, path: 'テーマ/評価/2026-11.md', offset: 0 });
    expect(resolveNote(index, '評価#2026-11-13', 'メモ/a/仕様.md').missingHeading).toBe(true);
  });
  it('コード・HTML・画像・エスケープを除外し、周辺文章と日付を持つバックリンクを集計する', () => {
    const content = '# 2026-11-12\n前の行\n[[仕様]] と [[仕様|別名]]\n次の行\n\n`[[仕様]]`\n\n```md\n[[仕様]]\n```\n\n\\[[仕様]]\n\n![[仕様]]\n\n<!-- [[仕様]] -->';
    const index = makeIndex(vault(['メモ/仕様.md']), [disk('メモ/仕様.md'), disk('テーマ/評価/2026-11.md', content)]);
    expect(noteReferences('テーマ/評価/2026-11.md', content)).toHaveLength(2);
    const hits = referenceHits(index, 'メモ/仕様.md');
    expect(hits).toHaveLength(2); expect(hits[0]).toMatchObject({ date: '2026-11-12', line: 3 }); expect(hits[0].context).toContain('前の行'); expect(hits[0].context).toContain('次の行');
    expect(searchNotes(index, '次の行')[0]).toMatchObject({ source: { name: '評価' }, date: '2026-11-12', line: 4 });
  });
  it('改名時に通常表示だけを変え、別名・コード・BOMとCRLFを保持する', () => {
    const path = 'テーマ/評価/2026-11.md';
    const raw = '\uFEFF# 2026-11-12\r\n[[旧名]] / [[旧名|決めた表示]]\r\n[旧名](../../メモ/旧名.md) / [独自名](../../メモ/旧名.md)\r\n`[[旧名]]`\r\n```md\r\n[[旧名]]\r\n```\r\n';
    const snapshot = vault(['メモ/旧名.md']); const files = [disk(path, raw), disk('メモ/旧名.md')]; const before = makeIndex(snapshot, files);
    const moves = [{ from: 'メモ/旧名.md', to: 'メモ/設計/新名.md' }], after = makeIndex(movedSnapshot(snapshot, moves), files.map(file => ({ ...file, path: mapPath(file.path, moves) })));
    const changed = rewriteLinks(before, after, moves, before.files).find(write => write.path === path)!;
    expect(changed.content).toContain('[[新名]] / [[新名|決めた表示]]');
    expect(changed.content).toContain('[新名](../../メモ/設計/新名.md) / [独自名](../../メモ/設計/新名.md)');
    expect(changed.content).toContain('`[[旧名]]`\r\n```md\r\n[[旧名]]');
    expect(changed.content.startsWith('\uFEFF')).toBe(true); expect(changed.content.replace(/\r\n/g, '')).not.toContain('\n');
  });
  it('参照形式のURLと既定表示を更新しても参照IDを壊さない', () => {
    const snapshot = vault(['メモ/旧名.md', 'メモ/元.md'], []);
    const files = [disk('メモ/元.md', '[旧名]\n\n[旧名]: 旧名.md\n'), disk('メモ/旧名.md')], before = makeIndex(snapshot, files);
    const moves = [{ from: 'メモ/旧名.md', to: 'メモ/新名.md' }], after = makeIndex(movedSnapshot(snapshot, moves), files.map(file => ({ ...file, path: mapPath(file.path, moves) })));
    expect(rewriteLinks(before, after, moves, before.files)[0].content).toBe('[新名][旧名]\n\n[旧名]: 新名.md\n');
  });
  it('移動した参照元の相対リンクを直し、未保存の編集も参照元に反映する', () => {
    const snapshot = vault(['メモ/元.md', 'メモ/仕様.md'], []);
    const files = [disk('メモ/元.md', '[仕様](仕様.md)'), disk('メモ/仕様.md')], before = makeIndex(snapshot, files);
    const moves = [{ from: 'メモ/元.md', to: 'メモ/整理/元.md' }], after = makeIndex(movedSnapshot(snapshot, moves), files.map(file => ({ ...file, path: mapPath(file.path, moves) })));
    expect(rewriteLinks(before, after, moves, before.files)[0].content).toBe('[仕様](../仕様.md)');
    const edited = { ...fromDisk(files[0]), content: '[[仕様]]\n[[仕様]]' };
    expect(referenceHits(makeIndex(snapshot, files, { 'メモ/元.md': { id: 'メモ/元.md', label: '元', kind: 'note', files: [edited] } }), 'メモ/仕様.md')).toHaveLength(2);
  });
  it('通常リンクの文字参照を復号し、存在しない相対パスを別ノートへ誤接続しない', () => {
    const snapshot = vault(['メモ/元.md', 'メモ/資料 条件.md', 'メモ/別/仕様.md'], []);
    const files = [disk('メモ/元.md', '[資料](資料&#32;条件.md#test-heading)'), disk('メモ/資料 条件.md', '# Test Heading\n本文'), disk('メモ/別/仕様.md')];
    const index = makeIndex(snapshot, files), ref = noteReferences(files[0].path, files[0].content)[0];
    expect(resolveNote(index, ref.target, files[0].path, 'markdown')).toMatchObject({ target: { id: 'メモ/資料 条件.md' }, missingHeading: false });
    expect(resolveNote(index, '仕様.md', 'メモ/元.md', 'markdown').target).toBeUndefined();
    expect(resolveNote(index, '仕様', 'メモ/元.md', 'wiki').target?.id).toBe('メモ/別/仕様.md');
  });
});
