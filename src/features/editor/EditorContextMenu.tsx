import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Scissors, ClipboardPaste, List, ListTodo, TextSelect } from 'lucide-react';
import { selectAll } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { useWorkspace } from '../../app/workspace';
import { resourceApi } from '../materials/material-service';
import { isDesktop } from '../../platform/desktop';
import { formatLines } from './formatting';
import { addTaskCheckboxes } from './task-list';

export interface ContextMenuTarget { view: EditorView; x: number; y: number }
class ClipboardSelectionError extends Error {}
async function nativeTransfer(data: DataTransfer) {
  const native = await resourceApi.clipboard();
  if (native.paths.length > 1) throw new ClipboardSelectionError('資料は1件ずつ貼り付けてください。');
  const text = native.paths[0] ?? native.text;
  if (text) data.setData('text/plain', text);
  return data.types.length > 0;
}
export function EditorContextMenu({ target, current, close }: { target: ContextMenuTarget; current: () => EditorView | null; close: () => void }) {
  const menu = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ left: target.x, top: target.y });
  const { view } = target, selected = view.state.selection.ranges.some(range => !range.empty);
  const focusEditor = () => { if (current() === view) view.focus(); };
  useLayoutEffect(() => {
    const bounds = menu.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(target.x, window.innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(target.y, window.innerHeight - bounds.height - 8)) });
    menu.current!.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [target]);
  useEffect(() => {
    const outside = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) close(); };
    const dismiss = () => close();
    document.addEventListener('pointerdown', outside, true); document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('scroll', outside, true); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss); };
  }, [close]);
  async function clipboard(action: 'copy' | 'cut' | 'paste') {
    const state = view.state; close(); focusEditor();
    try {
      if (action !== 'paste') {
        await navigator.clipboard.writeText(state.selection.ranges.map(range => state.sliceDoc(range.from, range.to)).join('\n'));
        if (action === 'cut' && current() === view && view.state.doc === state.doc && view.state.selection.eq(state.selection) && !view.state.readOnly) view.dispatch(view.state.update(view.state.replaceSelection(''), { scrollIntoView: true, userEvent: 'delete.cut' }));
      } else {
        const data = new DataTransfer();
        try {
          if (navigator.clipboard.read) {
            for (const item of await navigator.clipboard.read()) for (const type of item.types) {
              if (type === 'text/plain' || type === 'text/html') data.setData(type, await (await item.getType(type)).text());
              else if (type.startsWith('image/')) data.items.add(new File([await item.getType(type)], 'clipboard.png', { type }));
            }
          } else data.setData('text/plain', await navigator.clipboard.readText());
        } catch (error) {
          if (!isDesktop()) throw error;
          if (!await nativeTransfer(data)) throw error;
        }
        // Explorer's copied file formats may not be exposed as ClipboardItems.
        if (!data.types.length && isDesktop()) await nativeTransfer(data);
        if (!data.types.length) return;
        if (current() !== view || view.state.doc !== state.doc || !view.state.selection.eq(state.selection) || view.state.readOnly) return;
        view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }
    } catch (error) { useWorkspace.setState({ error: error instanceof ClipboardSelectionError ? error.message : action === 'paste' ? 'クリップボードを読み込めませんでした。本文でCtrl+Vを使用してください。' : 'クリップボードへコピーできませんでした。本文でCtrl+C／Ctrl+Xを使用してください。' }); }
  }
  function run(command: (view: EditorView) => boolean) { close(); if (current() === view) { command(view); focusEditor(); } }
  return createPortal(<div ref={menu} style={position} className="editor-context-menu" role="menu" aria-label="本文の編集" onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(); focusEditor(); }
  }}>
    <button role="menuitem" disabled={!selected} onClick={() => void clipboard('cut')}><Scissors size={16} />切り取り<kbd>Ctrl+X</kbd></button>
    <button role="menuitem" disabled={!selected} onClick={() => void clipboard('copy')}><Copy size={16} />コピー<kbd>Ctrl+C</kbd></button>
    <button role="menuitem" onClick={() => void clipboard('paste')}><ClipboardPaste size={16} />貼り付け<kbd>Ctrl+V</kbd></button>
    <button role="menuitem" onClick={() => run(selectAll)}><TextSelect size={16} />すべて選択<kbd>Ctrl+A</kbd></button>
    <div role="separator" />
    <button role="menuitem" onClick={() => run(formatLines('bullet', 'set'))}><List size={16} />箇条書きに変換</button>
    <button role="menuitem" onClick={() => run(addTaskCheckboxes)}><ListTodo size={16} />チェックボックスに変換</button>
  </div>, document.body);
}
