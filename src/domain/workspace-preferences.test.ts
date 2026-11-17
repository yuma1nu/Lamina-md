import { describe, expect, it } from 'vitest';
import { readPreferences, workspacePreferences } from './workspace-preferences';
import { readSession } from './session';

describe('毎日の作業状態', () => {
  it('古いセッションを読み、新しい状態の値と配列を独立させる', () => {
    const a = workspacePreferences(), b = workspacePreferences(); a.materials[0].checked.push('資料/a.md');
    expect(b.materials[0].checked).toEqual([]); expect(a.materials[1].checked).toEqual([]);
    expect(readSession({ version: 1, panes: [{ tabs: [] }, { tabs: [] }] })?.preferences).toEqual(b);
  });
  it('破損した値を検証し、幅・比率を範囲に収める', () => {
    const result = readPreferences({ sidebarWidth: 9000, inspectorWidth: -10, splitRatio: Infinity, collapsedFolders: ['メモ/試験', null, '../a'], materials: [{ query: '軸受', sort: 'bad', descending: false, checked: [null, '資料/a.md'], scrollTop: NaN }, null] });
    expect(result.sidebarWidth).toBe(420); expect(result.inspectorWidth).toBe(260); expect(result.splitRatio).toBe(.5);
    expect(result.collapsedFolders).toEqual(['メモ/試験']); expect(result.materials[0]).toMatchObject({ query: '軸受', sort: 'added', descending: false, checked: ['資料/a.md'], scrollTop: 0 });
  });
});
