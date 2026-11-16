import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { DiskFile, VaultSnapshot } from '../domain/documents';
import type { WorkspaceSession } from '../domain/session';
import type { Catalog, Operation } from '../domain/note-links';

export const isDesktop = isTauri;
export interface DesktopApi {
  openVault(root: string, initialize: boolean): Promise<VaultSnapshot>;
  readFile(path: string): Promise<DiskFile>;
  saveFile(path: string, content: string, revision: string | null): Promise<DiskFile>;
  createTheme(name: string): Promise<VaultSnapshot>;
  createNote(name: string): Promise<DiskFile>;
  readWorkspace(): Promise<unknown>;
  saveWorkspace(session: WorkspaceSession): Promise<void>;
  openWebLink(url: string): Promise<void>;
  openResource(path: string): Promise<void>;
  readCatalog(): Promise<Catalog>;
  applyOperation(operation: Operation): Promise<Catalog>;
  trashNote(path: string, revision: string): Promise<Catalog>;
  watchVault(): Promise<void>;
}
export const desktop: DesktopApi = {
  openVault: (root, initialize) => invoke('open_vault', { root, initialize }),
  readFile: path => invoke('read_document', { path }),
  saveFile: (path, content, revision) => invoke('save_document', { path, content, expectedRevision: revision }),
  createTheme: name => invoke('create_theme', { name }),
  createNote: name => invoke('create_note', { name }),
  readWorkspace: () => invoke('read_workspace'),
  saveWorkspace: session => invoke('save_workspace', { session }),
  openWebLink: url => invoke('open_web_link', { url }),
  openResource: path => invoke('open_resource', { path }),
  readCatalog: () => invoke('read_catalog'),
  applyOperation: operation => invoke('apply_operation', { operation }),
  trashNote: (path, revision) => invoke('trash_note', { path, expectedRevision: revision }),
  watchVault: () => invoke('watch_vault'),
};
export async function chooseVault(): Promise<string | null> {
  if (!isDesktop()) throw new Error('保管庫を開くには、Lamina.mdのデスクトップ版を起動してください。');
  return await open({ directory: true, multiple: false, title: 'Lamina.mdの保管庫を選択' });
}
