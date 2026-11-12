import { describe, expect, it } from 'vitest';
import { fromDisk, type VaultSnapshot } from './documents';
import { makeIndex } from './note-links';
import { canOpenMaterial, location, materialCatalog, materialDraft, materialLink, materialReferences, newMaterialPath, readMaterial, rewriteMaterialLinks, writeMaterial } from './materials';

const file = (path: string, content: string) => fromDisk({ path, content, revision: path });
const vault: VaultSnapshot = { root: 'C:/Vault', name: '試験', themes: [{ path: 'テーマ/評価', name: '評価', files: [{ path: 'テーマ/評価/2026-11.md', name: '2026-11.md' }] }], notes: [], materials: [] };
const props = () => ({ ...materialDraft('C:\\試験\\測定 #1 (確定)%.xlsx'), added: '2026-11-12' });

describe('資料のパスとMarkdown', () => {
  it('引用符付きパスとfile URIを同じ資料として照合し、記号を往復する', () => {
    const target = location('"C:\\試験\\測定 #1 (確定)%.xlsx"');
    expect(target.path).toBe('C:\\試験\\測定 #1 (確定)%.xlsx');
    expect(target.href).toContain('%23'); expect(target.href).toContain('%25'); expect(target.href).toContain('%28');
    expect(location(target.href).key).toBe(target.key);
    expect(location('c:/試験/測定 #1 (確定)%.xlsx').key).toBe(target.key);
    expect(materialLink('[結果]', target.path)).toContain('[\\[結果\\]](file:///C:/');
  });
  it('UNCとドライブのルート、相対要素を扱う', () => {
    const target = location('\\\\server\\開発\\結果.pdf');
    expect(target.href).toBe('file://server/%E9%96%8B%E7%99%BA/%E7%B5%90%E6%9E%9C.pdf');
    expect(location(target.href).key).toBe(target.key);
    expect(location('C:\\').href).toBe('file:///C:/');
    expect(location('C:\\試験\\前\\..\\結果.pdf').key).toBe(location('C:\\試験\\結果.pdf').key);
  });
  it('SharePointのクエリ・フラグメントを維持し、異なるURLを自動統合しない', () => {
    const url = 'https://team.sharepoint.com/:x:/s/Dev/ABC?e=a%2Bb&d=123#view';
    expect(location(url).path).toBe(url); expect(location(url).href).toBe(url);
    expect(location(url).key).not.toBe(location(url.replace('a%2Bb', 'different')).key);
    expect(materialDraft(url, '評価', '測定結果.xlsx')).toMatchObject({ title: '測定結果.xlsx', type: 'excel', themes: ['評価'] });
  });
  it('相対パス・制御文字・不正なURLを拒否し、実行形式を資料として起動しない', () => {
    for (const input of ['../outside.pdf', 'C:relative.pdf', 'javascript:alert(1)', 'file:///C:/a.pdf#bad', 'C:\\a\n.pdf', 'https://user:pass@example.com/a', '\\\\?\\C:\\device']) expect(() => location(input)).toThrow();
    expect(() => canOpenMaterial('C:\\script.cmd')).toThrow();
    expect(canOpenMaterial('C:\\report.pdf').type).toBe('pdf');
  });
});
describe('資料ページ', () => {
  it('6プロパティと通常リンクを保存し、任意のメモ・テーマを空で扱う', () => {
    const content = writeMaterial(props());
    const item = readMaterial(file('資料/結果.xlsx.md', content));
    expect(item).toMatchObject({ title: '測定 #1 (確定)%.xlsx', type: 'excel', added: '2026-11-12', memo: '', themes: [] });
    expect(content).toContain("added: '2026-11-12'"); expect(item.body).toContain('[元の資料を開く](file:');
    expect(content).not.toMatch(/\bid:/);
  });
  it('未知のキーとコメント、メモと詳細本文、改行形式を保持する', () => {
    const original = readMaterial(file('資料/既存.md', writeMaterial({ ...props(), memo: '短い説明' }).replace('title:', '# 重要なコメント\nowner: 機械開発\ntitle:') + '\n詳しい説明。\n'));
    const changed = readMaterial(file(original.file.path, writeMaterial({ ...original, memo: '更新した短い説明' }, original)));
    expect(changed.body).toBe(original.body); expect(changed.memo).toBe('更新した短い説明');
    expect(changed.file.content).toContain('# 重要なコメント'); expect(changed.file.content).toContain('owner: 機械開発');
  });
  it('壊れたYAML・不正な型・不正な日付を黙って補完しない', () => {
    for (const content of ['本文のみ', '---\ntitle: [broken\n---\n', writeMaterial(props()).replace("added: '2026-11-12'", 'added: 42'), writeMaterial(props()).replace('themes: []', 'themes: 評価')]) expect(() => readMaterial(file('資料/壊れた.md', content))).toThrow();
    expect(() => writeMaterial({ ...props(), added: '2026-02-30' })).toThrow();
    const index = makeIndex({ ...vault, materials: [{ path: '資料/不正.md', name: '不正.md' }] }, [{ path: '資料/不正.md', content: '壊れたページ', revision: '1' }]);
    expect(materialCatalog(index).errors).toHaveLength(1);
  });
  it('資料名をWindowsで保存できる名前にし、既存ページを上書きしない', () => {
    expect(newMaterialPath('結果.xlsx', ['資料/結果.xlsx.md'])).toBe('資料/結果.xlsx (2).md');
    expect(newMaterialPath('CON.xlsx', [])).toBe('資料/_CON.xlsx.md');
    expect(newMaterialPath('条件 A/B: C', [])).toBe('資料/条件 A_B_ C.md');
  });
});
describe('参照とパス修正', () => {
  it('通常・参照形式のリンクだけを書き換え、ラベル・コード・本文・画像・YAMLを保持する', () => {
    const old = 'https://example.com/old?d=123', next = 'https://example.com/new?d=456';
    const text = `---\nmemo: '[YAML](${old})'\n---\n# 2026-11-12\n\n[別の表示名](${old}) と [参照][doc]\n\n[doc]: <${old}> "タイトル"\n\n本文 ${old}\n\n\`[code](${old})\`\n\n\`\`\`md\n[例](${old})\n\`\`\`\n\n![画像](${old})\n`;
    const index = makeIndex(vault, [{ path: 'テーマ/評価/2026-11.md', content: text, revision: 'r1' }]);
    const writes = rewriteMaterialLinks(index, [old], next);
    expect(writes).toHaveLength(1); expect(writes[0].content).toContain(`[別の表示名](${next})`); expect(writes[0].content).toContain(`[doc]: <${next}> "タイトル"`);
    expect(writes[0].content).toContain(`memo: '[YAML](${old})'`); expect(writes[0].content).toContain(`本文 ${old}`); expect(writes[0].content).toContain(`![画像](${old})`); expect(writes[0].content).toContain(`\`[code](${old})\``); expect(writes[0].content).toContain(`[例](${old})`);
  });
  it('日付・行・周辺文を含む参照元を集め、資料ページ自身を除外する', () => {
    const item = readMaterial(file('資料/結果.md', writeMaterial(props())));
    const content = `# 2026-11-12\n\n条件を変更。\n${materialLink('測定結果', item.path)}\n結論を確認。\n`;
    const index = makeIndex({ ...vault, materials: [{ path: item.file.path, name: '結果.md' }] }, [{ path: 'テーマ/評価/2026-11.md', content, revision: 'r' }, { path: item.file.path, content: item.file.content, revision: 'm' }]);
    const hits = materialReferences(index, item);
    expect(hits).toHaveLength(1); expect(hits[0]).toMatchObject({ date: '2026-11-12', line: 4, source: { name: '評価' } }); expect(hits[0].context).toContain('条件を変更。'); expect(hits[0].context).toContain('結論を確認。');
  });
});
