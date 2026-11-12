import { describe, expect, it } from 'vitest';
import { childFolderPath, childNotePath, isNoteFolder, noteMoveTarget } from './note-folders';

describe('メモのフォルダー操作', () => {
  it('選んだフォルダー内に拡張子を重複させず作り、記号を名前として扱う', () => {
    expect(childNotePath('メモ/評価/手順', '条件 #1.md')).toBe('メモ/評価/手順/条件 #1.md');
    expect(childNotePath('メモ', '確認.MD')).toBe('メモ/確認.md');
    expect(childFolderPath('メモ/評価', '手順/測定')).toBe('メモ/評価/手順/測定');
    expect(childFolderPath('メモ', 'メモ/評価')).toBe('メモ/評価');
  });
  it('保管庫外・親への移動・Windowsで扱えない名前を拒否する', () => {
    for (const name of ['../別のメモ', '子/メモ', 'CON', 'NUL.txt', 'メモ?', '.md']) expect(() => childNotePath('メモ/評価', name)).toThrow();
    expect(() => childNotePath('テーマ/評価', '確認')).toThrow();
    expect(() => childFolderPath('メモ/評価', '../別の場所')).toThrow();
    expect(isNoteFolder('メモ/評価/../手順')).toBe(false);
  });
  it('メモとフォルダーを別のフォルダーやメモ直下へ移せる', () => {
    expect(noteMoveTarget('メモ/測定.md', 'メモ/評価')).toBe('メモ/評価/測定.md');
    expect(noteMoveTarget('メモ/評価/測定.md', 'メモ')).toBe('メモ/測定.md');
    expect(noteMoveTarget('メモ/手順', 'メモ/評価')).toBe('メモ/評価/手順');
  });
  it('同じ場所・自分自身・子孫へのフォルダー移動を止める', () => {
    expect(noteMoveTarget('メモ/評価/測定.md', 'メモ/評価')).toBeNull();
    expect(noteMoveTarget('メモ/評価', 'メモ/評価')).toBeNull();
    expect(noteMoveTarget('メモ/評価', 'メモ/評価/手順')).toBeNull();
    expect(noteMoveTarget('メモ', 'メモ/評価')).toBeNull();
    expect(noteMoveTarget('メモ/測定.md', 'テーマ/評価')).toBeNull();
  });
});
