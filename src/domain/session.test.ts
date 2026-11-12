import { describe, expect, it } from 'vitest';
import { fromDisk } from './documents';
import { documentPosition, filePosition, readSession } from './session';

const file = (path: string, content: string) => fromDisk({ path, content, revision: path });

describe('作業位置と画面状態の復元', () => {
  it('前の月が増減してもファイル内の編集位置に戻る', () => {
    const files = [file('テーマ/試験/2026-10.md', '先月\n'), file('テーマ/試験/2026-11.md', '今月の記録')];
    const saved = filePosition(files, 8);
    expect(saved).toEqual({ path: 'テーマ/試験/2026-11.md', offset: 3 });
    const changed = [file(files[0].path, '先月の追記で長くなった\n'), files[1]];
    expect(documentPosition(changed, saved)).toBe(changed[0].content.length + 2 + 3);
    expect(documentPosition([file(files[1].path, '短')], saved)).toBe(1);
    expect(documentPosition([], saved)).toBe(0);
  });

  it('未対応の形式を黙って採用せず、重複・不正なタブや位置を除く', () => {
    expect(readSession(null)).toBeNull();
    expect(() => readSession({ version: 2, panes: [] })).toThrow('形式');
    const session = readSession({ version: 1, panes: [{ tabs: [{ id: 'メモ/a.md', kind: 'note', pinned: true, view: { anchor: { path: 'メモ/a.md', offset: -1 } } }, { id: 'メモ/a.md', kind: 'note' }, { id: '../a', kind: 'other' }], active: 'missing' }, { tabs: [] }], split: false, activePane: 1 });
    expect(session?.panes[0]).toEqual({ tabs: [{ id: 'メモ/a.md', kind: 'note', pinned: true }], active: 'メモ/a.md' });
    expect(session?.activePane).toBe(0);
  });
});
