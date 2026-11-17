import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { compose, fromDisk } from '../../domain/documents';
import { livePreview, markdownDestination } from './live-preview';
import { sourceFilesEffect, sourceFilesField } from './source-model';

const file = (path: string, content: string) => fromDisk({ path, content, revision: path });

describe('元のMarkdownとライブプレビュー', () => {
  it('同じ行のカーソル移動はプレビューを再構築せず、別月の移動では非対象月の装飾を再利用する', () => {
    const files = [file('テーマ/試験/2026-10.md', '**先月**\n\n本文'), file('テーマ/試験/2026-11.md', '**今月**\n\n本文')];
    let state = EditorState.create({ doc: compose(files).text, selection: { anchor: 2 }, extensions: [sourceFilesField.init(() => files), livePreview] });
    const first = state.field(livePreview);
    state = state.update({ selection: { anchor: 3 } }).state;
    expect(state.field(livePreview)).toBe(first);
    const next = compose(files).segments[1].from;
    state = state.update({ selection: { anchor: next } }).state;
    const second = state.field(livePreview);
    state = state.update({ selection: { anchor: state.doc.length } }).state;
    expect(state.field(livePreview).sources[0].ranges).toBe(second.sources[0].ranges);
  });
  it('未完了のコードブロックと参照定義を翌月のプレビューに持ち越さない', () => {
    const files = [file('テーマ/試験/2026-10.md', '[ref]: https://example.com\n\n```ts\n**literal**'), file('テーマ/試験/2026-11.md', '# 2026-11-12\n\n**今月** と [ref]\n\n末尾')];
    const { text, segments } = compose(files);
    const state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [sourceFilesField.init(() => files), livePreview] });
    const decorations: { from: number; to: number; className: string }[] = [];
    state.field(livePreview).decorations.between(0, text.length, (from, to, value) => { decorations.push({ from, to, className: value.spec.class }); });
    expect(decorations.filter(value => value.className?.includes('cm-code-block')).every(value => value.from < segments[1].from)).toBe(true);
    expect(decorations.some(value => value.from === segments[1].from && value.className === 'cm-heading cm-heading-1')).toBe(true);
    expect(decorations.some(value => value.from >= segments[1].from && value.className === 'cm-preview-strong')).toBe(true);
    expect(decorations.some(value => value.className === 'cm-preview-link')).toBe(false);
    expect(state.doc.toString()).toBe(text);
  });

  it('Reactの同期前に連続入力しても現在の月別モデルと表示本文が一致する', () => {
    const files = [file('テーマ/試験/2026-10.md', '先月'), file('テーマ/試験/2026-11.md', '今月')];
    let state = EditorState.create({ doc: compose(files).text, extensions: [sourceFilesField.init(() => files), livePreview] });
    state = state.update({ changes: { from: 1, insert: 'の' } }).state;
    state = state.update({ changes: { from: 2, insert: '追記' } }).state;
    expect(compose(state.field(sourceFilesField)).text).toBe(state.doc.toString());
    expect(state.field(sourceFilesField)[1].content).toBe('今月');
    const external = [files[0], file(files[1].path, '**別ペインからの変更**')];
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: compose(external).text }, effects: sourceFilesEffect.of(external) }).state;
    expect(compose(state.field(sourceFilesField)).text).toBe(state.doc.toString());
    expect(state.field(sourceFilesField)[0].content).toBe('先月');
  });

  it('リンクの囲み・バックスラッシュ・HTML文字参照だけを復号する', () => {
    expect(markdownDestination('<https://example.com/a\\(b\\)?x=1&amp;y=&#50;>')).toBe('https://example.com/a(b)?x=1&y=2');
    expect(markdownDestination('https://example.com/%E6%8A%80%E8%A1%93')).toBe('https://example.com/%E6%8A%80%E8%A1%93');
    expect(markdownDestination('&#x110000;')).toBe('\uFFFD');
  });
});
