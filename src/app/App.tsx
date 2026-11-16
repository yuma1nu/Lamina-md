import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Layers, FolderOpen, FolderPlus, Plus, NotebookPen, FileText, PanelLeftClose, PanelRight, Columns2, CalendarDays, Pin, PinOff, X, Search, ChevronRight, AlertCircle, RotateCw, ArrowUpRight, Database } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { chooseVault, isDesktop } from '../platform/desktop';
import { useWorkspace, workspace } from './workspace';
import { FolderButton, Inspector, ItemActions, NoteTree, WorkspaceDialog, WorkspaceTools, openMode, type EditRequest } from './WorkspaceTools';
import { imagesChanged } from '../features/images/image-service';
import { MaterialsView, MaterialPage, MaterialDetail } from '../features/materials/MaterialsView';
import { MaterialDialog } from '../features/materials/MaterialDialog';
import { focusActiveEditor, tabShortcut } from './tab-shortcuts';

const MarkdownEditor = lazy(() => import('../features/editor/MarkdownEditor').then(module => ({ default: module.MarkdownEditor })));


export function App() {
  const state = useWorkspace(), [query, setQuery] = useState('');
  const sidebar = state.sidebar;
  const [creation, setCreation] = useState<'theme' | 'note' | null>(null), [name, setName] = useState(''), [creating, setCreating] = useState(false);
  const [editRequest, setEditRequest] = useState<EditRequest | null>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const choosingVault = useRef(false);
  const activeId = state.panes[state.activePane].active, active = activeId ? state.documents[activeId] : null;
  const detailRequest = state.materialDetail;
  const detail = detailRequest && detailRequest.pane === state.activePane && detailRequest.documentId === activeId ? workspace.materials().materials.find(item => item.file.path === detailRequest.path) : null;
  const recent = localStorage.getItem('lamina.lastVault');
  async function selectVault(initialize: boolean) {
    choosingVault.current = true;
    try { const root = await chooseVault(); if (root) await workspace.openVault(root, initialize); }
    catch (error) { useWorkspace.setState({ error: String(error instanceof Error ? error.message : error) }); }
    finally { choosingVault.current = false; }
  }
  useEffect(() => {
    const stopSession = workspace.start();
    if (isDesktop()) void workspace.resume();
    let watchDisposed = false;
    const watchStops: (() => void)[] = [];
    if (isDesktop()) for (const [event, handler] of [
      ['vault-changed', (payload: unknown) => { if (payload === useWorkspace.getState().vault?.root) workspace.requestExternalRefresh(); }],
      ['images-changed', (payload: unknown) => { if (payload === useWorkspace.getState().vault?.root) imagesChanged(); }],
      ['vault-watch-error', (payload: unknown) => { const error = payload as { root: string; message: string }; if (error.root === useWorkspace.getState().vault?.root) useWorkspace.setState({ error: `外部変更の監視でエラーが発生しました。\n${error.message}` }); }],
    ] as const) void listen(event, event => handler(event.payload)).then(stop => { if (watchDisposed) stop(); else watchStops.push(stop); }).catch(error => useWorkspace.setState({ error: `外部変更の監視を準備できませんでした。\n${String(error)}` }));
    function keyboard(event: KeyboardEvent) {
      if (event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void workspace.flush().catch(() => {}); }
    }
    window.addEventListener('keydown', keyboard);
    const tabs = (event: KeyboardEvent) => { void tabShortcut(event, () => { setName(''); setCreation('note'); }); };
    window.addEventListener('keydown', tabs, true);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (useWorkspace.getState().annotationOpen || Object.values(useWorkspace.getState().documents).some(d => d.files.some(f => f.revision === null || f.content !== f.savedContent))) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const focus = () => { clearTimeout(focusTimer); focusTimer = setTimeout(() => { if (!choosingVault.current && useWorkspace.getState().vault && !useWorkspace.getState().annotationOpen) void workspace.refresh(); }, 200); };
    window.addEventListener('focus', focus);
    let disposed = false, unlisten: (() => void) | undefined;
    if (isDesktop()) void getCurrentWindow().onCloseRequested(async event => {
      event.preventDefault();
      await workspace.close(() => getCurrentWindow().destroy());
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(error => {
      if (!disposed) useWorkspace.setState({ error: `終了処理を準備できませんでした。\n${String(error)}` });
    });
    return () => { disposed = true; watchDisposed = true; watchStops.forEach(stop => stop()); stopSession(); clearTimeout(focusTimer); unlisten?.(); window.removeEventListener('keydown', keyboard); window.removeEventListener('keydown', tabs, true); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('focus', focus); };
  }, []);
  useEffect(() => { focusActiveEditor(); }, [state.activePane, state.panes[0].active, state.panes[1].active]);
  useEffect(() => {
    if (creation && !modal.current?.open) modal.current?.showModal();
    if (!creation && modal.current?.open) modal.current?.close();
  }, [creation]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!creation || !name.trim()) return;
    setCreating(true);
    const ok = await workspace.create(creation, name.trim());
    setCreating(false);
    if (ok) { setCreation(null); setName(''); }
  }
  function beginCreate(kind: 'theme' | 'note') { setName(''); setCreation(kind); }
  const filteredThemes = state.vault?.themes.filter(t => t.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const filteredNotes = state.vault?.notes.filter(n => n.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  return <div className={`app-shell ${sidebar ? '' : 'sidebar-hidden'} ${state.outline && active && active.kind !== 'materials' ? '' : 'outline-hidden'} ${state.outline && detail ? 'material-inspector' : ''}`} inert={state.busy || state.closing} aria-busy={state.busy || state.closing}>
    {sidebar && <aside className="sidebar">
      <div className="brand"><Layers size={21} strokeWidth={1.6} /><span>Lamina<span className="brand-suffix">.md</span></span></div>
      {state.vault ? <>
        <button className="vault-picker" onClick={() => void selectVault(false)} title="別の保管庫を開く"><FolderOpen size={15} /><span>{state.vault.name}</span><ChevronRight size={13} /></button>
        <label className="navigator-search"><Search size={14} /><input aria-label="テーマ・メモを絞り込み" placeholder="絞り込み" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button className={`nav-item materials-nav ${active?.kind === 'materials' ? 'selected' : ''}`} onClick={() => workspace.openMaterials()}><Database size={15} /><span>資料一覧</span></button>
        <div className="sidebar-content">
          <div className="section-title"><span>テーマ</span><button className="icon-button" aria-label="テーマを追加" title="テーマを追加" onClick={() => beginCreate('theme')}><Plus size={15} /></button></div>
          <nav aria-label="テーマ">{filteredThemes.map(theme => <div className="nav-row" key={theme.path}><button className={`nav-item ${activeId === theme.path ? 'selected' : ''}`} title={theme.path} onClick={event => { const mode = openMode(event); void workspace.openTheme(theme, mode.pane, mode.newTab); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void workspace.openTheme(theme, useWorkspace.getState().activePane, true); } }}><NotebookPen size={15} /><span>{theme.name}{theme.path.split('/').length > 2 && <small>{theme.path.split('/').slice(1, -1).join(' / ')}</small>}</span></button><ItemActions path={theme.path} onEdit={setEditRequest} /></div>)}</nav>
          {!state.vault.themes.length && <p className="sidebar-hint">テーマを追加して、日々の記録を始めましょう。</p>}
          <div className="section-title memo-section"><span>メモ</span><div className="section-actions"><FolderButton onEdit={setEditRequest} /><button className="icon-button" aria-label="メモを追加" title="メモを追加" onClick={() => beginCreate('note')}><Plus size={15} /></button></div></div>
          <NoteTree notes={filteredNotes} folders={state.vault.noteFolders ?? []} query={query} active={activeId} onEdit={setEditRequest} />
          {query && !filteredNotes.length && !filteredThemes.length && <p className="sidebar-hint">一致する項目はありません。</p>}
        </div>
      </> : <div className="sidebar-intro"><p>考えたことを、<br />次の知見へ。</p><span>日々の記録を重ねる場所。</span></div>}
      <div className="sidebar-footer"><button onClick={() => void selectVault(false)} disabled={state.busy}><FolderOpen size={15} />保管庫を開く</button><span>個人の技術ノート</span></div>
    </aside>}
    <main className="main-column">
      <header className="workspace-toolbar">
        <div className="breadcrumb"><button className="icon-button" aria-label={sidebar ? 'サイドバーを閉じる' : 'サイドバーを開く'} onClick={() => useWorkspace.setState({ sidebar: !sidebar })}><PanelLeftClose size={17} /></button><span>{active ? active.kind === 'theme' ? 'テーマ' : active.kind === 'note' ? 'メモ' : '資料' : 'Lamina.md'}</span>{active && <><ChevronRight size={12} /><strong>{active.label}</strong></>}</div>
        <div className="toolbar-actions">{state.vault && <WorkspaceTools onEdit={setEditRequest} />}{active?.kind === 'theme' && <button className="today-button" onClick={() => workspace.today(active.id)}><CalendarDays size={15} />今日へ</button>}{active && <>{active.kind !== 'materials' && <ItemActions path={active.id} onEdit={setEditRequest} />}<button className="icon-button" aria-label="左右分割を切り替え" title="左右分割" aria-pressed={state.split} onClick={() => workspace.toggleSplit()}><Columns2 size={17} /></button><button className="icon-button" aria-label="右サイドバーを切り替え" title="バックリンク・目次" aria-pressed={state.outline} onClick={() => useWorkspace.setState({ outline: !state.outline })}><PanelRight size={17} /></button></>}</div>
      </header>
      <div className={`panes ${state.split ? 'split' : ''}`}>
        {([0, 1] as const).filter(p => p === 0 || state.split).map(pane => {
          const group = state.panes[pane], document = group.active ? state.documents[group.active] : null;
          return <section className={`pane ${state.activePane === pane ? 'active-pane' : ''}`} key={pane} aria-label={pane ? '右ペイン' : '左ペイン'} onPointerDown={() => workspace.activate(pane)}>
            {!!group.tabs.length && <div className="tab-strip" role="tablist" aria-label={pane ? '右ペインのタブ' : '左ペインのタブ'}>{group.tabs.map(tab => <div className={`tab ${group.active === tab.id ? 'active' : ''}`} key={tab.id}><button className="tab-title" role="tab" aria-selected={group.active === tab.id} onClick={() => workspace.activate(pane, tab.id)}>{state.documents[tab.id]?.label}</button><button className={`tab-action ${tab.pinned ? 'pinned' : ''}`} aria-label={tab.pinned ? 'ピン留めを解除' : 'ピン留め'} title={tab.pinned ? 'ピン留めを解除' : 'ピン留め'} onClick={() => workspace.togglePin(pane, tab.id)}>{tab.pinned ? <Pin size={12} /> : <PinOff size={12} />}</button><button className="tab-action" aria-label={`${state.documents[tab.id]?.label}を閉じる`} title="タブを閉じる" onClick={() => void workspace.closeTab(pane, tab.id)}><X size={13} /></button></div>)}</div>}
            {document?.kind === 'materials' ? <MaterialsView pane={pane} /> : document?.kind === 'material' ? <MaterialPage document={document} pane={pane} jump={state.activePane === pane && state.jump?.id === document.id ? state.jump : null} /> : document ? <div className="document-container"><div className="document-heading"><span className="document-kicker">{document.kind === 'theme' ? 'テーマの記録' : 'メモ'}</span><h1>{document.label}</h1></div>{document.files.length ? <Suspense fallback={<p className="editor-loading">ノートを開いています…</p>}><MarkdownEditor key={document.id} document={document} pane={pane} jump={state.activePane === pane && state.jump?.id === document.id ? state.jump : null} /></Suspense> : <div className="empty-theme"><p>このテーマには、まだ記録がありません。</p><button className="button primary" onClick={() => workspace.today(document.id)}><CalendarDays size={16} />今日の記録を始める</button></div>}</div> : state.vault ? <div className="empty-pane"><Layers size={36} strokeWidth={1} /><h2>記録をひらく</h2><p>テーマやメモを選んで、続きを書きましょう。</p><div className="welcome-actions"><button className="button" onClick={() => beginCreate('theme')}><Plus size={15} />テーマを作る</button><button className="button" onClick={() => beginCreate('note')}><FileText size={15} />メモを作る</button></div></div> : <div className="welcome"><div className="welcome-mark"><Layers size={35} strokeWidth={1.25} /></div><span className="eyebrow">YOUR WORK, LAYER BY LAYER</span><h1>Lamina<span>.md</span></h1><p>今日の試行を、明日の知見に。</p><div className="welcome-actions"><button className="button primary" onClick={() => void selectVault(false)} disabled={state.busy}><FolderOpen size={17} />保管庫を開く</button><button className="button" onClick={() => void selectVault(true)} disabled={state.busy}><FolderPlus size={17} />新しい保管庫を作る</button></div>{recent && isDesktop() && <button className="recent-vault" onClick={() => void workspace.openVault(recent)}><span>前回の保管庫</span><span>{recent.split(/[\\/]/).filter(Boolean).at(-1)}</span><ArrowUpRight size={13} /></button>}<div className="welcome-caption">Markdownを、自分のフォルダーに。</div></div>}
          </section>;
        })}
      </div>
    </main>
    {state.outline && active && active.kind !== 'materials' && (detail ? <MaterialDetail material={detail} pane={state.activePane} className="material-inspector-panel" close={() => { useWorkspace.setState({ materialDetail: null }); focusActiveEditor(); }} /> : <Inspector document={active} />)}
    <MaterialDialog />
    <WorkspaceDialog request={editRequest} close={() => setEditRequest(null)} />
    {state.error && <div className="error-message" role="alert"><AlertCircle size={18} /><div><strong>操作を完了できませんでした</strong><p>{state.error}</p></div>{state.vault && <button className="icon-button" aria-label="保存を再試行" title="保存を再試行" onClick={() => void workspace.flush().catch(() => {})}><RotateCw size={17} /></button>}<button className="icon-button" aria-label="通知を閉じる" onClick={() => useWorkspace.setState({ error: null })}><X size={17} /></button></div>}
    <dialog ref={modal} className="create-dialog" onCancel={() => setCreation(null)} onClose={() => setCreation(null)} aria-labelledby="create-title"><form onSubmit={event => void create(event)}><div className="dialog-heading"><h2 id="create-title">{creation === 'theme' ? '新しいテーマ' : '新しいメモ'}</h2><button type="button" className="icon-button" aria-label="閉じる" onClick={() => setCreation(null)} disabled={creating}><X size={18} /></button></div><label>{creation === 'theme' ? 'テーマ名' : 'タイトル'}<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={creation === 'theme' ? '例：軸受の耐久性評価' : '例：潤滑条件の選定'} maxLength={100} disabled={creating} /></label><p>{creation === 'theme' ? '月ごとのMarkdownを、一続きの記録として扱います。' : 'Markdownファイルとして、メモフォルダーに保存します。'}</p><footer><button type="button" className="button" onClick={() => setCreation(null)} disabled={creating}>キャンセル</button><button className="button primary" disabled={!name.trim() || creating}>作成</button></footer></form></dialog>
  </div>;
}
