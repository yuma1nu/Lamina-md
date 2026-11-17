import { expect, type Page } from '@playwright/test';
import type { Operation } from '../../../src/domain/note-links';
import type { ImageFile, ImageWrite } from '../../../src/domain/images';

interface TestFixture {
  useCatalogStamp?: boolean;
  catalogReads?: number;
  stampReads?: number;
  resourceCalls?: { path: string; kind: string | null }[];
  browserUrls?: string[];
  officeFailure?: boolean;
  trash?: Record<string, { content: string; revision: string }>;
  trashFailure?: boolean;
  images: Record<string, ImageFile>;
  files: Record<string, { content: string; revision: string; identity?: string }>;
  failure: boolean;
  sessionFailure: boolean;
  destroyed: number;
  operations: string[];
  holdSave: boolean;
  pendingSaves: number;
  releaseSave?: () => void;
  openedUrls: string[];
  openFailure: boolean;
  operationFailure: boolean;
  folders: string[];
  clipboard?: { paths: string[]; title: string | null; text: string | null };
  resourceFolders?: string[];
  moveOffline: (from: string, to: string) => void;
}
declare global { interface Window { __laminaFixture: TestFixture; __laminaClose: () => Promise<void>; __laminaChanged: () => Promise<void>; __laminaDrop: (paths: string[], x: number, y: number) => Promise<void> } }

// Only this test boundary substitutes IPC. The shipped app has no sample vault
// or in-memory filesystem fallback. These tests do not verify Rust/WebView2.
export async function connectTestVault(page: Page, installClock = true) {
  if (installClock) await page.clock.install({ time: new Date('2026-11-12T01:00:00Z') });
  await page.addInitScript(() => {
    const disk = JSON.parse(localStorage.getItem('lamina.test.disk') ?? 'null') as { files: TestFixture['files']; themes: string[]; counter: number; folders?: string[]; themeIds?: Record<string, string>; images?: Record<string, ImageFile> } | null;
    const files: TestFixture['files'] = disk?.files ?? {
      'テーマ/耐久性評価/2026-10.md': { content: '# 2026-10-31\n\n初回の試験を完了した。\n', revision: 'oct' },
      'テーマ/耐久性評価/2026-11.md': { content: '# 2026-11-11\n\n温度推移を確認した。\n', revision: 'nov' },
      'メモ/試験の手順.md': { content: '## 測定の手順\n\n記録先を確認する。', revision: 'note' },
    };
    for (const [path, file] of Object.entries(files)) file.identity ??= path;
    const themeIds = disk?.themeIds ?? {};
    const fixture: TestFixture & { themes: string[]; counter: number } = { images: disk?.images ?? {}, files, failure: false, sessionFailure: false, themes: disk?.themes ?? ['耐久性評価'], counter: disk?.counter ?? 0, destroyed: 0, operations: [], holdSave: false, pendingSaves: 0, openedUrls: [], openFailure: false, operationFailure: false, folders: disk?.folders ?? [], moveOffline: () => {} };
    const persistDisk = () => localStorage.setItem('lamina.test.disk', JSON.stringify({ files, themes: fixture.themes, counter: fixture.counter, folders: fixture.folders, themeIds, images: fixture.images }));
    const callbacks = new Map<number, (event: unknown) => Promise<void>>();
    const listeners = new Map<number, { event: string; handler: number }>();
    Object.assign(window, { __laminaFixture: fixture, isTauri: true });
    const snapshot = () => ({ root: 'C:/TestVault', name: '技術ノート', noteFolders: fixture.folders, themes: fixture.themes.map(name => ({ path: `テーマ/${name}`, name: name.split('/').at(-1), files: Object.keys(files).filter(path => path.split('/').slice(0, -1).join('/') === `テーマ/${name}`).sort().map(path => ({ path, name: path.split('/').at(-1) })) })), notes: Object.keys(files).filter(path => path.startsWith('メモ/')).map(path => ({ path, name: path.split('/').at(-1) })), materials: Object.keys(files).filter(path => path.startsWith('資料/')).map(path => ({ path, name: path.split('/').at(-1) })) });
    const currentEntries = () => [
      ...Object.keys(files).map(path => ({ path, kind: path.startsWith('メモ/') ? 'note' : 'month', identity: files[path].identity ?? path, signature: files[path].content })),
      ...fixture.themes.map(name => { const path = `テーマ/${name}`; themeIds[path] ??= path; return { path, kind: 'theme', identity: themeIds[path], signature: Object.entries(files).filter(([key]) => key.startsWith(path + '/')).map(([, file]) => file.content).join('\n') }; }),
    ];
    const catalog = () => {
      const current = currentEntries(), previous = JSON.parse(localStorage.getItem('lamina.test.tracking') ?? 'null') as typeof current | null;
      const moves = (previous ?? []).filter(old => !current.some(next => next.path === old.path)).flatMap(old => {
        const matches = current.filter(next => !previous?.some(entry => entry.path === next.path) && next.kind === old.kind && next.path.split('/').at(-1) === old.path.split('/').at(-1) && next.identity === old.identity);
        return matches.length === 1 ? [{ from: old.path, to: matches[0].path }] : [];
      });
      return { ...(fixture.useCatalogStamp ? { stamp: JSON.stringify([Object.entries(files).map(([path, file]) => [path, file.revision]), fixture.folders]) } : {}), snapshot: snapshot(), files: Object.entries(files).map(([path, file]) => ({ ...file, path })), previous: previous ?? current, moves, warnings: [] };
    };
    const rebase = (path: string, from: string, to: string) => path === from || path.startsWith(from + '/') ? to + path.slice(from.length) : path;
    fixture.moveOffline = (from, to) => {
      for (const path of Object.keys(files)) { const next = rebase(path, from, to); if (next !== path) { files[next] = files[path]; delete files[path]; } }
      fixture.themes = fixture.themes.map(name => { const old = `テーマ/${name}`, next = rebase(old, from, to); if (old !== next) { themeIds[next] = themeIds[old] ?? old; delete themeIds[old]; } return next.slice('テーマ/'.length); });
      fixture.folders = fixture.folders.map(path => rebase(path, from, to));
      persistDisk();
    };
    Object.assign(window, {
      __laminaClose: async () => {
        for (const [id, listener] of listeners) if (listener.event === 'tauri://close-requested') await callbacks.get(listener.handler)?.({ event: listener.event, id, payload: null });
      },
      __laminaChanged: async () => { for (const [id, listener] of listeners) if (listener.event === 'vault-changed') await callbacks.get(listener.handler)?.({ event: listener.event, id, payload: 'C:/TestVault' }); },
      __laminaDrop: async (paths: string[], x: number, y: number) => { for (const [id, listener] of listeners) if (listener.event === 'tauri://drag-drop') await callbacks.get(listener.handler)?.({ event: listener.event, id, payload: { paths, position: { x, y } } }); },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener(_event: string, id: number) { listeners.delete(id); } },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (event: unknown) => Promise<void>) => { const id = ++fixture.counter; callbacks.set(id, callback); return id; },
        invoke: async (command: string, args: Record<string, unknown>) => {
          if (command === 'plugin:dialog|open') return 'C:/TestVault';
          if (command === 'plugin:event|listen') { const id = ++fixture.counter; listeners.set(id, { event: String(args.event), handler: Number(args.handler) }); return id; }
          if (command === 'plugin:event|unlisten') return;
          if (command === 'plugin:window|destroy') { fixture.destroyed++; fixture.operations.push('destroy'); return; }
          if (command === 'open_vault') return snapshot();
          if (command === 'read_image') {
            const image = fixture.images[String(args.path)]; if (!image) throw new Error('画像がありません');
            return { ...image, ...(args.editing ? {} : { original: null, annotation: null }) };
          }
          if (command === 'write_image') {
            if (fixture.operationFailure) throw new Error('画像のテスト用保存失敗');
            const write = args.write as unknown as ImageWrite;
            if (write.path && fixture.images[write.path]?.revision !== write.expectedRevision) throw new Error('画像が外部で変更されています');
            const path = write.path ?? `添付/image-${++fixture.counter}/rendered.png`;
            const image: ImageFile = { path, mime: 'image/png', data: write.rendered, original: write.original, annotation: write.annotation, revision: `image-r${++fixture.counter}` };
            fixture.images[path] = image; persistDisk(); return structuredClone(image);
          }
          if (command === 'watch_vault') return;
          if (command === 'read_resource_clipboard') return fixture.clipboard ?? { paths: [], title: null, text: null };
          if (command === 'inspect_resource') return { title: String(args.path).split(/[\\/]/).at(-1), folder: fixture.resourceFolders?.includes(String(args.path)) ?? false, exists: true };
          if (command === 'open_resource') {
            fixture.resourceCalls ??= []; fixture.resourceCalls.push({ path: String(args.path), kind: args.kind ? String(args.kind) : null });
            if (fixture.officeFailure) throw new Error('Officeデスクトップアプリを起動できませんでした。ブラウザで開くを選んでください。');
            if (fixture.openFailure) throw new Error('資料を起動できませんでした'); fixture.openedUrls.push(String(args.path)); return;
          }
          if (command === 'catalog_stamp') { fixture.stampReads = (fixture.stampReads ?? 0) + 1; return JSON.stringify([Object.entries(files).map(([path, file]) => [path, file.revision]), fixture.folders]); }
          if (command === 'read_catalog') { fixture.catalogReads = (fixture.catalogReads ?? 0) + 1; return { ...catalog(), ...(fixture.useCatalogStamp ? { stamp: JSON.stringify([Object.entries(files).map(([path, file]) => [path, file.revision]), fixture.folders]) } : {}) }; }
          if (command === 'trash_note') {
            const path = String(args.path);
            if (fixture.trashFailure) throw new Error('削除のテスト用失敗');
            if (!path.startsWith('メモ/') || files[path]?.revision !== args.expectedRevision) throw new Error('削除するメモに外部変更があります');
            fixture.trash ??= {}; fixture.trash[path] = structuredClone(files[path]); delete files[path];
            fixture.operations.push('trash'); persistDisk(); localStorage.setItem('lamina.test.tracking', JSON.stringify(currentEntries()));
            return catalog();
          }
          if (command === 'apply_operation') {
            if (fixture.operationFailure) throw new Error('操作のテスト用保存失敗');
            const operation = args.operation as unknown as Operation;
            for (const guard of operation.guards) if (files[guard.path]?.revision !== guard.revision) throw new Error('外部変更が検出されました');
            const movement = operation.relocation;
            if (movement && (files[movement.to] || fixture.folders.includes(movement.to) || fixture.themes.includes(movement.to.slice('テーマ/'.length)))) throw new Error('移動先に同名の項目があります');
            for (const write of operation.writes) if ((files[write.path]?.revision ?? null) !== write.expectedRevision) throw new Error('同名ファイルまたは外部変更があります');
            for (const entry of operation.deletes ?? []) if (files[entry.path]?.revision !== entry.revision) throw new Error('統合元に外部変更があります');
            for (const folder of operation.folders ?? []) if (fixture.folders.includes(folder)) throw new Error('同名のフォルダーがあります');
            if (movement) fixture.moveOffline(movement.from, movement.to);
            fixture.folders.push(...operation.folders ?? []);
            for (const write of operation.writes) {
              const path = movement ? rebase(write.path, movement.from, movement.to) : write.path;
              files[path] = { content: write.content, revision: `saved-${++fixture.counter}`, identity: files[path]?.identity ?? path };
              const parts = path.split('/').slice(1, -1); let parent = 'メモ';
              if (path.startsWith('メモ/')) for (const part of parts) { parent += '/' + part; if (!fixture.folders.includes(parent)) fixture.folders.push(parent); }
            }
            for (const entry of operation.deletes ?? []) delete files[entry.path];
            if (movement || operation.writes.length || operation.folders?.length) fixture.operations.push('operation');
            localStorage.setItem('lamina.test.tracking', JSON.stringify(currentEntries())); persistDisk(); return catalog();
          }
          if (command === 'open_web_link') {
            if (fixture.openFailure) throw new Error('ブラウザーを起動できませんでした');
            fixture.browserUrls ??= []; fixture.browserUrls.push(String(args.url));
            fixture.openedUrls.push(String(args.url)); return;
          }
          if (command === 'read_workspace') return JSON.parse(localStorage.getItem('lamina.test.workspace') ?? 'null');
          if (command === 'save_workspace') {
            if (fixture.sessionFailure) throw new Error('画面状態のテスト用保存失敗');
            localStorage.setItem('lamina.test.workspace', JSON.stringify(args.session));
            fixture.operations.push('workspace');
            return;
          }
          if (command === 'read_document') {
            if (!files[String(args.path)]) throw new Error('ファイルがありません');
            return { ...files[String(args.path)], path: args.path };
          }
          if (command === 'save_document') {
            if (fixture.failure) throw new Error('テスト用の保存失敗');
            if (fixture.holdSave) {
              fixture.pendingSaves++;
              await new Promise<void>(resolve => { fixture.releaseSave = () => { fixture.holdSave = false; fixture.pendingSaves--; resolve(); }; });
            }
            const old = files[String(args.path)];
            if ((old?.revision ?? null) !== args.expectedRevision) throw new Error('外部変更が検出されました');
            const next = { content: String(args.content), revision: `saved-${++fixture.counter}`, identity: old?.identity ?? String(args.path) };
            files[String(args.path)] = next;
            fixture.operations.push('document');
            persistDisk();
            return { ...next, path: args.path };
          }
          if (command === 'create_theme') { fixture.themes.push(String(args.name)); persistDisk(); return snapshot(); }
          if (command === 'create_note') {
            const path = `メモ/${args.name}.md`;
            if (files[path]) throw new Error('同名ファイルが存在します');
            files[path] = { content: '', revision: `new-${++fixture.counter}` };
            persistDisk();
            return { ...files[path], path };
          }
          throw new Error(`Unhandled test IPC: ${command}`);
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '保管庫を開く', exact: true }).last().click();
  await expect(page.getByRole('navigation', { name: 'テーマ', exact: true })).toBeVisible();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
}
