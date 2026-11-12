import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { compose } from '../../domain/documents';
import { isMarkupPosition } from '../../domain/note-links';
import { location, readMaterial, type MaterialInsertion } from '../../domain/materials';
import { workspace, useWorkspace } from '../../app/workspace';
import { sourceFilesField } from '../editor/source-model';
import { insertImages } from '../images/image-preview';
import { editMaterial, materialCommitted, materialError, requestMaterial, resourceApi } from './material-service';
import { isDesktop } from '../../platform/desktop';

export function pasteCandidate(text: string, html = ''): { path: string; title?: string } | null {
  const value = text.trim();
  try {
    const path = location(value).path;
    let title: string | undefined;
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const links = [...doc.querySelectorAll('a[href]')];
      const link = links.find(link => { try { return location(link.getAttribute('href')!).key === location(path).key; } catch { return false; } });
      const name = link?.textContent?.trim();
      if (name && name !== value && /\.[\p{L}\d]{1,10}$/u.test(name)) title = name;
    }
    return { path, title };
  } catch { return null; }
}
export function materialEditor(view: () => EditorView | null, documentId: string, pane: 0 | 1, bodyOnly: boolean) {
  function insertion(current: EditorView): MaterialInsertion | null {
    const { from, to } = current.state.selection.main, files = current.state.field(sourceFilesField), segments = compose(files).segments;
    const segment = segments.find(segment => from >= segment.from && from <= segment.to);
    if (!segment || to > segment.to) return null;
    const file = files[segment.index];
    if (isMarkupPosition(file.path, file.content, from - segment.from)) return null;
    const full = workspace.index().files.get(file.path); if (!full) return null;
    const offset = bodyOnly ? readMaterial(full).bodyFrom : 0, expectedEditor = current.state.doc.toString();
    return { documentId, pane, sourcePath: file.path, from: from - segment.from + offset, to: to - segment.from + offset, expectedContent: full.content,
      apply: change => {
        const editor = view(); if (!editor || editor.state.doc.toString() !== expectedEditor) return;
        const local = { from: change.from + segment.from - offset, to: change.to + segment.from - offset, insert: change.insert };
        editor.dispatch({ changes: local, selection: { anchor: local.from + local.insert.length }, annotations: [materialCommitted.of(true), Transaction.userEvent.of('input.material')], scrollIntoView: true });
      },
    };
  }
  function offer(candidate: { path: string; title?: string }, current: EditorView) {
    const position = insertion(current); if (!position) return false;
    requestMaterial(candidate.path, position, candidate.title, () => { if (view() === current) current.focus(); }); return true;
  }
  const extensions = EditorView.domEventHandlers({
    paste(event, current) {
      if (useWorkspace.getState().materialOpen || useWorkspace.getState().busy || useWorkspace.getState().closing) return false;
      if ([...(event.clipboardData?.files ?? [])].some(file => file.type.startsWith('image/'))) return false;
      const candidate = pasteCandidate(event.clipboardData?.getData('text/plain') ?? '', event.clipboardData?.getData('text/html') ?? '');
      if (candidate && insertion(current)) {
        event.preventDefault();
        if (!candidate.title && isDesktop() && !location(candidate.path).web) void resourceApi.clipboard().then(data => {
          const same = data.paths.some(path => { try { return location(path).key === location(candidate.path).key; } catch { return false; } });
          offer({ ...candidate, ...(same && data.title ? { title: data.title } : {}) }, current);
        }).catch(() => offer(candidate, current));
        else offer(candidate, current);
        return true;
      }
      if (isDesktop() && event.clipboardData?.types.includes('Files') && insertion(current)) {
        event.preventDefault();
        void resourceApi.clipboard().then(data => { if (data.paths.length > 1) throw new Error('資料は1件ずつ貼り付けてください。'); const path = data.paths[0] ?? data.text; if (path) offer({ path, title: data.title ?? undefined }, current); else materialError(new Error('資料のパスを取得できませんでした。エクスプローラーの「パスのコピー」を貼り付けてください。')); }).catch(materialError); return true;
      }
      return false;
    },
    mousedown(event) { if (event.target instanceof Element && event.target.closest('[data-material-info]')) { event.preventDefault(); return true; } return false; },
    click(event, current) {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-material-info]') : null;
      if (!button) return false;
      event.preventDefault();
      const material = workspace.materials().materials.find(item => item.file.path === button.dataset.materialInfo);
      if (material) editMaterial(material, () => { if (view() === current) current.focus(); }); return true;
    },
  });
  async function nativeDrop(paths: string[], x: number, y: number) {
    const current = view(); if (!current || useWorkspace.getState().busy || useWorkspace.getState().closing || useWorkspace.getState().materialOpen) return;
    const bounds = current.dom.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
    const position = current.posAtCoords({ x, y }); if (position !== null) current.dispatch({ selection: { anchor: position } });
    const images = paths.filter(path => /\.(png|jpe?g|gif|webp|bmp)$/i.test(path)), documents = paths.filter(path => !images.includes(path));
    if (images.length && documents.length) throw new Error('画像と資料は分けてドロップしてください。');
    if (images.length) {
      const files = await Promise.all(images.slice(0, 32).map(async path => { const image = await resourceApi.image(path); return new File([Uint8Array.from(atob(image.data), char => char.charCodeAt(0))], image.name, { type: image.mime }); }));
      await insertImages(current, useWorkspace.getState().vault!.root, files); return;
    }
    if (documents.length > 1) throw new Error('資料は1件ずつドロップしてください。');
    if (documents[0]) offer({ path: documents[0] }, current);
  }
  function listenDrops() {
    if (!isDesktop()) return () => {};
    let stopped = false, stop: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === 'drop') void nativeDrop(event.payload.paths, event.payload.position.x / window.devicePixelRatio, event.payload.position.y / window.devicePixelRatio).catch(materialError);
    }).then(unlisten => { if (stopped) unlisten(); else stop = unlisten; }).catch(materialError);
    return () => { stopped = true; stop?.(); };
  }
  return { extensions, listenDrops };
}
