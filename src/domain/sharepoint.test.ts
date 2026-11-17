import { describe, expect, it } from 'vitest';
import { sharePointOfficeType } from './sharepoint';
import { location, materialDraft, materialLink, writeMaterial } from './materials';

describe('SharePointのOffice起動判定', () => {
  it('コピーした共有URLの形式とファイル拡張子から種類を判定する', () => {
    for (const [part, kind] of [[':x:/s/Dev/token', 'excel'], [':w:/s/Dev/token', 'word'], [':p:/s/Dev/token', 'powerpoint'], ['sites/Dev/結果.xlsx', 'excel'], ['sites/Dev/仕様.docm', 'word'], ['sites/Dev/報告.ppsx', 'powerpoint']] as const) {
      const url = `https://team.sharepoint.com/${part}?e=a%2Bb&d=1#view`;
      expect(sharePointOfficeType(url)).toBe(kind); expect(location(url).type).toBe(kind);
    }
  });
  it('不透明な共有URLは登録済みの種類を使用し、明らかな別形式は対象外にする', () => {
    expect(sharePointOfficeType('https://team.sharepoint.com/:u:/s/Dev/token', 'word')).toBe('word');
    for (const path of [':b:/s/Dev/token', ':f:/s/Dev/token', 'sites/Dev/report.pdf', '_layouts/15/Doc.aspx?file=test.xlsx', 'sites/Dev/AllItems.aspx']) expect(sharePointOfficeType('https://team.sharepoint.com/' + path, 'excel')).toBeNull();
    expect(sharePointOfficeType('https://team.sharepoint.com/opaque', 'file')).toBeNull();
  });
  it('通常Web・似せたホスト・独自スキームはOffice対象にしない', () => {
    for (const url of ['https://example.com/a.xlsx', 'http://team.sharepoint.com/a.xlsx', 'https://evilsharepoint.com/a.xlsx', 'https://team.sharepoint.com.evil.test/a.xlsx', 'https://user:pass@team.sharepoint.com/a.xlsx', 'https://team.sharepoint.com:8443/a.xlsx', 'ms-excel:ofe|u|https://team.sharepoint.com/a.xlsx']) expect(sharePointOfficeType(url, 'excel')).toBeNull();
  });
  it('元の共有URLをMarkdownとプロパティへ保持し、起動スキームを保存しない', () => {
    const url = 'https://team.sharepoint.com/:x:/s/Dev/ABC?e=a%2Bb&d=123#view';
    const draft = materialDraft(url); expect(draft.path).toBe(url); expect(draft.type).toBe('excel');
    expect(materialLink('資料', url)).toBe(`[資料](${url})`); expect(writeMaterial(draft)).toContain(url);
    expect(writeMaterial(draft)).not.toContain('ms-excel:');
  });
});
