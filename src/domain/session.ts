import { compose, type SourceFile } from './documents';

export interface FilePosition { path: string; offset: number }
export interface EditorPosition { anchor: FilePosition; head: FilePosition; scrollTop: number; folds?: { from: FilePosition; to: FilePosition }[] }
export interface SessionTab { id: string; kind: 'theme' | 'note' | 'material' | 'materials'; pinned: boolean; view?: EditorPosition }
export interface SessionPane { tabs: SessionTab[]; active: string | null }
export interface WorkspaceSession {
  version: 1;
  panes: [SessionPane, SessionPane];
  activePane: 0 | 1;
  split: boolean;
  outline: boolean;
  sidebar: boolean;
  inspector?: 'outline' | 'backlinks';
}

export function filePosition(files: SourceFile[], position: number): FilePosition {
  const { segments } = compose(files);
  const segment = segments.find(s => position >= s.from && position <= s.to)
    ?? segments.find(s => s.from > position) ?? segments.at(-1);
  return segment ? { path: segment.path, offset: Math.max(0, Math.min(position - segment.from, segment.to - segment.from)) } : { path: '', offset: 0 };
}

export function documentPosition(files: SourceFile[], position: FilePosition): number {
  const segment = compose(files).segments.find(s => s.path === position.path);
  return segment ? segment.from + Math.min(position.offset, segment.to - segment.from) : 0;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function position(value: unknown): value is FilePosition {
  return record(value) && typeof value.path === 'string' && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0;
}
function editorPosition(value: unknown): value is EditorPosition {
  return record(value) && position(value.anchor) && position(value.head) && typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop) && value.scrollTop >= 0;
}

export function readSession(value: unknown): WorkspaceSession | null {
  if (value === null) return null;
  if (!record(value) || value.version !== 1 || !Array.isArray(value.panes) || value.panes.length !== 2) throw new Error('画面状態の形式を読み込めませんでした。ノート本文は変更していません。');
  const panes = value.panes.map(pane => {
    if (!record(pane) || !Array.isArray(pane.tabs)) throw new Error('保存されたタブの情報を読み込めませんでした。');
    const tabs: SessionTab[] = [];
    for (const tab of pane.tabs) {
      if (!record(tab) || typeof tab.id !== 'string' || !['theme', 'note', 'material', 'materials'].includes(String(tab.kind)) || tabs.some(t => t.id === tab.id)) continue;
      const view = editorPosition(tab.view) ? { anchor: tab.view.anchor, head: tab.view.head, scrollTop: tab.view.scrollTop, ...(Array.isArray(tab.view.folds) ? { folds: tab.view.folds.filter(fold => record(fold) && position(fold.from) && position(fold.to) && fold.from.path === fold.to.path && fold.to.offset > fold.from.offset) } : {}) } : undefined;
      tabs.push({ id: tab.id, kind: tab.kind as SessionTab['kind'], pinned: tab.pinned === true, ...(view ? { view } : {}) });
    }
    return { tabs, active: tabs.some(t => t.id === pane.active) ? pane.active as string : tabs[0]?.id ?? null };
  }) as WorkspaceSession['panes'];
  return { version: 1, panes, activePane: value.split === true && value.activePane === 1 ? 1 : 0, split: value.split === true, outline: value.outline !== false, sidebar: value.sidebar !== false, inspector: value.inspector === 'outline' ? 'outline' : 'backlinks' };
}
