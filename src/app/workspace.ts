import { create } from 'zustand';
import { applyChanges, compose, ensureToday, fromDisk, isDirty, serializeFile } from '../domain/documents';
import type { OpenDocument, TextChange, ThemeEntry, VaultSnapshot } from '../domain/documents';
import { desktop, type DesktopApi } from '../platform/desktop';
import { SaveQueue } from '../services/save-queue';
import { readSession, type EditorPosition, type WorkspaceSession } from '../domain/session';
import { documentPosition } from '../domain/session';
import { decode, makeIndex, mapPath, movedSnapshot, newNotePath, oldIndex, resolveNote, rewriteLinks, wikiLink, type Catalog, type NoteIndex, type Operation, type PathMove, type ReferenceHit } from '../domain/note-links';
import { childFolderPath, childNotePath, noteMoveTarget } from '../domain/note-folders';
import { canOpenMaterial, location, materialCatalog, materialLink, newMaterialPath, readMaterial, rewriteMaterialLinks, writeMaterial, type Material, type MaterialInsertion, type MaterialProperties } from '../domain/materials';

export interface Tab { id: string; pinned: boolean }
export interface Pane { tabs: Tab[]; active: string | null }
export interface Workspace {
  vault: VaultSnapshot | null;
  catalog: Catalog | null;
  documents: Record<string, OpenDocument>;
  panes: [Pane, Pane];
  activePane: 0 | 1;
  split: boolean;
  outline: boolean;
  sidebar: boolean;
  views: [Record<string, EditorPosition>, Record<string, EditorPosition>];
  busy: boolean;
  closing: boolean;
  inspector: 'outline' | 'backlinks';
  missingLink: { target: string; sourcePath: string; pane: 0 | 1; newTab: boolean } | null;
  selectionText: string;
  annotationOpen: boolean;
  materialOpen: boolean;
  error: string | null;
  jump: { id: string; anchor: number; sequence: number } | null;
}
const initial = (): Workspace => ({ vault: null, catalog: null, documents: {}, panes: [{ tabs: [], active: null }, { tabs: [], active: null }], activePane: 0, split: false, outline: true, sidebar: true, views: [{}, {}], busy: false, closing: false, inspector: 'backlinks', missingLink: null, selectionText: '', annotationOpen: false, materialOpen: false, error: null, jump: null });
export const useWorkspace = create<Workspace>(initial);
const store = useWorkspace;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class WorkspaceController {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: SaveQueue;
  private sessionQueue: SaveQueue;
  private sessionTimer?: ReturnType<typeof setTimeout>;
  private startup?: Promise<void>;
  private generation = 0;
  private externalTimer?: ReturnType<typeof setTimeout>;
  private cachedIndex?: { catalog: Catalog | null; documents: Workspace['documents']; vault: VaultSnapshot | null; index: NoteIndex };
  index(): NoteIndex {
    const state = store.getState(), cached = this.cachedIndex;
    if (cached && cached.catalog === state.catalog && cached.documents === state.documents && cached.vault === state.vault) return cached.index;
    const index = state.vault ? makeIndex(state.vault, state.catalog?.files ?? [], state.documents) : { files: new Map(), targets: [] };
    this.cachedIndex = { catalog: state.catalog, documents: state.documents, vault: state.vault, index }; return index;
  }
  constructor(private api: DesktopApi) {
    this.queue = new SaveQueue(id => this.persist(id));
    this.sessionQueue = new SaveQueue(() => this.persistSession());
  }
  start() {
    const unsubscribe = store.subscribe((state, before) => {
      if (!state.vault || state.busy || state.closing) return;
      if (state.panes !== before.panes || state.views !== before.views || state.activePane !== before.activePane || state.split !== before.split || state.outline !== before.outline || state.sidebar !== before.sidebar || state.inspector !== before.inspector) {
        clearTimeout(this.sessionTimer);
        this.sessionTimer = setTimeout(() => { void this.sessionQueue.run('workspace').catch(() => {}); }, 500);
      }
    });
    return () => { unsubscribe(); clearTimeout(this.sessionTimer); clearTimeout(this.externalTimer); };
  }
  requestExternalRefresh() {
    clearTimeout(this.externalTimer);
    this.externalTimer = setTimeout(() => { void this.checkExternal(); }, 350);
  }
  private async checkExternal() {
    const state = store.getState(); if (!state.catalog || state.closing) return;
    if (state.busy || state.annotationOpen || state.materialOpen || Object.values(state.documents).some(document => document.files.some(isDirty))) { this.requestExternalRefresh(); return; }
    try {
      const generation = this.generation, fresh = await this.api.readCatalog();
      if (generation !== this.generation || store.getState().busy || store.getState().closing) return;
      const signature = (catalog: Catalog) => JSON.stringify({ files: catalog.files.map(file => [file.path, file.revision]).sort(), themes: catalog.snapshot.themes.map(theme => theme.path).sort(), folders: catalog.snapshot.noteFolders ?? [] });
      if (fresh.moves.length || signature(fresh) !== signature(store.getState().catalog!)) await this.refresh();
    } catch (error) { store.setState({ error: `外部変更を読み込めませんでした。\n${message(error)}` }); }
  }
  resume(): Promise<void> {
    return this.startup ??= (async () => {
      try { const root = localStorage.getItem('lamina.lastVault'); if (root) await this.openVault(root); }
      catch (error) { store.setState({ error: message(error) }); }
    })();
  }
  private session(): WorkspaceSession {
    const state = store.getState();
    return { version: 1, activePane: state.activePane, split: state.split, outline: state.outline, sidebar: state.sidebar, inspector: state.inspector,
      panes: state.panes.map((pane, index) => ({ active: pane.active, tabs: pane.tabs.flatMap(tab => {
        const document = state.documents[tab.id];
        return document ? [{ ...tab, kind: document.kind, view: state.views[index][tab.id] }] : [];
      }) })) as WorkspaceSession['panes'] };
  }
  private async persistSession() {
    if (!store.getState().vault) return;
    try { await this.api.saveWorkspace(this.session()); }
    catch (error) { store.setState({ error: `.lamina/workspace.json を保存できませんでした。\n${message(error)}` }); throw error; }
  }
  captureView(pane: 0 | 1, id: string, position: EditorPosition) {
    store.setState(state => {
      if (!state.documents[id] || JSON.stringify(state.views[pane][id]) === JSON.stringify(position)) return state;
      const views = [...state.views] as Workspace['views'];
      views[pane] = { ...views[pane], [id]: position };
      const document = state.documents[id];
      const from = documentPosition(document.files, position.anchor), to = documentPosition(document.files, position.head);
      return { views, ...(pane === state.activePane ? { selectionText: compose(document.files).text.slice(Math.min(from, to), Math.max(from, to)) } : {}) };
    });
  }
  private async persist(id: string) {
    const snapshot = store.getState().documents[id];
    if (!snapshot) return;
    for (const file of snapshot.files.filter(isDirty)) {
      try {
        const saved = await this.api.saveFile(file.path, serializeFile(file), file.revision);
        store.setState(state => {
          const latest = state.documents[id];
          if (!latest) return state;
          return { catalog: state.catalog ? { ...state.catalog, files: [...state.catalog.files.filter(f => f.path !== saved.path), saved] } : null, documents: { ...state.documents, [id]: { ...latest, files: latest.files.map(f => f.path === file.path ? { ...f, revision: saved.revision, savedContent: fromDisk(saved).content } : f) } } };
        });
      } catch (error) {
        store.setState({ error: `${file.path} を保存できませんでした。\n${message(error)}` });
        throw error;
      }
    }
  }
  schedule(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      void this.queue.run(id).catch(() => {});
    }, 500));
  }
  private async flushDocuments(): Promise<void> {
    clearTimeout(this.sessionTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const ids = Object.keys(store.getState().documents);
    await Promise.all(ids.map(id => this.queue.run(id)));
    // Edits made while a save was running must also finish before switching vaults.
    if (Object.values(store.getState().documents).some(d => d.files.some(isDirty))) return this.flushDocuments();
  }
  async flush(): Promise<void> {
    await this.flushDocuments();
    try { if (store.getState().catalog) {
      const catalog = await this.api.readCatalog();
      if (!catalog.moves.length) {
        const next = await this.api.applyOperation({ writes: [], guards: catalog.files.map(file => ({ path: file.path, revision: file.revision })) });
        store.setState({ catalog: next });
      }
    } } catch (error) { store.setState({ error: `保管庫の管理情報を保存できませんでした。\n${message(error)}` }); throw error; }
    await this.sessionQueue.run('workspace');
    store.setState({ error: null });
  }
  async close(exit: () => Promise<void>) {
    if (store.getState().materialOpen) { store.setState({ error: '資料の登録・編集を完了またはキャンセルしてから終了してください。' }); return; }
    if (store.getState().annotationOpen) { store.setState({ error: '画像の注釈を完了またはキャンセルしてから終了してください。' }); return; }
    if (store.getState().closing || store.getState().busy) return;
    store.setState({ closing: true });
    try { await this.flush(); await exit(); }
    catch (error) {
      store.setState({ closing: false });
      if (!store.getState().error) store.setState({ error: `終了処理を完了できませんでした。\n${message(error)}` });
    }
  }
  async openWebLink(url: string) {
    if (store.getState().closing || store.getState().busy) return;
    try { await this.api.openWebLink(url); }
    catch (error) { store.setState({ error: `リンク先を開けませんでした。\n${message(error)}` }); }
  }
  async openResource(path: string) {
    if (store.getState().closing || store.getState().busy) return;
    try { const value = canOpenMaterial(path); await this.api.openResource(value.path); }
    catch (error) { store.setState({ error: `資料を開けませんでした。\n${message(error)}` }); }
  }
  materials() { return materialCatalog(this.index()); }
  openMaterials(pane: 0 | 1 = store.getState().activePane) { this.attach({ id: '@materials', label: '資料一覧', kind: 'materials', files: [] }, pane, true); }
  async saveMaterial(value: MaterialProperties, original?: Material, insertion?: MaterialInsertion, merge?: Material, body?: string) {
    return this.change((_catalog, index) => {
      const materials = materialCatalog(index);
      if (materials.errors.length) throw new Error('読み込めない資料ページがあります。資料一覧で確認・修正してから登録してください。');
      const fresh = original ? index.files.get(original.file.path) : undefined;
      if (original && (!fresh || fresh.content !== original.file.content)) throw new Error('資料ページが変更されています。閉じてから開き直してください。');
      const other = merge ? index.files.get(merge.file.path) : undefined;
      if (merge && (!other || other.content !== merge.file.content)) throw new Error('統合元の資料が変更されています。開き直してください。');
      const key = location(value.path).key;
      if (materials.materials.some(item => item.file.path !== original?.file.path && item.file.path !== merge?.file.path && location(item.path).key === key)) throw new Error('同じパスの資料が登録されています。資料一覧で既存資料を編集するか、2件を選択して統合してください。');
      const path = original?.file.path ?? newMaterialPath(value.title, index.files.keys());
      const writes = new Map(rewriteMaterialLinks(index, [original?.path, merge?.path].filter((path): path is string => !!path), value.path).map(write => [write.path, write]));
      const moves = merge ? [{ from: merge.file.path, to: path }] : [];
      const after = merge ? makeIndex({ ..._catalog.snapshot, materials: (_catalog.snapshot.materials ?? []).filter(item => item.path !== merge.file.path) }, _catalog.files) : index;
      if (merge) for (const write of rewriteLinks(index, after, moves, index.files)) {
        const existing = writes.get(write.path);
        const updated = existing ? rewriteLinks(index, after, moves, new Map([[write.path, { ...index.files.get(write.path)!, content: fromDisk({ ...existing, revision: existing.expectedRevision ?? '' }).content }]]))[0] : write;
        if (updated) writes.set(write.path, updated);
      }
      const current = fresh ? readMaterial(fresh) : undefined;
      let content = writeMaterial(value, current, body);
      if (merge) content = fromDisk({ ...(rewriteLinks(index, after, moves, new Map([[path, { ...(fresh ?? fromDisk({ path, content, revision: '' })), content }]]))[0] ?? { path, content }), revision: fresh?.revision ?? '' }).content;
      const temporary = fromDisk({ path, content, revision: fresh?.revision ?? '' });
      const rewritten = rewriteMaterialLinks({ ...index, files: new Map([[path, temporary]]) }, [original?.path, merge?.path].filter((path): path is string => !!path), value.path)[0];
      if (rewritten) content = fromDisk({ ...rewritten, revision: fresh?.revision ?? '' }).content;
      writes.set(path, { path, content: fresh ? serializeFile({ ...fresh, content }) : content, expectedRevision: fresh?.revision ?? null });
      if (merge) writes.delete(merge.file.path);
      let committed: (() => void) | undefined;
      if (insertion) {
        const source = index.files.get(insertion.sourcePath);
        if (!source || source.content !== insertion.expectedContent || insertion.to > source.content.length) throw new Error('挿入先の本文が変更されています。貼り付け直してください。');
        const insert = materialLink(value.title, value.path);
        const changed = source.content.slice(0, insertion.from) + insert + source.content.slice(insertion.to);
        if (writes.has(source.path)) throw new Error('編集している資料自身への登録は、別のノートで行ってください。');
        writes.set(source.path, { path: source.path, content: serializeFile({ ...source, content: changed }), expectedRevision: source.revision });
        committed = () => insertion.apply({ from: insertion.from, to: insertion.to, insert });
      }
      return { operation: { writes: [...writes.values()], guards: [], ...(merge && other ? { deletes: [{ path: merge.file.path, revision: other.revision! }] } : {}) }, committed, moves };
    });
  }
  async openInternalLink(target: string, sourcePath: string, pane: 0 | 1 = store.getState().activePane, newTab = false, syntax: 'wiki' | 'markdown' = 'wiki') {
    const resolved = resolveNote(this.index(), target, sourcePath, syntax);
    if (resolved.ambiguous) { store.setState({ error: '同名のノートが複数あります。[[ からパス付きの候補を選んでください。' }); return; }
    if (!resolved.target) { store.setState(syntax === 'markdown' ? { error: `リンク先が見つかりませんでした: ${target}` } : { missingLink: { target, sourcePath, pane, newTab } }); return; }
    if (resolved.missingHeading) { store.setState({ error: `見出し「${resolved.fragment}」が見つかりませんでした。` }); return; }
    if (resolved.target.kind === 'theme') {
      const theme = store.getState().vault?.themes.find(theme => theme.path === resolved.target!.id);
      if (theme) await this.openTheme(theme, pane, newTab);
    } else await this.openNote(resolved.target.id, pane, newTab);
    if (resolved.path) this.jumpTo(resolved.target.id, resolved.path, resolved.offset, pane);
  }
  private jumpTo(id: string, path: string, offset: number, pane: 0 | 1) {
    const document = store.getState().documents[id]; if (!document) return;
    const segment = compose(document.files).segments.find(segment => segment.path === path);
    if (segment) store.setState(state => ({ activePane: pane, jump: { id, anchor: segment.from + offset, sequence: (state.jump?.sequence ?? 0) + 1 } }));
  }
  async openHit(hit: ReferenceHit, pane: 0 | 1 = store.getState().activePane, newTab = false) {
    if (hit.source.kind === 'theme') {
      const theme = store.getState().vault?.themes.find(theme => theme.path === hit.source.id);
      if (theme) await this.openTheme(theme, pane, newTab);
    } else await this.openNote(hit.source.id, pane, newTab);
    this.jumpTo(hit.source.id, hit.path, hit.from, pane);
  }
  private async change(build: (catalog: Catalog, index: NoteIndex) => { operation: Operation; moves?: PathMove[]; committed?: () => void }): Promise<boolean> {
    if (store.getState().busy || store.getState().closing) return false;
    store.setState({ busy: true }); this.generation++;
    try {
      await this.flushDocuments();
      const read = await this.api.readCatalog(), catalog = await this.repairCatalog(read);
      if (read.moves.length) this.installCatalog(catalog, read.moves);
      const { operation, moves = [], committed } = build(catalog, makeIndex(catalog.snapshot, catalog.files));
      operation.guards = catalog.files.map(file => ({ path: file.path, revision: file.revision }));
      const result = await this.api.applyOperation(operation);
      committed?.();
      this.installCatalog(result, moves);
      await this.sessionQueue.run('workspace');
      store.setState({ error: null }); return true;
    } catch (error) { store.setState({ error: message(error) }); return false; }
    finally { store.setState({ busy: false }); }
  }
  async createLinkedNote(target: string, sourcePath: string, pane: 0 | 1, newTab = false) {
    let path: string;
    try { path = newNotePath(target, sourcePath); } catch (error) { store.setState({ error: message(error) }); return false; }
    const fragment = decode(target.split('#').slice(1).join('#'));
    const ok = await this.change(() => ({ operation: { writes: [{ path, content: fragment ? `# ${fragment}\n\n` : '', expectedRevision: null }], guards: [] } }));
    if (ok) { store.setState({ missingLink: null }); await this.openNote(path, pane, newTab); }
    return ok;
  }
  async relocate(source: string, destination: string) {
    return this.change((catalog, before) => this.relocation(catalog, before, source, destination));
  }
  private relocation(catalog: Catalog, before: NoteIndex, source: string, destination: string) {
    const moves = [{ from: source, to: destination }], snapshot = movedSnapshot(catalog.snapshot, moves);
    const after = makeIndex(snapshot, catalog.files.map(file => ({ ...file, path: mapPath(file.path, moves) })));
    const writes = new Map(rewriteLinks(before, after, moves, before.files).map(write => [write.path, write]));
    const renamed = catalog.snapshot.themes.map(theme => ({ before: theme.name, after: mapPath(theme.path, moves).split('/').at(-1)! })).filter(theme => theme.before !== theme.after);
    if (renamed.length) for (const material of materialCatalog(before).materials) {
      const themes = [...new Set(material.themes.map(name => renamed.find(theme => theme.before === name)?.after ?? name))];
      if (JSON.stringify(themes) === JSON.stringify(material.themes)) continue;
      const previous = writes.get(material.file.path);
      const current = previous ? readMaterial(fromDisk({ ...previous, revision: material.file.revision! })) : material;
      writes.set(material.file.path, { path: material.file.path, content: serializeFile({ ...material.file, content: writeMaterial({ ...current, themes }, current) }), expectedRevision: material.file.revision });
    }
    return { moves, operation: { relocation: moves[0], writes: [...writes.values()], guards: [] } };
  }
  async moveNoteToFolder(source: string, folder: string) {
    const destination = noteMoveTarget(source, folder); if (!destination) return false;
    return this.change((catalog, before) => {
      if (folder !== 'メモ' && !catalog.snapshot.noteFolders?.includes(folder)) throw new Error('移動先のフォルダーがありません。再読み込みしてから操作してください。');
      if (!catalog.snapshot.notes.some(note => note.path === source) && !catalog.snapshot.noteFolders?.includes(source)) throw new Error('移動するメモまたはフォルダーがありません。');
      return this.relocation(catalog, before, source, destination);
    });
  }
  async createNoteInFolder(folder: string, title: string) {
    let path: string;
    try { path = childNotePath(folder, title); } catch (error) { store.setState({ error: message(error) }); return false; }
    const pane = store.getState().activePane;
    const ok = await this.change(catalog => {
      if (folder !== 'メモ' && !catalog.snapshot.noteFolders?.includes(folder)) throw new Error('作成先のフォルダーがありません。');
      return { operation: { writes: [{ path, content: '', expectedRevision: null }], guards: [] } };
    });
    if (ok) await this.openNote(path, pane, true);
    return ok;
  }
  async createFolder(path: string) { return this.change(() => ({ operation: { folders: [path], writes: [], guards: [] } })); }
  async createChildFolder(parent: string, name: string) {
    let path: string;
    try { path = childFolderPath(parent, name); } catch (error) { store.setState({ error: message(error) }); return false; }
    return this.change(catalog => {
      if (parent !== 'メモ' && !catalog.snapshot.noteFolders?.includes(parent)) throw new Error('作成先のフォルダーがありません。');
      return { operation: { folders: [path], writes: [], guards: [] } };
    });
  }
  async extractSelection(name: string) {
    const state = store.getState(), pane = state.activePane, id = state.panes[pane].active;
    const document = id ? state.documents[id] : null, selection = id ? state.views[pane][id] : null;
    if (!document || !selection) return false;
    const from = documentPosition(document.files, selection.anchor), to = documentPosition(document.files, selection.head);
    const start = Math.min(from, to), end = Math.max(from, to), text = compose(document.files).text.slice(start, end);
    if (!text.trim()) { store.setState({ error: '本文で切り出す範囲を選択してください。' }); return false; }
    let path: string;
    try { path = newNotePath(name); } catch (error) { store.setState({ error: message(error) }); return false; }
    return this.change((_catalog, index) => {
      if (document.files.some(file => index.files.get(file.path)?.content !== file.content)) throw new Error('選択した本文が変更されています。選び直してから切り出してください。');
      const target = { id: path, name: path.split('/').at(-1)!.replace(/\.md$/i, ''), kind: 'note' as const, files: [path] };
      const link = wikiLink({ ...index, targets: [...index.targets, target] }, target);
      const changed = applyChanges(document.files, [{ from: start, to: end, insert: link }]);
      return { operation: { guards: [], writes: [
        ...changed.filter((file, i) => file.content !== document.files[i].content).map(file => ({ path: file.path, content: serializeFile(file), expectedRevision: index.files.get(file.path)!.revision })),
        { path, content: text, expectedRevision: null },
      ] } };
    });
  }
  async openVault(root: string, initialize = false) {
    if (store.getState().busy || store.getState().closing) return;
    store.setState({ busy: true });
    this.generation++;
    try {
      await this.flush();
      const vault = await this.api.openVault(root, initialize);
      store.setState({ ...initial(), vault, busy: true });
      localStorage.setItem('lamina.lastVault', vault.root);
      const read = await this.api.readCatalog();
      const catalog = await this.repairCatalog(read);
      store.setState({ catalog, vault: catalog.snapshot });
      try { await this.restore(catalog.snapshot, read.moves); }
      catch (error) { store.setState({ error: `画面状態を復元できませんでした。\n${message(error)}` }); }
      if (read.warnings.length) store.setState({ error: read.warnings.join('\n') });
      try { await this.api.watchVault(); } catch (error) { store.setState({ error: `外部変更の監視を開始できませんでした。再読み込みボタンも利用できます。\n${message(error)}` }); }
    } catch (error) { store.setState({ error: message(error) }); }
    finally { store.setState({ busy: false }); }
  }
  private async repairCatalog(catalog: Catalog): Promise<Catalog> {
    const index = makeIndex(catalog.snapshot, catalog.files);
    const writes = catalog.moves.length ? rewriteLinks(oldIndex(catalog), index, catalog.moves, index.files, true) : [];
    return this.api.applyOperation({ writes, guards: catalog.files.map(file => ({ path: file.path, revision: file.revision })), acceptMoves: true });
  }
  private installCatalog(catalog: Catalog, moves: PathMove[] = []) {
    const state = store.getState(), index = makeIndex(catalog.snapshot, catalog.files);
    const documents: Workspace['documents'] = {}, views: Workspace['views'] = [{}, {}];
    for (const document of Object.values(state.documents)) {
      if (document.kind === 'materials') { documents[document.id] = document; continue; }
      const id = mapPath(document.id, moves), target = index.targets.find(target => target.id === id);
      if (target) documents[id] = { id, label: target.name, kind: target.kind, files: target.files.flatMap(path => index.files.has(path) ? [index.files.get(path)!] : []) };
    }
    for (const pane of [0, 1] as const) for (const [id, view] of Object.entries(state.views[pane])) views[pane][mapPath(id, moves)] = { ...view, anchor: { ...view.anchor, path: mapPath(view.anchor.path, moves) }, head: { ...view.head, path: mapPath(view.head.path, moves) } };
    const panes = state.panes.map(pane => {
      const tabs = pane.tabs.map(tab => ({ ...tab, id: mapPath(tab.id, moves) })).filter((tab, index, all) => documents[tab.id] && all.findIndex(other => other.id === tab.id) === index);
      const active = pane.active ? mapPath(pane.active, moves) : null;
      return { tabs, active: tabs.some(tab => tab.id === active) ? active : tabs.at(-1)?.id ?? null };
    }) as Workspace['panes'];
    store.setState({ vault: catalog.snapshot, catalog, documents, panes, views, selectionText: '', jump: null });
  }
  async refresh() {
    if (store.getState().annotationOpen || store.getState().materialOpen) return;
    if (!store.getState().vault || store.getState().busy || store.getState().closing) return;
    store.setState({ busy: true });
    try {
      await this.flushDocuments();
      const catalog = await this.api.readCatalog();
      this.installCatalog(await this.repairCatalog(catalog), catalog.moves);
      await this.sessionQueue.run('workspace');
      store.setState({ error: catalog.warnings.join('\n') || null });
    } catch (error) { store.setState({ error: message(error) }); }
    finally { store.setState({ busy: false }); }
  }
  private async restore(vault: VaultSnapshot, moves: PathMove[] = []) {
    const session = readSession(await this.api.readWorkspace());
    if (!session) return;
    for (const pane of session.panes) {
      if (pane.active) pane.active = mapPath(pane.active, moves);
      for (const tab of pane.tabs) { tab.id = mapPath(tab.id, moves); if (tab.view) { tab.view.anchor.path = mapPath(tab.view.anchor.path, moves); tab.view.head.path = mapPath(tab.view.head.path, moves); } }
    }
    const documents: Workspace['documents'] = {};
    const views: Workspace['views'] = [{}, {}];
    const missing = new Set<string>();
    const notes = new Set([...vault.notes, ...(vault.materials ?? [])].map(note => note.path));
    for (const [index, pane] of session.panes.entries()) {
      for (const tab of pane.tabs) {
        try {
          if (!documents[tab.id]) {
            if (tab.kind === 'materials' && tab.id === '@materials') { documents[tab.id] = { id: tab.id, label: '資料一覧', kind: 'materials', files: [] }; continue; }
            const theme = tab.kind === 'theme' ? vault.themes.find(theme => theme.path === tab.id) : null;
            if (tab.kind === 'theme' && !theme || (tab.kind === 'note' || tab.kind === 'material') && !notes.has(tab.id)) throw new Error('参照先がありません');
            documents[tab.id] = theme
              ? { id: theme.path, label: theme.name, kind: 'theme', files: await Promise.all(theme.files.map(async file => fromDisk(await this.api.readFile(file.path)))) }
              : { id: tab.id, label: tab.id.split('/').at(-1)!.replace(/\.md$/i, ''), kind: tab.kind === 'material' ? 'material' : 'note', files: [fromDisk(await this.api.readFile(tab.id))] };
          }
          if (tab.view) views[index][tab.id] = tab.view;
        } catch { missing.add(tab.id); }
      }
    }
    const panes = session.panes.map(pane => {
      const tabs = pane.tabs.filter(tab => documents[tab.id]).map(({ id, pinned }) => ({ id, pinned }));
      return { tabs, active: tabs.some(tab => tab.id === pane.active) ? pane.active : tabs[0]?.id ?? null };
    }) as Workspace['panes'];
    store.setState({ documents, views, panes, split: session.split, activePane: session.activePane, outline: session.outline, sidebar: session.sidebar, inspector: session.inspector ?? 'backlinks',
      ...(missing.size ? { error: `次のタブを復元できませんでした。ファイルの移動・削除やアクセス権を確認してください。\n${[...missing].join('\n')}` } : {}) });
  }
  private attach(document: OpenDocument, pane: 0 | 1, newTab = false) {
    store.setState(state => {
      const group = state.panes[pane];
      let tabs = [...group.tabs];
      if (!tabs.some(t => t.id === document.id)) {
        const active = tabs.findIndex(t => t.id === group.active);
        if (!newTab && active >= 0 && !tabs[active].pinned) tabs[active] = { id: document.id, pinned: false };
        else tabs.push({ id: document.id, pinned: false });
      }
      const panes = [...state.panes] as Workspace['panes'];
      panes[pane] = { tabs, active: document.id };
      return { documents: { ...state.documents, [document.id]: state.documents[document.id] ?? document }, panes, activePane: pane, split: state.split || pane === 1 };
    });
  }
  async openTheme(theme: ThemeEntry, pane: 0 | 1 = store.getState().activePane, newTab = false) {
    if (store.getState().busy || store.getState().closing) return;
    const generation = this.generation;
    try {
      let document = store.getState().documents[theme.path];
      if (!document) document = { id: theme.path, label: theme.name, kind: 'theme', files: await Promise.all(theme.files.map(async f => fromDisk(await this.api.readFile(f.path)))) };
      if (generation === this.generation) this.attach(document, pane, newTab);
    } catch (error) { store.setState({ error: message(error) }); }
  }
  async openNote(path: string, pane: 0 | 1 = store.getState().activePane, newTab = false) {
    if (store.getState().busy || store.getState().closing) return;
    const generation = this.generation;
    try {
      const document = store.getState().documents[path] ?? { id: path, label: path.split('/').at(-1)!.replace(/\.md$/i, ''), kind: path.startsWith('資料/') ? 'material' as const : 'note' as const, files: [fromDisk(await this.api.readFile(path))] };
      if (generation === this.generation) this.attach(document, pane, newTab);
    } catch (error) { store.setState({ error: message(error) }); }
  }
  edit(id: string, changes: TextChange[]) {
    if (store.getState().closing || store.getState().busy) return;
    const document = store.getState().documents[id];
    if (!document) return;
    store.setState(state => ({ documents: { ...state.documents, [id]: { ...document, files: applyChanges(document.files, changes) } } }));
    this.schedule(id);
  }
  today(id: string) {
    if (store.getState().closing || store.getState().busy) return;
    const original = store.getState().documents[id];
    if (!original) return;
    const { document, anchor } = ensureToday(original);
    store.setState(state => ({ documents: { ...state.documents, [id]: document }, jump: { id, anchor, sequence: (state.jump?.sequence ?? 0) + 1 } }));
    this.schedule(id);
  }
  async create(kind: 'theme' | 'note', name: string) {
    if (store.getState().closing || store.getState().busy) return false;
    try {
      if (kind === 'theme') {
        const vault = await this.api.createTheme(name);
        store.setState({ vault });
        const theme = vault.themes.find(t => t.name === name)!;
        await this.openTheme(theme, store.getState().activePane, true);
        this.today(theme.path);
      } else {
        const disk = await this.api.createNote(name);
        const vault = await this.api.openVault(store.getState().vault!.root, false);
        store.setState({ vault });
        this.attach({ id: disk.path, label: name, kind: 'note', files: [fromDisk(disk)] }, store.getState().activePane, true);
      }
      const catalog = await this.api.readCatalog();
      store.setState({ catalog, vault: catalog.snapshot });
      return true;
    } catch (error) { store.setState({ error: message(error) }); return false; }
  }
  async closeTab(pane: 0 | 1, id: string) {
    if (store.getState().closing || store.getState().busy) return;
    const generation = this.generation;
    try {
      do { await this.queue.run(id); } while (store.getState().documents[id]?.files.some(isDirty));
      if (generation !== this.generation) return;
      store.setState(state => {
        const group = state.panes[pane], tabs = group.tabs.filter(t => t.id !== id);
        const panes = [...state.panes] as Workspace['panes'];
        panes[pane] = { tabs, active: group.active === id ? tabs.at(-1)?.id ?? null : group.active };
        return { panes, ...(pane === 1 && tabs.length === 0 ? { split: false, activePane: 0 as const } : {}) };
      });
    } catch { /* The save error remains visible and the tab stays open. */ }
  }
  activate(pane: 0 | 1, id?: string) {
    if (store.getState().closing || store.getState().busy) return;
    store.setState(state => {
      const panes = [...state.panes] as Workspace['panes'];
      if (id) panes[pane] = { ...panes[pane], active: id };
      return { activePane: pane, panes };
    });
  }
  togglePin(pane: 0 | 1, id: string) {
    if (store.getState().closing || store.getState().busy) return;
    store.setState(state => {
      const panes = [...state.panes] as Workspace['panes'];
      panes[pane] = { ...panes[pane], tabs: panes[pane].tabs.map(t => t.id === id ? { ...t, pinned: !t.pinned } : t) };
      return { panes };
    });
  }
  toggleSplit() {
    if (store.getState().closing || store.getState().busy) return;
    const state = store.getState();
    if (!state.split && !state.panes[1].active && state.panes[0].active) this.attach(state.documents[state.panes[0].active], 1, true);
    else store.setState({ split: !state.split, activePane: state.split ? 0 : state.activePane });
  }
}
export const workspace = new WorkspaceController(desktop);
