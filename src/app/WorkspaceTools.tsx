import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronRight, FileText, FilePlus2, Folder, FolderPlus, FolderUp, MoreHorizontal, Pencil, FolderInput, Scissors, Search, RefreshCw, X, Link2, List } from 'lucide-react';
import { useWorkspace, workspace } from './workspace';
import { decode, newNotePath, referenceHits, searchNotes } from '../domain/note-links';
import { type FileEntry, type OpenDocument } from '../domain/documents';
import { noteMoveTarget } from '../domain/note-folders';
import { MaterialBacklinks } from '../features/materials/MaterialsView';
import { materialReferences, readMaterial, type Material } from '../domain/materials';
import { outlineHeadings } from '../domain/outline';

export interface EditRequest { type: 'rename' | 'move' | 'folder' | 'extract' | 'note'; path: string }
export const openMode = (event: MouseEvent) => ({ pane: event.ctrlKey && event.altKey ? 1 as const : useWorkspace.getState().activePane, newTab: event.ctrlKey || event.metaKey || event.button === 1 });

export function ItemActions({ path, onEdit, folder = false }: { path: string; onEdit: (request: EditRequest) => void; folder?: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && ref.current) ref.current.open = false; }; window.addEventListener('pointerdown', close); return () => window.removeEventListener('pointerdown', close); }, []);
  return <details className="item-actions" ref={ref}><summary aria-label={`${path}の操作`} title="名前変更・移動"><MoreHorizontal size={15} /></summary><div role="menu" aria-label={`${path}の操作メニュー`}>
    {folder && <><button role="menuitem" onClick={() => { ref.current!.open = false; onEdit({ type: 'note', path }); }}><FilePlus2 size={14} />メモを追加</button><button role="menuitem" onClick={() => { ref.current!.open = false; onEdit({ type: 'folder', path }); }}><FolderPlus size={14} />子フォルダーを作成</button><div className="menu-separator" /></>}
    <button role="menuitem" onClick={() => { ref.current!.open = false; onEdit({ type: 'rename', path }); }}><Pencil size={14} />名前を変更</button>
    <button role="menuitem" onClick={() => { ref.current!.open = false; onEdit({ type: 'move', path }); }}><FolderInput size={14} />移動</button>
  </div></details>;
}

export function NoteTree({ notes, folders, query, active, onEdit }: { notes: FileEntry[]; folders: string[]; query: string; active: string | null; onEdit: (request: EditRequest) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragged, setDragged] = useState<{ path: string; root: string } | null>(null), [over, setOver] = useState<string | null>(null);
  const dragSource = useRef<{ path: string; root: string } | null>(null);
  const nav = useRef<HTMLElement>(null), pointerCleanup = useRef<(() => void) | null>(null), suppressClickUntil = useRef(0);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const hoverTimer = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const root = useWorkspace(state => state.vault?.root), locked = useWorkspace(state => state.busy || state.closing);
  function clearTimer() { if (hoverTimer.current) clearTimeout(hoverTimer.current.timer); hoverTimer.current = null; }
  function clearDrag() { clearTimer(); pointerCleanup.current?.(); pointerCleanup.current = null; dragSource.current = null; setDragged(null); setOver(null); setPointer(null); }
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current.timer); pointerCleanup.current?.(); }, []);
  useEffect(() => { clearDrag(); }, [root]);
  const allFolders = new Set(folders);
  for (const note of notes) { const parts = note.path.split('/').slice(1, -1); let parent = 'メモ'; for (const part of parts) { parent += '/' + part; allFolders.add(parent); } }
  for (const folder of folders) { const parts = folder.split('/').slice(1); let parent = 'メモ'; for (const part of parts) { parent += '/' + part; allFolders.add(parent); } }
  const currentPaths = new Set([...(useWorkspace.getState().vault?.notes ?? notes).map(note => note.path.toLowerCase()), ...[...allFolders].map(path => path.toLowerCase())]);
  function expand(path: string) { setCollapsed(value => new Set([...value].filter(folder => folder !== path && !path.startsWith(folder + '/')))); }
  function edit(request: EditRequest) { if (request.type === 'note' || request.type === 'folder') expand(request.path); onEdit(request); }
  function pointerDown(event: ReactPointerEvent, path: string) {
    if (event.button !== 0 || event.pointerType === 'touch' || locked || !root) return;
    clearDrag();
    const controller = new AbortController(), startX = event.clientX, startY = event.clientY, id = event.pointerId;
    let started = false, x = startX, y = startY, target: string | null = null, frame = 0;
    const options = { signal: controller.signal };
    function locate() {
      const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-note-drop]');
      const folder = element && nav.current?.contains(element) ? element.dataset.noteDrop! : null;
      if (folder === target) return;
      target = folder; setOver(folder); clearTimer();
      if (folder && collapsed.has(folder)) hoverTimer.current = { path: folder, timer: setTimeout(() => { expand(folder); hoverTimer.current = null; }, 650) };
    }
    function scroll() {
      const scroller = nav.current?.closest<HTMLElement>('.sidebar-content');
      if (scroller) {
        const bounds = scroller.getBoundingClientRect();
        if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
          const delta = y < bounds.top + 32 ? -8 : y > bounds.bottom - 32 ? 8 : 0;
          if (delta) { scroller.scrollTop += delta; locate(); }
        }
      }
      frame = requestAnimationFrame(scroll);
    }
    pointerCleanup.current = () => { controller.abort(); cancelAnimationFrame(frame); };
    window.addEventListener('pointermove', move => {
      if (move.pointerId !== id) return;
      x = move.clientX; y = move.clientY;
      if (!started && Math.hypot(x - startX, y - startY) < 6) return;
      move.preventDefault();
      if (!started) { started = true; const source = { path, root: root! }; dragSource.current = source; setDragged(source); frame = requestAnimationFrame(scroll); }
      setPointer({ x, y }); locate();
    }, { ...options, passive: false });
    window.addEventListener('pointerup', release => {
      if (release.pointerId !== id) return;
      x = release.clientX; y = release.clientY; locate();
      const folder = target, valid = started && folder && !dropProblem(folder) && !useWorkspace.getState().busy && !useWorkspace.getState().closing;
      if (started) { release.preventDefault(); suppressClickUntil.current = Date.now() + 350; }
      clearDrag();
      if (valid && folder) void workspace.moveNoteToFolder(path, folder).then(ok => { if (ok) expand(folder); });
    }, options);
    const cancel = () => { if (started) suppressClickUntil.current = Date.now() + 350; clearDrag(); };
    window.addEventListener('pointercancel', cancel, options);
    window.addEventListener('blur', cancel, options);
    window.addEventListener('keydown', key => { if (key.key === 'Escape') { key.preventDefault(); cancel(); } }, options);
  }
  function dropProblem(folder: string): string | null {
    const source = dragSource.current;
    if (!source || source.root !== root) return 'この保管庫内のメモをドラッグしてください。';
    const target = noteMoveTarget(source.path, folder);
    if (!target) return '同じ場所や、自分自身の配下へは移動できません。';
    if (currentPaths.has(target.toLowerCase())) return '移動先に同名の項目があります。';
    return null;
  }
  function dropClass(path: string) { return over === path ? dropProblem(path) ? ' drop-blocked' : ' drop-target' : ''; }
  function children(parent: string, level: number): React.ReactNode {
    const nested = [...allFolders].filter(path => path.split('/').slice(0, -1).join('/') === parent).sort();
    return <>
      {nested.map(path => {
        if (query && ![...allFolders, ...notes.map(note => note.path)].some(child => (child === path || child.startsWith(path + '/')) && child.toLowerCase().includes(query.toLowerCase()))) return null;
        const expanded = !!query || !collapsed.has(path);
        return <div key={path}><div data-note-drop={path} className={`nav-row${dropClass(path)}${dragged?.path === path ? ' dragging' : ''}`} style={{ paddingLeft: level * 12 }}><button className="nav-item folder-item" title={path} aria-expanded={expanded} draggable={false} onPointerDown={event => pointerDown(event, path)} onClick={() => setCollapsed(value => { const next = new Set(value); if (next.has(path)) next.delete(path); else next.add(path); return next; })}><ChevronRight size={12} className={expanded ? 'expanded' : ''} /><Folder size={14} /><span>{path.split('/').at(-1)}</span></button><button className="icon-button nav-add-note" aria-label={`${path}にメモを追加`} title="このフォルダーにメモを追加" onClick={() => edit({ type: 'note', path })}><FilePlus2 size={14} /></button><ItemActions path={path} onEdit={edit} folder /></div>{expanded && children(path, level + 1)}</div>;
      })}
      {notes.filter(note => note.path.split('/').slice(0, -1).join('/') === parent && note.path.toLowerCase().includes(query.toLowerCase())).map(note => <div key={note.path} className={`nav-row${dragged?.path === note.path ? ' dragging' : ''}`} style={{ paddingLeft: level * 12 }}><button className={`nav-item ${active === note.path ? 'selected' : ''}`} title={note.path} draggable={false} onPointerDown={event => pointerDown(event, note.path)} onClick={event => { const mode = openMode(event); void workspace.openNote(note.path, mode.pane, mode.newTab); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void workspace.openNote(note.path, useWorkspace.getState().activePane, true); } }}><FileText size={15} /><span>{note.name.replace(/\.md$/i, '')}</span></button><ItemActions path={note.path} onEdit={onEdit} /></div>)}
    </>;
  }
  return <nav ref={nav} aria-label="メモ" onClickCapture={event => { if (Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); } }}>{children('メモ', 0)}<div data-note-drop="メモ" className={`note-root-drop${dropClass('メモ')}`} role="group" aria-label="メモ直下への移動先" hidden={!dragged}><FolderUp size={14} /><span>メモ直下に移動</span></div>{dragged && <p className="note-drag-hint" role="status">{over && dropProblem(over) || 'フォルダーへドラッグして整理'}</p>}{dragged && pointer && <div className="note-drag-preview" aria-hidden style={{ left: pointer.x + 14, top: pointer.y + 12 }}><FileText size={14} />{dragged.path.split('/').at(-1)?.replace(/\.md$/i, '')}</div>}</nav>;
}

export function Inspector({ document }: { document: OpenDocument }) {
  const state = useWorkspace(), index = workspace.index();
  let material: Material | null = null;
  if (document.kind === 'material') { try { material = readMaterial(document.files[0]); } catch { /* The raw document remains editable. */ } }
  const refs = referenceHits(index, document.id);
  const outline = outlineHeadings(document.files);
  return <aside className="outline-panel"><div className="inspector-tabs" role="tablist" aria-label="右サイドバー"><button role="tab" aria-selected={state.inspector === 'backlinks'} onClick={() => useWorkspace.setState({ inspector: 'backlinks' })}><Link2 size={13} />バックリンク<span>{material ? materialReferences(index, material).length : refs.length}</span></button><button role="tab" aria-selected={state.inspector === 'outline'} onClick={() => useWorkspace.setState({ inspector: 'outline' })}><List size={13} />目次</button></div><span className="outline-title">{document.label}</span>
    {state.inspector === 'outline' ? outline.length ? <nav aria-label="本文の目次">{outline.map(heading => <button key={`${heading.path}:${heading.from}`} data-heading-level={heading.level} style={{ paddingLeft: 8 + (heading.level - 1) * 12 }} title={`${heading.path.split('/').at(-1)} · H${heading.level}`} onClick={() => useWorkspace.setState({ jump: { id: document.id, anchor: heading.from, sequence: (state.jump?.sequence ?? 0) + 1 } })}>{heading.title}</button>)}</nav> : <p>本文の見出しがここに表示されます。</p>
      : material ? <MaterialBacklinks material={material} pane={state.activePane} /> : refs.length ? <div className="backlink-list">{refs.map((hit, i) => <button className="backlink-card" key={`${hit.path}-${hit.from}-${i}`} title={`${hit.path}:${hit.line}`} onClick={event => { const mode = openMode(event); void workspace.openHit(hit, mode.pane, mode.newTab); }}><strong>{hit.source.name}</strong><span className="reference-meta">{hit.date ?? 'メモ'} · {hit.fragment ? `日付・見出し: ${hit.fragment}` : 'ノート全体'} · {hit.line}行</span><p>{hit.context}</p></button>)}</div> : <p>このノートへの参照はまだありません。<br />[[ からノートをつなげられます。</p>}
  </aside>;
}

export function WorkspaceTools({ onEdit }: { onEdit: (request: EditRequest) => void }) {
  const state = useWorkspace(), [search, setSearch] = useState(false), [query, setQuery] = useState(''), [limit, setLimit] = useState(100);
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const results = searchNotes(workspace.index(), query);
  useEffect(() => { if (search) { dialog.current?.showModal(); input.current?.focus(); } else dialog.current?.close(); }, [search]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => { if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearch(true); } };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, []);
  return <><button className="icon-button" aria-label="保管庫内を検索" title="保管庫内を検索（Ctrl+Shift+F）" onClick={() => setSearch(true)}><Search size={16} /></button><button className="icon-button" aria-label="選択範囲をメモに切り出す" title="選択範囲をメモに切り出す" disabled={!state.selectionText.trim() || state.documents[state.panes[state.activePane].active ?? '']?.kind === 'material'} onClick={() => onEdit({ type: 'extract', path: '' })}><Scissors size={16} /></button><button className="icon-button" aria-label="保管庫を再読み込み" title="外部変更・移動を再読み込み" onClick={() => void workspace.refresh()}><RefreshCw size={16} /></button>
    <dialog className="search-dialog" ref={dialog} aria-label="保管庫内を検索" onCancel={() => setSearch(false)} onClose={() => setSearch(false)}><div className="search-header"><Search size={17} /><input ref={input} aria-label="検索する文字列" placeholder="保管庫全体の本文を検索…" value={query} onChange={event => { setQuery(event.target.value); setLimit(100); }} /><button className="icon-button" aria-label="検索を閉じる" onClick={() => setSearch(false)}><X size={17} /></button></div><div className="search-results">{query.trim() ? <><span className="reference-meta">{results.length}件</span>{results.slice(0, limit).map((hit, i) => <button className="search-result" key={`${hit.path}-${hit.from}-${i}`} onClick={event => { const mode = openMode(event); dialog.current?.close(); setSearch(false); void workspace.openHit(hit, mode.pane, mode.newTab); }}><strong>{hit.source.name}</strong><span className="reference-meta">{hit.date ?? hit.path} · {hit.line}行</span><p>{hit.context}</p></button>)}{results.length > limit && <button className="button" onClick={() => setLimit(limit + 100)}>さらに表示</button>}{!results.length && <p className="empty-message">一致する記録はありません。</p>}</> : <p className="empty-message">技術ノートや日々の記録から、言葉を探せます。</p>}</div></dialog>
  </>;
}

export function WorkspaceDialog({ request, close }: { request: EditRequest | null; close: () => void }) {
  const state = useWorkspace(), missing = state.missingLink;
  const ref = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(''), [working, setWorking] = useState(false);
  useEffect(() => {
    if (!request && !missing) { ref.current?.close(); return; }
    const source = request?.path ?? '', leaf = source.split('/').at(-1) ?? '';
    setValue(request?.type === 'rename' ? leaf.replace(/\.md$/i, '') : request?.type === 'move' ? source.split('/').slice(0, -1).join('/') : '');
    if (!ref.current?.open) ref.current?.showModal();
    input.current?.focus(); input.current?.select();
  }, [request, missing]);
  function dismiss() { close(); useWorkspace.setState({ missingLink: null }); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setWorking(true);
    let ok = false;
    if (missing && !request) ok = await workspace.createLinkedNote(missing.target, missing.sourcePath, missing.pane, missing.newTab);
    else if (request) {
      const source = request.path, root = source.split('/')[0] || 'メモ', leaf = source.split('/').at(-1)!;
      if (request.type === 'rename') { const name = /\.md$/i.test(leaf) ? value.trim().replace(/\.md$/i, '') + '.md' : value.trim(); ok = await workspace.relocate(source, source.split('/').slice(0, -1).join('/') + '/' + name); }
      else if (request.type === 'move') { const folder = value.trim().replace(/\/$/, ''); ok = await workspace.relocate(source, (folder.startsWith(root) ? folder : root + '/' + folder) + '/' + leaf); }
      else if (request.type === 'folder') ok = await workspace.createChildFolder(request.path || 'メモ', value.trim());
      else if (request.type === 'note') ok = await workspace.createNoteInFolder(request.path || 'メモ', value.trim());
      else ok = await workspace.extractSelection(value.trim());
    }
    setWorking(false); if (ok) dismiss();
  }
  let missingPath = '';
  try { if (missing) missingPath = newNotePath(missing.target, missing.sourcePath); } catch { missingPath = decode(missing?.target ?? ''); }
  const title = !request ? 'リンク先のメモがありません' : { rename: '名前を変更', move: '移動', folder: '新しいメモフォルダー', extract: '選択範囲をメモに切り出す', note: '新しいメモ' }[request.type];
  const label = request?.type === 'move' ? '移動先のフォルダー' : request?.type === 'extract' ? '新しいメモのタイトル' : request?.type === 'note' ? 'メモのタイトル' : '名前';
  return <dialog className="create-dialog" ref={ref} aria-label={title} onCancel={dismiss} onClose={() => { if (!working) dismiss(); }}><form onSubmit={event => void submit(event)}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="閉じる" type="button" onClick={dismiss} disabled={working}><X size={18} /></button></div>{request ? <label>{label}<input ref={input} aria-label={label} value={value} onChange={event => setValue(event.target.value)} disabled={working} maxLength={180} /></label> : <p className="missing-target">{missingPath}</p>}
      {request?.type === 'extract' ? <><p>元の位置をリンクに置き換えます。</p><pre className="selection-preview">{state.selectionText.slice(0, 600)}</pre></> : request?.type === 'move' ? <p>現在：{request.path}<br />フォルダーがなければ作成します。</p> : request?.type === 'rename' ? <p>参照元のリンクも更新します。指定した別名は保持します。</p> : !request ? <p>このメモを作成して、そのまま開きます。</p> : <p className="creation-location">作成先：{request.path || 'メモ'}<br />{request.type === 'note' ? '作成後、そのまま本文を編集できます。' : 'メモをまとめるフォルダーを作成します。'}</p>}
      <footer><button className="button" type="button" onClick={dismiss} disabled={working}>キャンセル</button><button className="button primary" disabled={working || !!request && !value.trim()}>{!request ? 'メモを作成' : request.type === 'extract' ? '切り出す' : request.type === 'move' ? '移動' : request.type === 'rename' ? '変更' : '作成'}</button></footer></form></dialog>;
}

export function FolderButton({ onEdit }: { onEdit: (request: EditRequest) => void }) { return <button className="icon-button" aria-label="メモのフォルダーを作成" title="メモのフォルダーを作成" onClick={() => onEdit({ type: 'folder', path: 'メモ' })}><FolderPlus size={14} /></button>; }
