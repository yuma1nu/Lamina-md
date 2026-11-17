import { StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { compose, type SourceFile } from '../../domain/documents';
import { imageMarkup, imagePath, imageReferences, type ImageReference } from '../../domain/images';
import { sourceFilesEffect, sourceFilesField } from '../editor/source-model';
import { useWorkspace } from '../../app/workspace';
import { imageApi, imageError, imagePreview, imageWork, normalizeImage } from './image-service';

export interface ImageEditRequest { root: string; path: string; source: string; ref: ImageReference; view: EditorView; raw: string }
const refreshImages = StateEffect.define<void>();
const editImageSource = StateEffect.define<number>();

class ImageWidget extends WidgetType {
  constructor(readonly root: string, readonly source: string, readonly ref: ImageReference, readonly version: number, readonly edit: (request: ImageEditRequest) => void) { super(); }
  eq(other: ImageWidget) { return other.root === this.root && other.source === this.source && JSON.stringify(other.ref) === JSON.stringify(this.ref) && other.version === this.version; }
  toDOM(view: EditorView) {
    const wrapper = document.createElement('span'); wrapper.className = 'cm-image-frame'; wrapper.contentEditable = 'false'; wrapper.tabIndex = 0;
    wrapper.style.width = `${this.ref.width ?? 640}px`;
    wrapper.setAttribute('aria-label', this.ref.alt || '画像');
    const image = document.createElement('img'); image.alt = this.ref.alt || '画像'; image.draggable = false; image.title = 'ダブルクリックで注釈を編集';
    const status = document.createElement('span'); status.className = 'image-status'; status.textContent = '画像を読み込んでいます…';
    const tools = document.createElement('span'); tools.className = 'image-tools';
    const annotation = document.createElement('button'); annotation.type = 'button'; annotation.textContent = '注釈を編集'; annotation.setAttribute('aria-label', '画像の注釈を編集');
    const source = document.createElement('button'); source.type = 'button'; source.textContent = '</>'; source.title = 'Markdownを編集'; source.setAttribute('aria-label', '画像のMarkdownを編集');
    let disposed = false;
    const path = imagePath(this.source, this.ref.path);
    const open = () => { if (path && !useWorkspace.getState().busy && !useWorkspace.getState().closing) this.edit({ root: this.root, path, source: this.source, ref: this.ref, view, raw: view.state.sliceDoc(this.ref.from, this.ref.to) }); };
    annotation.onclick = event => { event.preventDefault(); open(); };
    source.onclick = event => { event.preventDefault(); view.dispatch({ effects: editImageSource.of(this.ref.from), selection: { anchor: this.ref.from } }); view.focus(); };
    image.ondblclick = event => { event.preventDefault(); open(); };
    image.onclick = () => wrapper.focus({ preventScroll: true });
    wrapper.onkeydown = event => {
      if (event.target !== wrapper || useWorkspace.getState().busy || useWorkspace.getState().closing) return;
      if (event.key === 'Enter') { event.preventDefault(); open(); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); view.dispatch({ changes: { from: this.ref.from, to: this.ref.to }, userEvent: 'delete.image' }); view.focus(); }
    };
    tools.append(annotation, source); wrapper.append(image, status, tools);
    for (const left of [false, true]) {
      const handle = document.createElement('button'); handle.type = 'button'; handle.className = `image-resize-handle ${left ? 'left' : 'right'}`; handle.setAttribute('aria-label', left ? '画像の左サイズハンドル' : '画像の右サイズハンドル');
      const commit = (width: number) => {
        if (disposed || useWorkspace.getState().busy || useWorkspace.getState().closing) return;
        view.dispatch({ changes: { from: this.ref.from, to: this.ref.to, insert: imageMarkup(this.source, path!, this.ref.alt, width) }, userEvent: 'input.image.resize' });
        view.focus();
      };
      handle.onpointerdown = event => {
        if (!path || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); wrapper.focus({ preventScroll: true });
        const start = event.clientX, width = wrapper.getBoundingClientRect().width;
        const max = Math.min(20000, wrapper.parentElement?.getBoundingClientRect().width ?? 20000);
        let next = width;
        const move = (event: PointerEvent) => { next = Math.round(Math.max(24, Math.min(max, width + (event.clientX - start) * (left ? -1 : 1)))); wrapper.style.width = `${next}px`; view.requestMeasure(); };
        const finish = () => { cleanup(); if (Math.abs(next - width) >= 1) commit(next); };
        const cancel = () => { cleanup(); wrapper.style.width = `${width}px`; view.requestMeasure(); };
        const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', cancel); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish, { once: true }); window.addEventListener('pointercancel', cancel, { once: true });
      };
      handle.onkeydown = event => { if (path && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); commit(Math.round(Math.max(24, wrapper.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 20 : -20)))); } };
      wrapper.append(handle);
    }
    const error = (message: string) => { status.textContent = message; wrapper.classList.add('image-failed'); annotation.disabled = true; view.requestMeasure(); };
    if (path) void imagePreview(this.root, path).then(file => {
      if (disposed) return;
      image.onload = () => { if (!disposed) { status.hidden = true; wrapper.classList.add('image-ready'); view.requestMeasure(); } };
      image.onerror = () => { if (!disposed) error('画像を表示できません。Markdownを確認してください。'); };
      image.src = `data:${file.mime};base64,${file.data}`;
    }).catch(() => { if (!disposed) error('画像が見つかりません。Markdownを確認してください。'); });
    else error('保管庫内の画像パスを指定してください。');
    (wrapper as HTMLSpanElement & { dispose: () => void }).dispose = () => { disposed = true; image.onload = null; image.onerror = null; };
    return wrapper;
  }
  destroy(dom: HTMLElement) { (dom as HTMLElement & { dispose?: () => void }).dispose?.(); }
  ignoreEvent() { return true; }
}

export function imageExtensions(root: string, edit: (request: ImageEditRequest) => void) {
  const references = new WeakMap<SourceFile, ImageReference[]>();
  const images = StateField.define<{ decorations: DecorationSet; editing: number | null; version: number }>({
    create: state => build(state, null, 0),
    update(value, transaction) {
      let editing = value.editing === null ? null : transaction.changes.mapPos(value.editing);
      let version = value.version;
      for (const effect of transaction.effects) { if (effect.is(editImageSource)) editing = effect.value; if (effect.is(refreshImages)) version++; }
      if (editing !== null && transaction.selection && transaction.state.doc.lineAt(editing).number !== transaction.state.doc.lineAt(transaction.state.selection.main.head).number) editing = null;
      const selectedImagesMayChange = transaction.selection && [...transaction.startState.selection.ranges, ...transaction.state.selection.ranges].some(range => !range.empty);
      return transaction.docChanged || selectedImagesMayChange || editing !== value.editing || transaction.effects.some(e => e.is(editImageSource) || e.is(refreshImages) || e.is(sourceFilesEffect)) ? build(transaction.state, editing, version) : value;
    },
    provide: field => [EditorView.decorations.from(field, value => value.decorations), EditorView.atomicRanges.of(view => view.state.field(field).decorations)],
  });
  function build(state: import('@codemirror/state').EditorState, editing: number | null, version: number) {
    const files = state.field(sourceFilesField), { segments } = compose(files), ranges: Range<Decoration>[] = [];
    files.forEach((file, index) => {
      let refs = references.get(file); if (!refs) { refs = imageReferences(file.content); references.set(file, refs); }
      for (const ref of refs) {
        const absolute = { ...ref, from: segments[index].from + ref.from, to: segments[index].from + ref.to };
        if (absolute.from === editing || state.selection.ranges.some(range => !range.empty && range.from < absolute.to && range.to > absolute.from)) continue;
        // Inline replacement keeps images inside list items and paragraphs editable.
        ranges.push(Decoration.replace({ widget: new ImageWidget(root, file.path, absolute, version, edit) }).range(absolute.from, absolute.to));
      }
    });
    return { decorations: Decoration.set(ranges, true), editing, version };
  }
  return [images, EditorView.domEventHandlers({
    paste(event, view) {
      const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'));
      if (!files.length) return false;
      event.preventDefault(); void insertImages(view, root, files); return true;
    },
    dragover(event) { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; return true; } return false; },
    drop(event, view) {
      const files = [...(event.dataTransfer?.files ?? [])].filter(file => file.type.startsWith('image/'));
      if (!files.length) return false;
      event.preventDefault(); const anchor = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (anchor !== null) view.dispatch({ selection: { anchor } });
      void insertImages(view, root, files); return true;
    },
  })];
}
export function refreshImagePreview(view: EditorView) { view.dispatch({ effects: refreshImages.of() }); }
export async function insertImages(view: EditorView, root: string, files: File[]) {
  if (useWorkspace.getState().busy || useWorkspace.getState().closing) return;
  try {
    const { from, to } = view.state.selection.main;
    const sourceFiles = view.state.field(sourceFilesField), source = compose(sourceFiles).segments.find(s => from >= s.from && from <= s.to)?.path;
    if (!source) throw new Error('本文の挿入位置を選択してください。');
    const markup = await imageWork(async () => {
      const inserted: string[] = [];
      for (const file of files) {
        const normalized = await normalizeImage(file);
        const image = await imageApi.write(root, { original: normalized.data, rendered: normalized.data, annotation: normalized.annotation });
        inserted.push(imageMarkup(source, image.path, file.name.replace(/\.[^.]+$/, '') || '画像', Math.min(640, normalized.annotation.width)));
      }
      return inserted.join('\n\n');
    });
    const insert = (from && view.state.sliceDoc(from - 1, from) !== '\n' ? '\n\n' : '') + markup + '\n\n';
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true, userEvent: 'input.image.paste' }); view.focus();
  } catch (error) { imageError(error); }
}
