export interface MaterialsPosition {
  query: string; type: string; theme: string; after: string; before: string;
  sort: 'added' | 'title' | 'type' | 'memo' | 'themes' | 'path'; descending: boolean;
  showPath: boolean; selected: string | null; checked: string[]; scrollTop: number; scrollLeft: number;
}
export interface WorkspacePreferences {
  sidebarWidth: number; inspectorWidth: number; inspectorNarrow: boolean; splitRatio: number;
  collapsedFolders: string[]; materials: [MaterialsPosition, MaterialsPosition];
}
export const materialsPosition = (): MaterialsPosition => ({ query: '', type: '', theme: '', after: '', before: '', sort: 'added', descending: true, showPath: false, selected: null, checked: [], scrollTop: 0, scrollLeft: 0 });
export const workspacePreferences = (): WorkspacePreferences => ({ sidebarWidth: 230, inspectorWidth: 300, inspectorNarrow: false, splitRatio: .5, collapsedFolders: [], materials: [materialsPosition(), materialsPosition()] });
export function readPreferences(value: unknown): WorkspacePreferences {
  const defaults = workspacePreferences();
  if (!value || typeof value !== 'object') return defaults;
  const raw = value as Record<string, unknown>;
  const number = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  defaults.inspectorNarrow = raw.inspectorNarrow === true;
  defaults.sidebarWidth = number(raw.sidebarWidth, 190, 420, defaults.sidebarWidth);
  defaults.inspectorWidth = number(raw.inspectorWidth, 260, 480, defaults.inspectorWidth);
  defaults.splitRatio = number(raw.splitRatio, .25, .75, .5);
  defaults.collapsedFolders = Array.isArray(raw.collapsedFolders) ? raw.collapsedFolders.filter((path): path is string => typeof path === 'string' && path.startsWith('メモ/')) : [];
  for (const pane of [0, 1] as const) {
    const entry = Array.isArray(raw.materials) ? raw.materials[pane] : null;
    if (!entry || typeof entry !== 'object') continue;
    const target = defaults.materials[pane];
    for (const key of ['query', 'type', 'theme', 'after', 'before'] as const) if (typeof entry[key] === 'string') target[key] = entry[key];
    if (['added', 'title', 'type', 'memo', 'themes', 'path'].includes(entry.sort)) target.sort = entry.sort;
    for (const key of ['descending', 'showPath'] as const) if (typeof entry[key] === 'boolean') target[key] = entry[key];
    target.selected = typeof entry.selected === 'string' ? entry.selected : null;
    target.checked = Array.isArray(entry.checked) ? entry.checked.filter((path: unknown) => typeof path === 'string') : [];
    target.scrollTop = number(entry.scrollTop, 0, 1e9, 0); target.scrollLeft = number(entry.scrollLeft, 0, 1e9, 0);
  }
  return defaults;
}
