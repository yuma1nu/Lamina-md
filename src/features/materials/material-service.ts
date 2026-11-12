import { create } from 'zustand';
import { Annotation } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspace, workspace } from '../../app/workspace';
import { frontmatter, location, materialDraft, type Material, type MaterialInsertion, type MaterialProperties } from '../../domain/materials';
import { stringify } from 'yaml';

export const materialCommitted = Annotation.define<boolean>();
export interface MaterialRequest { value: MaterialProperties; original?: Material; insertion?: MaterialInsertion; merge?: Material; body?: string; done?: () => void; inspection?: Promise<{ folder: boolean }> }
export const useMaterialDialog = create<{ request: MaterialRequest | null }>(() => ({ request: null }));
export const resourceApi = {
  inspect: (path: string) => invoke<{ title: string; folder: boolean; exists: boolean }>('inspect_resource', { path }),
  clipboard: () => invoke<{ paths: string[]; title: string | null; text: string | null }>('read_resource_clipboard'),
  image: (path: string) => invoke<{ name: string; mime: string; data: string }>('read_dropped_image', { path }),
};
export function materialError(error: unknown) { useWorkspace.setState({ error: `資料を処理できませんでした。\n${error instanceof Error ? error.message : String(error)}` }); }
function show(request: MaterialRequest) {
  if (useWorkspace.getState().busy || useWorkspace.getState().closing || useWorkspace.getState().materialOpen) return false;
  useWorkspace.setState({ materialOpen: true }); useMaterialDialog.setState({ request }); return true;
}
export function closeMaterialDialog() {
  const request = useMaterialDialog.getState().request;
  useMaterialDialog.setState({ request: null }); useWorkspace.setState({ materialOpen: false }); request?.done?.();
}
export function requestMaterial(path = '', insertion?: MaterialInsertion, filename?: string, done?: () => void) {
  try {
    const target = path ? location(path) : null;
    const original = target ? workspace.materials().materials.find(item => location(item.path).key === target.key) : undefined;
    const document = insertion && useWorkspace.getState().documents[insertion.documentId];
    const theme = document && document.kind === 'theme' ? document.label : undefined;
    const value = original ? { title: original.title, type: original.type, path: original.path, added: original.added, memo: original.memo, themes: [...new Set([...original.themes, ...(theme ? [theme] : [])])] } : target ? materialDraft(path, theme, filename) : { title: '', type: 'file', path: '', added: new Date().toLocaleDateString('sv-SE'), memo: '', themes: [] };
    const inspection = target && !target.web && !original ? resourceApi.inspect(target.path).catch(() => ({ folder: false })) : undefined;
    show({ value, original, insertion, done, inspection });
  } catch (error) { materialError(error); }
}
export function editMaterial(material: Material, done?: () => void) {
  show({ original: material, value: { title: material.title, type: material.type, path: material.path, added: material.added, memo: material.memo, themes: [...material.themes] }, done });
}
export function mergeMaterials(first: Material, second: Material) {
  const memo = first.memo === second.memo ? first.memo : [first.memo, second.memo].filter(Boolean).join('\n\n');
  const details = first.body === second.body ? first.body : first.body + `\n\n## ${second.title} から統合\n\n` + second.body;
  const known = new Set(['title', 'type', 'path', 'added', 'memo', 'themes']);
  const extra = Object.fromEntries(Object.entries(frontmatter(second.file.content).yaml.toJS() as Record<string, unknown>).filter(([key]) => !known.has(key)));
  const body = details + (Object.keys(extra).length ? '\n\n### 統合元の追加プロパティ\n\n```yaml\n' + stringify(extra) + '```\n' : '');
  show({ original: first, merge: second, value: { title: first.title, type: first.type, path: first.path, added: [first.added, second.added].sort()[0], memo, themes: [...new Set([...first.themes, ...second.themes])] }, body });
}
