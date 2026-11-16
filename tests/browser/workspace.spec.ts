import { test, expect, type Page } from '@playwright/test';
import type { WorkspaceSession } from '../../src/domain/session';
import type { Operation } from '../../src/domain/note-links';
import type { ImageFile, ImageWrite } from '../../src/domain/images';
import { materialDraft, writeMaterial } from '../../src/domain/materials';

interface TestFixture {
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
async function connectTestVault(page: Page) {
  await page.clock.install({ time: new Date('2026-11-12T01:00:00Z') });
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
      return { snapshot: snapshot(), files: Object.entries(files).map(([path, file]) => ({ ...file, path })), previous: previous ?? current, moves, warnings: [] };
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
          if (command === 'open_resource') { if (fixture.openFailure) throw new Error('資料を起動できませんでした'); fixture.openedUrls.push(String(args.path)); return; }
          if (command === 'read_catalog') return catalog();
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

test('実ファイル境界を代替したIPC経由で月別編集・保存・今日の生成が動く', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await connectTestVault(page);
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  await expect(page.getByText('2026年10月', { exact: true })).toBeVisible();
  await expect(page.getByText('2026年11月', { exact: true })).toBeVisible();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文' });
  await editor.click();
  await editor.press('Control+End');
  await page.keyboard.insertText('追加の考察。');
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __laminaFixture: { files: Record<string, { content: string }> } }).__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content)).toContain('追加の考察。');
  expect(await page.evaluate(() => (window as unknown as { __laminaFixture: { files: Record<string, { content: string }> } }).__laminaFixture.files['テーマ/耐久性評価/2026-10.md'].content)).toBe('# 2026-10-31\n\n初回の試験を完了した。\n');
  await page.getByRole('button', { name: '今日へ', exact: true }).click();
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __laminaFixture: { files: Record<string, { content: string }> } }).__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content)).toContain('# 2026-11-12');
  await page.getByRole('button', { name: '今日へ', exact: true }).click();
  expect(await editor.innerText()).not.toContain('2026年10月\n\n#');
  await expect(page.locator('.cm-heading-1')).toHaveCount(3);
  expect(errors).toEqual([]);
  await page.screenshot({ path: '.tools/qa/workspace.png' });
});

test('Ctrl+Tab・数字・Ctrl+W・Ctrl+Shift+Tで保存しながらタブを操作できる', async ({ page }) => {
  await connectTestVault(page);
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  await page.getByRole('button', { name: 'ピン留め', exact: true }).click();
  await page.getByRole('navigation', { name: 'メモ', exact: true }).getByRole('button', { name: '試験の手順', exact: true }).click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  const active = (name: string) => page.getByRole('tab', { name, exact: true });
  await page.keyboard.press('Control+Tab'); await expect(active('耐久性評価')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: '耐久性評価の本文', exact: true })).toBeFocused();
  await page.keyboard.press('Control+Shift+Tab'); await expect(active('資料一覧')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+PageUp'); await expect(active('試験の手順')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+1'); await expect(active('耐久性評価')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+9'); await expect(active('資料一覧')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+w'); await expect(active('資料一覧')).toHaveCount(0);
  await expect(active('試験の手順')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Shift+t'); await expect(active('資料一覧')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+2');
  const editor = page.getByRole('textbox', { name: '試験の手順の本文', exact: true });
  await expect(editor).toBeFocused(); await editor.press('Control+End'); await page.keyboard.insertText('閉じる前の追記');
  await editor.press('Control+w'); await expect(active('試験の手順')).toHaveCount(0);
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toContain('閉じる前の追記');
  await page.keyboard.press('Control+Shift+t'); await expect(editor).toContainText('閉じる前の追記'); await expect(editor).toBeFocused();
  await page.keyboard.press('Control+1'); await page.keyboard.press('Control+w'); await expect(active('耐久性評価')).toHaveCount(0);
});

test('Ctrl+Wの保存失敗でタブを残し、右の最後のタブは閉じるとペインを畳む', async ({ page }) => {
  await connectTestVault(page); await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await page.getByRole('button', { name: '左右分割を切り替え', exact: true }).click();
  const right = page.getByRole('region', { name: '右ペイン', exact: true }), editor = right.getByRole('textbox', { name: '試験の手順の本文', exact: true });
  await editor.click(); await editor.press('Control+End'); await page.keyboard.insertText('保存が必要な追記');
  await page.evaluate(() => { window.__laminaFixture.failure = true; }); await editor.press('Control+w');
  await expect(page.getByRole('alert')).toContainText('保存できません'); await expect(right).toBeVisible();
  await expect(right.getByRole('tab', { name: '試験の手順', exact: true })).toBeVisible();
  await page.evaluate(() => { window.__laminaFixture.failure = false; }); await editor.press('Control+w'); await expect(right).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '試験の手順の本文', exact: true })).toBeFocused();
  await page.keyboard.press('Control+Shift+t'); await expect(right).toBeVisible();
});

test('Ctrl+Nでメモを作成し、モーダル内のタブショートカットを本文へ通さない', async ({ page }) => {
  await connectTestVault(page); await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await page.keyboard.press('Control+n'); const dialog = page.getByRole('dialog', { name: '新しいメモ', exact: true }); await expect(dialog).toBeVisible();
  await page.keyboard.press('Control+w'); await expect(page.getByRole('tab', { name: '試験の手順', exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'タイトル', exact: true }).fill('ショートカットで作成');
  await dialog.getByRole('button', { name: '作成', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: 'ショートカットで作成の本文', exact: true })).toBeFocused();
});

test('メモ削除はキャンセルでき、追記を退避して左右のタブを閉じ、参照リンクを残す', async ({ page }) => {
  await connectTestVault(page);
  await page.evaluate(() => { window.__laminaFixture.files['メモ/参照元.md'] = { content: '[[試験の手順]]', revision: 'ref' }; });
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click(); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await page.getByRole('navigation', { name: 'メモ', exact: true }).getByRole('button', { name: '試験の手順', exact: true }).click();
  await page.getByRole('button', { name: '左右分割を切り替え', exact: true }).click();
  const editor = page.getByRole('region', { name: '右ペイン', exact: true }).getByRole('textbox', { name: '試験の手順の本文', exact: true });
  await editor.press('Control+End'); await page.keyboard.insertText('退避する追記');
  const requestDelete = async () => { await page.getByLabel('メモ/試験の手順.mdの操作', { exact: true }).first().click(); await page.getByRole('menuitem', { name: 'メモを削除', exact: true }).click(); };
  await requestDelete(); const dialog = page.getByRole('dialog', { name: 'メモを削除', exact: true });
  await expect(dialog).toContainText('参照が1件'); await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(page.getByRole('tab', { name: '試験の手順', exact: true })).toHaveCount(2);
  await requestDelete(); await dialog.getByRole('button', { name: '削除する', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('tab', { name: '試験の手順', exact: true })).toHaveCount(0); await expect(page.getByRole('region', { name: '右ペイン', exact: true })).toHaveCount(0);
  const disk = await page.evaluate(() => ({ files: window.__laminaFixture.files, trash: window.__laminaFixture.trash }));
  expect(disk.files['メモ/試験の手順.md']).toBeUndefined(); expect(disk.trash?.['メモ/試験の手順.md'].content).toContain('退避する追記'); expect(disk.files['メモ/参照元.md'].content).toBe('[[試験の手順]]');
  await page.keyboard.press('Control+Shift+t'); await expect(page.getByRole('tab', { name: '試験の手順', exact: true })).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('navigation', { name: 'メモ', exact: true }).getByRole('button', { name: '試験の手順', exact: true })).toHaveCount(0);
});

for (const failure of ['保存失敗', '外部変更'] as const) test(`メモ削除の${failure}では元のファイルとタブを残す`, async ({ page }) => {
  await connectTestVault(page); await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await page.evaluate(failure => {
    if (failure === '保存失敗') window.__laminaFixture.trashFailure = true;
    else window.__laminaFixture.files['メモ/試験の手順.md'] = { content: '外部で変更した本文', revision: 'external' };
  }, failure);
  await page.getByLabel('メモ/試験の手順.mdの操作', { exact: true }).first().click(); await page.getByRole('menuitem', { name: 'メモを削除', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'メモを削除', exact: true }); await dialog.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(dialog).toBeVisible(); await expect(page.getByRole('alert')).toContainText(failure === '保存失敗' ? '削除のテスト用失敗' : '外部で変更');
  await expect(page.getByRole('tab', { name: '試験の手順', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'])).toBeDefined();
  expect(await page.evaluate(() => window.__laminaFixture.trash)).toBeUndefined();
});

test('メモを退避した後の画面状態保存失敗は、削除を繰り返さず知らせる', async ({ page }) => {
  await connectTestVault(page); await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await page.evaluate(() => { window.__laminaFixture.sessionFailure = true; });
  await page.getByLabel('メモ/試験の手順.mdの操作', { exact: true }).first().click(); await page.getByRole('menuitem', { name: 'メモを削除', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'メモを削除', exact: true }); await dialog.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(page.getByRole('alert')).toContainText('workspace.json');
  await expect(page.getByRole('tab', { name: '試験の手順', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__laminaFixture.trash?.['メモ/試験の手順.md'])).toBeDefined();
});

for (const fail of [false, true]) test(`資料セルの編集中にCtrl+Wを押すと確定を待ち、保存${fail ? '失敗ならタブを保持' : '成功後に閉じる'}`, async ({ page }) => {
  await connectTestVault(page); await seedMaterials(page); await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  const input = page.getByRole('textbox', { name: '評価.xlsxのメモ', exact: true });
  await input.fill('閉じる前に確定するメモ');
  if (fail) await page.evaluate(() => { window.__laminaFixture.operationFailure = true; });
  await input.press('Control+w');
  if (fail) {
    await expect(page.getByRole('alert')).toContainText('保存失敗');
    await expect(page.getByRole('tab', { name: '資料一覧', exact: true })).toBeVisible(); await expect(input).toHaveValue('閉じる前に確定するメモ');
    await input.fill('失敗後にもう一度編集'); await input.press('Control+w');
    await expect(page.getByRole('tab', { name: '資料一覧', exact: true })).toBeVisible(); await expect(input).toHaveValue('失敗後にもう一度編集');
  } else {
    await expect(page.getByRole('tab', { name: '資料一覧', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__laminaFixture.files['資料/評価.xlsx.md'].content)).toContain('閉じる前に確定するメモ');
  }
});

test('ピン留め・左右分割と同じ文書の同期を維持する', async ({ page }) => {
  await connectTestVault(page);
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  await page.getByRole('button', { name: 'ピン留め', exact: true }).click();
  await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await expect(page.getByRole('tab', { name: '耐久性評価', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '試験の手順', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '左右分割を切り替え' }).click();
  const editors = page.getByRole('textbox', { name: '試験の手順の本文' });
  await expect(editors).toHaveCount(2);
  await editors.first().click();
  await editors.first().press('Control+End');
  await page.keyboard.insertText('測定器を校正する。');
  await expect(editors.last()).toContainText('測定器を校正する。');
});

test('保存失敗時は編集内容とタブを保持し、再試行できる', async ({ page }) => {
  await connectTestVault(page);
  await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await page.evaluate(() => { (window as unknown as { __laminaFixture: { failure: boolean } }).__laminaFixture.failure = true; });
  const editor = page.getByRole('textbox', { name: '試験の手順の本文' });
  await editor.click();
  await editor.press('Control+End');
  await page.keyboard.insertText('保持する編集');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('alert')).toContainText('保存できません');
  await page.getByRole('button', { name: '試験の手順を閉じる' }).click();
  await expect(page.getByRole('tab', { name: '試験の手順', exact: true })).toBeVisible();
  await expect(editor).toContainText('保持する編集');
  await page.evaluate(() => { (window as unknown as { __laminaFixture: { failure: boolean } }).__laminaFixture.failure = false; });
  await page.getByRole('button', { name: '保存を再試行' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('新規テーマの作成から今日の編集まで進める', async ({ page }) => {
  await connectTestVault(page);
  await page.getByRole('button', { name: 'テーマを追加', exact: true }).click();
  await page.getByRole('textbox', { name: 'テーマ名' }).fill('振動対策');
  await page.getByRole('button', { name: '作成', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '振動対策の本文' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '振動対策の本文' })).toContainText('2026-11-12');
});

test('月全体を置換してUndoしても、月別の本文が元どおり保存される', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await connectTestVault(page);
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文' });
  await editor.click();
  await editor.press('Control+a');
  await page.keyboard.insertText('置換した記録');
  await editor.press('Control+z');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => Object.values((window as unknown as { __laminaFixture: { files: Record<string, { content: string }> } }).__laminaFixture.files).map(file => file.content))).toEqual([
    '# 2026-10-31\n\n初回の試験を完了した。\n',
    '# 2026-11-11\n\n温度推移を確認した。\n',
    '## 測定の手順\n\n記録先を確認する。',
  ]);
  await expect(page.getByText('2026年10月', { exact: true })).toBeVisible();
  await expect(page.getByText('2026年11月', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const { name, initial, continuation } of [
  { name: '箇条書き', initial: '- 親項目\n- 子項目', continuation: '- ' },
  { name: '番号付きリスト', initial: '1. 親項目\n2. 子項目', continuation: '3. ' },
]) {
  test(`${name}をTabで字下げし、改行・Shift+Tab・Undo・保存できる`, async ({ page }) => {
    await connectTestVault(page);
    await page.getByRole('button', { name: '試験の手順', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '試験の手順の本文' });
    const text = () => editor.locator('.cm-line').allTextContents().then(lines => lines.join('\n'));
    await editor.click();
    await editor.press('Control+a');
    await page.keyboard.insertText(initial);
    await editor.press('Tab');
    const nested = initial.replace('\n', '\n    ');
    await expect.poll(text).toBe(nested);
    await expect(editor).toBeFocused();
    await editor.press('Shift+Tab');
    await expect.poll(text).toBe(initial);
    await editor.press('Control+z');
    await expect.poll(text).toBe(nested);
    await editor.press('Enter');
    await page.keyboard.insertText('次の項目');
    const expected = `${nested}\n    ${continuation}次の項目`;
    await expect.poll(text).toBe(expected);
    await editor.press('Control+s');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __laminaFixture: { files: Record<string, { content: string }> } }).__laminaFixture.files['メモ/試験の手順.md'].content)).toBe(expected);
  });
}

test('複数行のTab・Shift+Tabは月ラベルを本文へ混入させず月別に保存する', async ({ page }) => {
  await connectTestVault(page);
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文' });
  const savedMonths = () => page.evaluate(() => {
    const { files } = (window as unknown as { __laminaFixture: { files: Record<string, { content: string }> } }).__laminaFixture;
    return ['2026-10', '2026-11'].map(month => files[`テーマ/耐久性評価/${month}.md`].content);
  });
  const initial = await savedMonths();
  await editor.click();
  await editor.press('Control+a');
  await editor.press('Tab');
  await editor.press('Control+s');
  // All selected physical lines indent, including blanks. The final empty
  // line is outside the selection; virtual divider lines change no file.
  await expect.poll(savedMonths).toEqual([
    '    # 2026-10-31\n    \n    初回の試験を完了した。\n    ',
    '    # 2026-11-11\n    \n    温度推移を確認した。\n',
  ]);
  await editor.press('Shift+Tab');
  await editor.press('Control+s');
  await expect.poll(savedMonths).toEqual(initial);
  await expect(page.getByText('2026年10月', { exact: true })).toBeVisible();
  await expect(page.getByText('2026年11月', { exact: true })).toBeVisible();
});

async function caretPosition(editor: import('@playwright/test').Locator) {
  return editor.evaluate(async element => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const selection = window.getSelection(), anchor = selection?.anchorNode;
    const line = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('.cm-line');
    if (!selection?.anchorNode || !line) throw new Error('本文にカーソルがありません');
    const prefix = document.createRange(); prefix.setStart(line, 0); prefix.setEnd(selection.anchorNode, selection.anchorOffset);
    const bounds = element.closest('.cm-editor')?.querySelector('.cm-cursor')?.getBoundingClientRect() ?? selection.getRangeAt(0).getBoundingClientRect();
    return { line: [...element.querySelectorAll('.cm-line')].indexOf(line), offset: prefix.toString().length, x: bounds.x, y: bounds.y };
  });
}
for (const list of [true, false]) test(`見出しの余白で${list ? '箇条書き' : '通常本文'}の上下移動が見出しまで飛ばない`, async ({ page }) => {
  // Walk every line in both directions, including off-screen content.
  test.setTimeout(60_000);
  const content = Array.from({ length: 12 }, (_, index) => {
    const number = index + 1, prefix = list ? '- ' : '';
    return `# 大見出し ${number}\n\n本文 A ${number}\n## 小見出し ${number}\n${prefix}項目 A ${number}\n${prefix}項目 B ${number}\n\n本文 B ${number}\n`;
  }).join('\n');
  const lines = content.split('\n'), editor = await openMarkdown(page, content);
  async function currentLine() {
    return editor.evaluate(() => {
      const anchor = window.getSelection()?.anchorNode;
      return (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('.cm-line')?.textContent;
    });
  }
  await editor.press('Control+End');
  for (let line = lines.length - 2; line >= 0; line--) {
    await editor.press('ArrowUp');
    await expect.poll(currentLine, { message: `上キーで${line + 1}行目へ移動する` }).toBe(lines[line]);
  }
  for (let line = 1; line < lines.length; line++) {
    await editor.press('ArrowDown');
    await expect.poll(currentLine, { message: `下キーで${line + 1}行目へ移動する` }).toBe(lines[line]);
  }
  const lastItem = editor.locator('.cm-line').filter({ hasText: `${list ? '- ' : ''}項目 A 12` });
  await lastItem.click(); await expect.poll(currentLine).toBe(`${list ? '- ' : ''}項目 A 12`);
  await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe(content);
});

for (const count of [1, 4]) test(`テーマの${count}か月表示で月ラベルによる上下移動・クリックの位置ずれを起こさない`, async ({ page }) => {
  await connectTestVault(page);
  const months = ['08', '09', '10', '11'].slice(0, count).map(month => ({
    path: `テーマ/耐久性評価/2026-${month}.md`, month,
    content: `# 2026-${month}-01\n\n## 条件 ${month}\n- 項目 A ${month}\n- 項目 B ${month}\n\n本文 A ${month}\n本文 B ${month}`,
  }));
  await page.evaluate(months => {
    const files = window.__laminaFixture.files;
    for (const path of Object.keys(files)) if (path.startsWith('テーマ/耐久性評価/')) delete files[path];
    for (const month of months) files[month.path] = { content: month.content, revision: month.path };
  }, months);
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await page.getByRole('navigation', { name: 'テーマ', exact: true }).getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文', exact: true });
  await expect(editor.locator('.month-divider')).toHaveCount(count);
  async function currentLine() {
    return editor.evaluate(() => {
      const anchor = window.getSelection()?.anchorNode;
      return (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('.cm-line')?.textContent;
    });
  }
  const lines = months.flatMap(month => month.content.split('\n'));
  await editor.press('Control+End');
  for (let line = lines.length - 2; line >= 0; line--) {
    await editor.press('ArrowUp');
    await expect.poll(currentLine, { message: `テーマの上キー移動先：${lines[line]}` }).toBe(lines[line]);
  }
  for (let line = 1; line < lines.length; line++) {
    await editor.press('ArrowDown');
    await expect.poll(currentLine, { message: `テーマの下キー移動先：${lines[line]}` }).toBe(lines[line]);
  }
  await page.getByRole('tab', { name: '目次', exact: true }).click();
  const outline = page.getByRole('navigation', { name: '本文の目次', exact: true });
  for (const month of months) {
    await outline.getByRole('button', { name: `条件 ${month.month}`, exact: true }).click();
    await editor.locator('.cm-line').filter({ hasText: `本文 B ${month.month}` }).click();
    await expect.poll(currentLine).toBe(`本文 B ${month.month}`);
  }
  await editor.press('Control+s');
  for (const month of months) expect(await page.evaluate(path => window.__laminaFixture.files[path].content, month.path)).toBe(month.content);
});

for (const [shortcut, marker] of [['Control+b', '**'], ['Control+i', '*'], ['Control+e', '`'], ['Control+Shift+x', '~~']]) test(`${shortcut}で書式を適用・解除し、Undo・保存できる`, async ({ page }) => {
  const editor = await openMarkdown(page, '対象');
  const saved = () => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content);
  await editor.press('Control+a'); await editor.press(shortcut); await editor.press('Control+s');
  await expect.poll(saved).toBe(`${marker}対象${marker}`);
  await editor.press(shortcut); await editor.press('Control+s'); await expect.poll(saved).toBe('対象');
  await editor.press('Control+z'); await editor.press('Control+s'); await expect.poll(saved).toBe(`${marker}対象${marker}`);
  await editor.press('Control+Shift+z'); await editor.press('Control+s'); await expect.poll(saved).toBe('対象');
});

test('未選択のCtrl+Bは記法の内側に入力し、コード・YAMLを変更しない', async ({ page }) => {
  const editor = await openMarkdown(page, '本文\n\n');
  await editor.press('Control+End'); await editor.press('Control+b'); await page.keyboard.insertText('追記'); await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('本文\n\n**追記**');
  await editor.press('Control+b'); await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('本文\n\n追記');
});

test('Ctrl+Kでリンク先を編集し、URL貼り付けを資料登録へ渡さない', async ({ page }) => {
  const editor = await openMarkdown(page, '仕様書');
  await editor.press('Control+a'); await editor.press('Control+k');
  await editor.evaluate(element => {
    const transfer = new DataTransfer(); transfer.setData('text/plain', 'https://example.com/spec');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('dialog')).toHaveCount(0); await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('[仕様書](https://example.com/spec)');
  await editor.press('Home'); await editor.press('ArrowRight'); await editor.press('Control+k');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('https://example.com/spec');
});

test('見出し・引用・番号・箇条書きのショートカットで階層とキャレットを保つ', async ({ page }) => {
  const editor = await openMarkdown(page, '一\n二');
  const saved = () => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content);
  await editor.press('Control+a'); await editor.press('Control+Shift+Digit8'); await editor.press('Control+s'); await expect.poll(saved).toBe('- 一\n- 二');
  await editor.press('Control+Shift+Digit7'); await editor.press('Control+s'); await expect.poll(saved).toBe('1. 一\n2. 二');
  await editor.press('Control+Shift+Period'); await editor.press('Control+s'); await expect.poll(saved).toBe('> 1. 一\n> 2. 二');
  await editor.press('Control+Shift+Period'); await editor.press('Control+Shift+Digit7');
  await editor.press('Control+Home'); await editor.press('Control+Alt+2'); await editor.press('Control+s'); await expect.poll(saved).toBe('## 一\n二');
  await editor.press('Control+Alt+0'); await editor.press('Control+s'); await expect.poll(saved).toBe('一\n二');
});

test('取り消し線・水平線を整形表示し、元のMarkdownを保持する', async ({ page }) => {
  const content = '最初\n\n~~廃止~~ と **太字** と *斜体*\n\n---\n\n最後';
  const editor = await openMarkdown(page, content);
  await expect(editor.locator('.cm-preview-strike')).toHaveText('廃止');
  await expect(editor.locator('.cm-preview-rule')).toHaveCount(1);
  await expect(editor.locator('.cm-preview-strong')).toHaveText('太字');
  await expect(editor.locator('.cm-preview-emphasis')).toHaveText('斜体');
  await editor.press('Control+s'); expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe(content);
});

test('Ctrl+Shift+Cでコードブロックを作成・解除し、その中では太字を挿入しない', async ({ page }) => {
  const editor = await openMarkdown(page, 'const n = 1;');
  const saved = () => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content);
  await editor.press('Control+a'); await editor.press('Control+Shift+c'); await editor.press('Control+s');
  await expect.poll(saved).toBe('```\nconst n = 1;\n```');
  await editor.press('Control+b'); await editor.press('Control+s'); await expect.poll(saved).toBe('```\nconst n = 1;\n```');
  await editor.press('Control+Shift+c'); await editor.press('Control+s'); await expect.poll(saved).toBe('const n = 1;');
});

test('月次ノートの見出しとタスクをまとめて装飾し、ファイル境界とUndoを保つ', async ({ page }) => {
  await connectTestVault(page);
  const old = '# 2026-10-31\n\n- [ ] 先月', recent = '# 2026-11-01\n\n- 今月';
  await page.evaluate(({ old, recent }) => { window.__laminaFixture.files['テーマ/耐久性評価/2026-10.md'].content = old; window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content = recent; }, { old, recent });
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click(); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await page.getByRole('navigation', { name: 'テーマ', exact: true }).getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文', exact: true });
  await editor.press('Control+a'); await editor.press('Control+b'); await editor.press('Control+s');
  const saved = () => page.evaluate(() => ['2026-10', '2026-11'].map(month => window.__laminaFixture.files[`テーマ/耐久性評価/${month}.md`].content));
  await expect.poll(saved).toEqual(['# **2026-10-31**\n\n- [ ] **先月**', '# **2026-11-01**\n\n- **今月**']);
  await expect(editor.locator('.month-divider')).toHaveCount(2);
  await editor.press('Control+z'); await editor.press('Control+s'); await expect.poll(saved).toEqual([old, recent]);
});

test('タスクをチェックボックスで描画し、クリック・Ctrl+L・UndoでもMarkdownを保つ', async ({ page }) => {
  const content = '# タスク\n- [ ] 未完了\n- [x] 完了\n    - [ ] 子項目\n\n通常の本文';
  const editor = await openMarkdown(page, content);
  await expect(editor.getByRole('checkbox')).toHaveCount(3);
  await expect(editor.getByRole('checkbox', { name: '未完了', exact: true })).not.toBeChecked();
  await expect(editor.getByRole('checkbox', { name: '完了', exact: true })).toBeChecked();
  const saved = () => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content);
  await editor.getByRole('checkbox', { name: '未完了', exact: true }).click();
  await expect(editor.getByRole('checkbox', { name: '未完了', exact: true })).toBeChecked();
  await editor.press('Control+s'); await expect.poll(saved).toBe(content.replace('- [ ] 未完了', '- [x] 未完了'));
  await editor.press('Control+z'); await editor.press('Control+s'); await expect.poll(saved).toBe(content);
  await editor.locator('.cm-line').filter({ hasText: /^- \[ \] 未完了$/ }).click(); await editor.press('End'); await editor.press('Control+l');
  await expect(editor.getByRole('checkbox', { name: '未完了', exact: true })).toBeChecked();
  await editor.press('Control+l'); await expect(editor.getByRole('checkbox', { name: '未完了', exact: true })).not.toBeChecked();
  await editor.press('Control+End'); await editor.press('Control+l');
  await expect(editor.getByRole('checkbox', { name: '通常の本文', exact: true })).not.toBeChecked();
  await expect(editor).toBeFocused(); await editor.press('End'); await editor.press('Enter');
  await page.keyboard.insertText('続きのタスク');
  await expect(editor.getByRole('checkbox', { name: '続きのタスク', exact: true })).not.toBeChecked();
  await editor.press('Control+l'); await editor.press('Control+s');
  await expect.poll(saved).toBe(content.replace('通常の本文', '- [ ] 通常の本文\n- [x] 続きのタスク'));
  await page.screenshot({ path: '.tools/qa/task-checkboxes.png' });
});

test('チェック項目を含む月次ページで上下・クリック位置がずれず前月のコードに影響されない', async ({ page }) => {
  await connectTestVault(page);
  const old = '# 2026-10-31\n```md\n- [ ] コード';
  const recent = '# 2026-11-01\n\n' + Array.from({ length: 12 }, (_, i) => `${i % 3 === 1 ? '    ' : ''}- [${i % 2 ? 'x' : ' '}] 確認 ${i + 1}`).join('\n');
  await page.evaluate(({ old, recent }) => {
    window.__laminaFixture.files['テーマ/耐久性評価/2026-10.md'].content = old;
    window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content = recent;
  }, { old, recent });
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await page.getByRole('navigation', { name: 'テーマ', exact: true }).getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文', exact: true });
  const currentLine = () => editor.evaluate(() => {
    const anchor = window.getSelection()?.anchorNode;
    return (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('.cm-line')?.textContent;
  });
  const lines = [...old.split('\n'), ...recent.split('\n')];
  await editor.press('Control+End');
  for (let i = lines.length - 2; i >= 0; i--) { await editor.press('ArrowUp'); await expect.poll(currentLine).toBe(lines[i]); }
  for (let i = 1; i < lines.length; i++) { await editor.press('ArrowDown'); await expect.poll(currentLine).toBe(lines[i]); }
  await editor.locator('.cm-line').filter({ hasText: '確認 12' }).click(); await editor.press('Home');
  expect((await caretPosition(editor)).offset).toBe(6);
  await editor.press('Control+l');
  await expect(editor.getByRole('checkbox', { name: '確認 12', exact: true })).not.toBeChecked();
  await editor.getByRole('checkbox', { name: '確認 12', exact: true }).click();
  await expect(editor.getByRole('checkbox', { name: '確認 12', exact: true })).toBeChecked();
  await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['テーマ/耐久性評価/2026-10.md'].content)).toBe(old);
  expect(await page.evaluate(() => window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content)).toBe(recent);
});

test('Ctrl+Lで複数行をタスクにし、コード・YAML・見出しと区切りの空行を保持する', async ({ page }) => {
  const content = '---\ntitle: 記録\n---\n# タスク\n\n普通の項目\n- 箇条書き\n- [x] 完了\n\n```md\n- [ ] コード\n```';
  const editor = await openMarkdown(page, content);
  await editor.press('Control+a'); await editor.press('Control+l'); await editor.press('Control+s');
  const converted = content.replace('普通の項目', '- [ ] 普通の項目').replace('- 箇条書き', '- [ ] 箇条書き');
  const saved = () => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content);
  await expect.poll(saved).toBe(converted); await expect(editor.getByRole('checkbox')).toHaveCount(3);
  await editor.press('Control+l'); await editor.press('Control+s');
  await expect.poll(saved).toBe(converted.replace('- [ ] 普通の項目', '- [x] 普通の項目').replace('- [ ] 箇条書き', '- [x] 箇条書き'));
  await editor.press('Control+z'); await editor.press('Control+s'); await expect.poll(saved).toBe(converted);
});

test('長い月次ノート末尾でも繰り返しEnter・Tab・Delete・Undoが動く', async ({ page }) => {
  await connectTestVault(page);
  const prefix = '# 2026-11-01\n\n' + '試験条件と結果の記録。\n\n'.repeat(400);
  await page.evaluate(content => { window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content = content; }, prefix + '- 前\n- 子');
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await page.getByRole('navigation', { name: 'テーマ', exact: true }).getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文', exact: true });
  await editor.press('Control+End'); await editor.press('Tab'); await editor.press('Enter');
  await page.keyboard.insertText('孫候補'); await editor.press('Tab'); await editor.press('Enter');
  await page.keyboard.insertText('次'); await editor.press('Control+s');
  const saved = () => page.evaluate(() => window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content);
  await expect.poll(saved).toBe(prefix + '- 前\n    - 子\n        - 孫候補\n        - 次');
  await editor.press('ArrowUp'); await editor.press('End'); await editor.press('Delete'); await editor.press('Control+s');
  await expect.poll(saved).toBe(prefix + '- 前\n    - 子\n        - 孫候補次');
  await editor.press('Control+z'); await editor.press('Control+s');
  await expect.poll(saved).toBe(prefix + '- 前\n    - 子\n        - 孫候補\n        - 次');
  expect(await page.evaluate(() => window.__laminaFixture.files['テーマ/耐久性評価/2026-10.md'].content)).toBe('# 2026-10-31\n\n初回の試験を完了した。\n');
});

test('Alt上下で子孫ごと項目を並べ替え、Undo後も続けて入力できる', async ({ page }) => {
  const original = '# 記録\n- 前\n- 親\n    - 子\n        - 孫\n- 後';
  const editor = await openMarkdown(page, original);
  await editor.locator('.cm-line').filter({ hasText: /^- 親$/ }).click(); await editor.press('End');
  await editor.press('Alt+ArrowDown'); await editor.press('Control+s');
  const saved = () => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content);
  await expect.poll(saved).toBe('# 記録\n- 前\n- 後\n- 親\n    - 子\n        - 孫');
  await editor.press('Control+z'); await editor.press('Control+s'); await expect.poll(saved).toBe(original);
  await editor.press('Alt+ArrowUp'); await editor.press('Enter'); await page.keyboard.insertText('追記'); await editor.press('Control+s');
  await expect.poll(saved).toBe('# 記録\n- 親\n- 追記\n    - 子\n        - 孫\n- 前\n- 後');
});

test('見出しの開閉・入れ子・目次ジャンプで本文を保持する', async ({ page }) => {
  const content = '# 一日目\n\n本文 A\n## 条件\n条件の本文\n### 補足\n補足の本文\n## 結果\n結果の本文\n# 二日目\n本文 B';
  const editor = await openMarkdown(page, content);
  await editor.getByRole('button', { name: '条件を折り畳む', exact: true }).click();
  await expect(editor.locator('.cm-line').filter({ hasText: '条件の本文' })).toHaveCount(0);
  await expect(editor.locator('.cm-line').filter({ hasText: '結果の本文' })).toBeVisible();
  await editor.getByRole('button', { name: '一日目を折り畳む', exact: true }).click();
  await expect(editor.locator('.cm-line').filter({ hasText: '本文 A' })).toHaveCount(0);
  await expect(editor.locator('.cm-line').filter({ hasText: '本文 B' })).toBeVisible();
  await editor.getByRole('button', { name: '一日目を展開', exact: true }).click();
  await expect(editor.getByRole('button', { name: '条件を展開', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '目次', exact: true }).click();
  await page.getByRole('navigation', { name: '本文の目次', exact: true }).getByRole('button', { name: '補足', exact: true }).click();
  await expect(editor.locator('.cm-line').filter({ hasText: '補足の本文' })).toBeVisible();
  await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe(content);
});

test('キーボードで見出しを個別・一括開閉し、展開直後にも入力できる', async ({ page }) => {
  const content = '# 第一\n本文 A\n## 条件\n条件の本文\n# 第二\n本文 B';
  const editor = await openMarkdown(page, content);
  await editor.press('Control+Home'); await editor.press('Control+Shift+BracketLeft');
  await expect(editor.getByRole('button', { name: '第一を展開', exact: true })).toBeVisible();
  await editor.press('Control+Shift+BracketRight');
  await expect(editor.getByRole('button', { name: '第一を折り畳む', exact: true })).toBeVisible();
  await editor.press('Control+Alt+[');
  await expect(editor.locator('.cm-line').filter({ hasText: '本文 A' })).toHaveCount(0);
  await expect(editor.locator('.cm-line').filter({ hasText: '本文 B' })).toHaveCount(0);
  await editor.press('Control+Alt+]');
  await expect(editor.locator('.cm-line').filter({ hasText: '本文 B' })).toBeVisible();
  await editor.press('Control+End'); await page.keyboard.insertText('追記'); await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe(content + '追記');
  await page.screenshot({ path: '.tools/qa/headings-folding.png' });
});

test('テーマの折り畳みは月境界を越えず、タブ・再起動後も復元する', async ({ page }) => {
  await connectTestVault(page);
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文', exact: true });
  await editor.getByRole('button', { name: '2026-10-31を折り畳む', exact: true }).click();
  await expect(editor.locator('.cm-line').filter({ hasText: '初回の試験' })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '2026-11-11を折り畳む', exact: true })).toBeVisible();
  await expect(editor.locator('.month-divider')).toHaveCount(2);
  await page.getByRole('button', { name: 'ピン留め', exact: true }).click();
  await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await page.getByRole('tab', { name: '耐久性評価', exact: true }).click();
  await expect(editor.getByRole('button', { name: '2026-10-31を展開', exact: true })).toBeVisible();
  await page.evaluate(() => window.__laminaClose());
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lamina.test.workspace') ?? '{}').panes?.[0]?.tabs?.[0]?.view?.folds?.length)).toBe(1);
  await page.reload();
  await expect(editor.getByRole('button', { name: '2026-10-31を展開', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '2026-10-31を展開', exact: true }).click();
  await expect(editor.locator('.cm-line').filter({ hasText: '初回の試験' })).toBeVisible();
});

test('箇条書きの上下移動で行や文字位置を飛ばさず、折り返しでも往復できる', async ({ page }) => {
  const editor = await openMarkdown(page, Array(6).fill('- 同じ項目の本文').join('\n'));
  for (const column of [2, 3, 5, 9]) {
    await editor.press('Control+Home'); for (let n = 2; n < column; n++) await editor.press('ArrowRight');
    const start = await caretPosition(editor);
    for (let line = 1; line < 6; line++) { await editor.press('ArrowDown'); const caret = await caretPosition(editor); expect(caret.line).toBe(line); expect(caret.offset).toBe(column); expect(Math.abs(caret.x - start.x)).toBeLessThan(1); }
    for (let line = 4; line >= 0; line--) { await editor.press('ArrowUp'); const caret = await caretPosition(editor); expect(caret.line).toBe(line); expect(caret.offset).toBe(column); }
  }
  await editor.press('Control+a'); await page.keyboard.insertText('- ' + '折り返しを含む長い技術ノートの記録。'.repeat(12) + '\n- 次の項目');
  await editor.press('Control+Home');
  const start = await caretPosition(editor); await editor.press('ArrowDown'); const wrapped = await caretPosition(editor);
  expect(wrapped.line).toBe(0); expect(wrapped.offset).toBeGreaterThan(2); expect(wrapped.y).toBeGreaterThan(start.y);
  await editor.press('ArrowUp'); expect((await caretPosition(editor)).offset).toBe(2);
});

test('本文と入れ子リスト・装飾が混在しても上下で隣の表示行へ進む', async ({ page }) => {
  const editor = await openMarkdown(page, '通常の文章。\n\n- 親項目\n    - 子項目\n    - **太字**と`code`\n- [ ] タスク\n\n通常の文章に戻る。');
  await editor.press('Control+Home');
  let before = await caretPosition(editor);
  for (const line of [1, 2, 3, 4, 5, 6, 7]) {
    await editor.press('ArrowDown'); const current = await caretPosition(editor);
    expect(current.line).toBe(line); expect(current.y).toBeGreaterThan(before.y); expect(current.y - before.y).toBeLessThan(34);
    if (line >= 2 && line <= 5) expect(current.offset).toBeGreaterThanOrEqual(line === 3 || line === 4 ? 6 : 2);
    before = current;
  }
  for (const line of [6, 5, 4, 3, 2, 1, 0]) { await editor.press('ArrowUp'); const current = await caretPosition(editor); expect(current.line).toBe(line); expect(current.y).toBeLessThan(before.y); before = current; }
});

test('左端の目標列から長い箇条書きを上下しても、折り返しの表示行を飛ばさない', async ({ page }) => {
  const editor = await openMarkdown(page, '前の行\n- ' + '折り返しを確認する文章。'.repeat(22) + '\n次の行');
  await editor.press('Control+Home'); await editor.press('ArrowDown');
  let before = await caretPosition(editor); expect(before.line).toBe(1); expect(before.offset).toBe(2);
  let wrapped = 0;
  for (let n = 0; n < 20; n++) {
    await editor.press('ArrowDown'); const current = await caretPosition(editor);
    expect(current.y - before.y).toBeGreaterThan(20); expect(current.y - before.y).toBeLessThan(34);
    if (current.line === 2) { before = current; break; }
    expect(current.line).toBe(1); wrapped++; before = current;
  }
  expect(wrapped).toBeGreaterThan(2); expect(before.line).toBe(2);
  for (let n = 0; n < wrapped + 1; n++) { await editor.press('ArrowUp'); const current = await caretPosition(editor); expect(current.line).toBe(1); expect(before.y - current.y).toBeGreaterThan(20); expect(before.y - current.y).toBeLessThan(34); before = current; }
  expect(before.offset).toBe(2); await editor.press('ArrowUp'); expect((await caretPosition(editor)).line).toBe(0);
});

test('リストの記号や字下げにHome・左右キー・クリックでキャレットが入らない', async ({ page }) => {
  const editor = await openMarkdown(page, '- 親項目\n    - 子項目\n    1. 番号項目\n本文');
  await editor.press('Control+Home'); expect((await caretPosition(editor)).offset).toBe(2);
  await editor.press('ArrowDown'); await editor.press('Home'); expect((await caretPosition(editor)).offset).toBe(6);
  await editor.press('ArrowLeft'); expect((await caretPosition(editor)).line).toBe(0);
  await editor.press('ArrowRight'); expect(await caretPosition(editor)).toMatchObject({ line: 1, offset: 6 });
  const line = (await editor.locator('.cm-line').nth(1).boundingBox())!; await page.mouse.click(line.x + 42 + 2, line.y + line.height / 2); expect(await caretPosition(editor)).toMatchObject({ line: 1, offset: 6 });
  await editor.press('ArrowDown'); await editor.press('Home'); expect(await caretPosition(editor)).toMatchObject({ line: 2, offset: 7 });
  await editor.press('Control+a'); await page.keyboard.insertText('全体を置き換える。'); await editor.press('Control+z'); await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('- 親項目\n    - 子項目\n    1. 番号項目\n本文');
});

test('メモの目次に日付以外の見出しを階層表示し、編集とクリック移動を反映する', async ({ page }) => {
  const editor = await openMarkdown(page, '# 目的\n\n## **試験条件**\n\n説明。\n\n### 詳細\n\n```md\n## コード内の例\n```\n\nまとめ\n====\n');
  if (await page.getByRole('button', { name: '右サイドバーを切り替え' }).getAttribute('aria-pressed') !== 'true') await page.getByRole('button', { name: '右サイドバーを切り替え' }).click();
  await page.getByRole('tab', { name: '目次', exact: true }).click(); const outline = page.getByRole('navigation', { name: '本文の目次', exact: true });
  await expect(outline.getByRole('button')).toHaveText(['目的', '試験条件', '詳細', 'まとめ']);
  await expect(outline.getByRole('button', { name: '詳細', exact: true })).toHaveAttribute('data-heading-level', '3');
  await outline.getByRole('button', { name: '試験条件', exact: true }).click(); await expect(editor).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent)).toContain('試験条件');
  await editor.press('Control+End'); await page.keyboard.insertText('\n## 次に試すこと\n'); await expect(outline.getByRole('button', { name: '次に試すこと', exact: true })).toBeVisible();
});

test('テーマの目次は月をまたいで全見出しを拾い、選んだ月の位置へ移動する', async ({ page }) => {
  await connectTestVault(page); await page.evaluate(() => { window.__laminaFixture.files['テーマ/耐久性評価/2026-10.md'].content = '# 2026-10-31\n## 前月の結論\n本文。\n```md\n'; window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content = '# 2026-11-13\n## 今月の計画\n本文。\n'; });
  await page.getByRole('navigation', { name: 'テーマ', exact: true }).getByRole('button', { name: '耐久性評価', exact: true }).click();
  await page.getByRole('tab', { name: '目次', exact: true }).click(); const outline = page.getByRole('navigation', { name: '本文の目次', exact: true });
  await expect(outline.getByRole('button')).toHaveText(['2026-10-31', '前月の結論', '2026-11-13', '今月の計画']);
  await outline.getByRole('button', { name: '今月の計画', exact: true }).click(); await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent)).toContain('今月の計画');
  await outline.getByRole('button', { name: '前月の結論', exact: true }).click(); await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent)).toContain('前月の結論');
});

test('Tabで親のない階層を作らず、子孫をまとめて字下げ・解除・Undoできる', async ({ page }) => {
  const editor = await openMarkdown(page, '- 前の項目\n- 親になる項目\n    - 子の項目\n- 次の項目');
  await editor.press('Control+Home'); await editor.press('Tab'); await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('- 前の項目\n- 親になる項目\n    - 子の項目\n- 次の項目');
  await editor.press('ArrowDown'); await editor.press('End'); await editor.press('Tab'); await editor.press('Control+s');
  const nested = '- 前の項目\n    - 親になる項目\n        - 子の項目\n- 次の項目';
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe(nested);
  await editor.press('Tab'); await editor.press('Tab'); await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe(nested);
  await editor.press('Shift+Tab'); await editor.press('Control+z');
  await expect.poll(() => editor.locator('.cm-line').allTextContents().then(lines => lines.join('\n'))).toBe(nested);
});

test('右ペインの最後のタブを閉じたら左だけに戻し、再起動後も分割しない', async ({ page }) => {
  await connectTestVault(page); await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  await page.getByRole('button', { name: '左右分割を切り替え' }).click();
  const left = page.getByRole('region', { name: '左ペイン', exact: true }), right = page.getByRole('region', { name: '右ペイン', exact: true });
  await right.getByRole('textbox').press('Control+End'); await page.keyboard.insertText('右で追記した記録');
  await right.getByRole('button', { name: '耐久性評価を閉じる', exact: true }).click(); await expect(right).toHaveCount(0);
  await expect(left.getByRole('textbox')).toContainText('右で追記した記録');
  await expect(left.getByRole('textbox')).toBeFocused();
  await expect(page.getByRole('button', { name: '左右分割を切り替え' })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Control+s'); await page.reload(); await expect(left.getByRole('textbox')).toBeVisible(); await expect(right).toHaveCount(0);
});

test('リストのShift+Enter・Backspace・空項目のEnterをキーボードで使える', async ({ page }) => {
  const editor = await openMarkdown(page, '- 親\n    - 子');
  await editor.press('Control+End'); await editor.press('Shift+Enter'); await page.keyboard.insertText('子の説明');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('- 親\n    - 子\n      子の説明');
  await editor.press('Control+Home'); await editor.press('ArrowDown');
  await editor.press('Backspace'); await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('- 親\n- 子\n  子の説明');
  await editor.press('Control+End'); await editor.press('Enter'); await editor.press('Enter'); await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).not.toMatch(/- $/);
});

test('右ペインに別のタブが残っていれば閉じず、保存失敗でも右ペインを保持する', async ({ page }) => {
  await connectTestVault(page); await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  await page.getByRole('button', { name: '左右分割を切り替え' }).click();
  const right = page.getByRole('region', { name: '右ペイン', exact: true }); await right.getByRole('button', { name: 'ピン留め', exact: true }).click();
  await right.getByRole('textbox').click(); await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await right.getByRole('button', { name: '試験の手順を閉じる', exact: true }).click(); await expect(right.getByRole('textbox', { name: '耐久性評価の本文' })).toBeVisible();
  await right.getByRole('textbox').press('Control+End'); await page.keyboard.insertText('保存待ちの追記'); await page.evaluate(() => { window.__laminaFixture.failure = true; });
  await right.getByRole('button', { name: '耐久性評価を閉じる', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('保存できません'); await expect(right.getByRole('textbox')).toContainText('保存待ちの追記');
  await page.evaluate(() => { window.__laminaFixture.failure = false; }); await right.getByRole('button', { name: '耐久性評価を閉じる', exact: true }).click(); await expect(right).toHaveCount(0);
});

test('再起動すると保管庫・タブ・ピン留め・分割と左右それぞれの編集位置が戻る', async ({ page }) => {
  await connectTestVault(page);
  await page.evaluate(() => { window.__laminaFixture.files['メモ/試験の手順.md'].content = Array.from({ length: 100 }, (_, i) => `測定の記録 ${i + 1}`).join('\n'); });
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  await page.getByRole('button', { name: 'ピン留め', exact: true }).click();
  await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await page.getByRole('button', { name: '左右分割を切り替え' }).click();
  const left = page.getByRole('region', { name: '左ペイン', exact: true });
  const right = page.getByRole('region', { name: '右ペイン', exact: true });
  const leftEditor = left.getByRole('textbox', { name: '試験の手順の本文' });
  const rightEditor = right.getByRole('textbox', { name: '試験の手順の本文' });
  await leftEditor.focus();
  await leftEditor.press('Control+End');
  await page.keyboard.insertText('【末尾】');
  await expect.poll(() => left.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBeGreaterThan(500);
  await rightEditor.focus();
  await rightEditor.press('Control+Home');
  await page.getByRole('button', { name: '右サイドバーを切り替え' }).click();
  await page.getByRole('button', { name: 'サイドバーを閉じる' }).click();
  await rightEditor.press('Control+s');
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('lamina.test.workspace')!)) as WorkspaceSession;
  expect(session).toMatchObject({ split: true, activePane: 1, outline: false, sidebar: false });
  expect(session.panes[0].tabs[0]).toMatchObject({ id: 'テーマ/耐久性評価', pinned: true });
  expect(session.panes[0].tabs[1].view?.scrollTop).toBeGreaterThan(500);
  await page.reload();
  await expect(page.getByRole('button', { name: 'サイドバーを開く' })).toBeVisible();
  await expect(page.getByRole('button', { name: '右サイドバーを切り替え' })).toHaveAttribute('aria-pressed', 'false');
  await expect(left.getByRole('tab')).toHaveCount(2);
  await expect(left.getByRole('button', { name: 'ピン留めを解除', exact: true })).toBeVisible();
  await expect(rightEditor).toBeFocused();
  await expect.poll(() => left.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBeGreaterThan(500);
  await expect.poll(() => right.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBe(0);
  await page.keyboard.insertText('【右再開】');
  await rightEditor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toMatch(/^【右再開】測定の記録 1/);
  await leftEditor.focus();
  await page.keyboard.insertText('【左再開】');
  await leftEditor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toMatch(/【末尾】【左再開】$/);
});

test('タブを切り替えて戻ってもカーソルとスクロール位置を保つ', async ({ page }) => {
  await connectTestVault(page);
  await page.evaluate(() => { window.__laminaFixture.files['メモ/試験の手順.md'].content = Array.from({ length: 100 }, (_, i) => `手順${i}`).join('\n'); });
  await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '試験の手順の本文' });
  await editor.press('Control+End');
  await page.keyboard.insertText('【末尾】');
  await expect.poll(() => page.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBeGreaterThan(500);
  await page.getByRole('button', { name: 'ピン留め', exact: true }).click();
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  await page.getByRole('tab', { name: '試験の手順', exact: true }).click();
  await expect(editor).toBeFocused();
  await expect.poll(() => page.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBeGreaterThan(500);
  await page.keyboard.insertText('【続き】');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toMatch(/【末尾】【続き】$/);
});

test('復元先の一部が削除されていても残りのタブを開き、欠落だけを知らせる', async ({ page }) => {
  await connectTestVault(page);
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  await page.getByRole('button', { name: 'ピン留め', exact: true }).click();
  await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await page.keyboard.press('Control+s');
  await page.evaluate(() => {
    const disk = JSON.parse(localStorage.getItem('lamina.test.disk') ?? JSON.stringify({ files: window.__laminaFixture.files, themes: ['耐久性評価'], counter: 100 }));
    delete disk.files['メモ/試験の手順.md'];
    localStorage.setItem('lamina.test.disk', JSON.stringify(disk));
  });
  await page.reload();
  await expect(page.getByRole('textbox', { name: '耐久性評価の本文' })).toBeVisible();
  await expect(page.getByRole('region', { name: '左ペイン', exact: true }).getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('alert')).toContainText('メモ/試験の手順.md');
});

for (const failure of ['failure', 'sessionFailure'] as const) {
  test(`${failure === 'failure' ? '本文' : '画面状態'}の保存に失敗すると終了せず、再試行後は保存して終了する`, async ({ page }) => {
    await connectTestVault(page);
    await page.getByRole('button', { name: '試験の手順', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '試験の手順の本文' });
    await editor.press('Control+End');
    await page.keyboard.insertText('終了前の追記');
    await page.evaluate(key => { window.__laminaFixture[key] = true; }, failure);
    await page.evaluate(() => window.__laminaClose());
    await expect(page.getByRole('alert')).toContainText('保存できません');
    expect(await page.evaluate(() => window.__laminaFixture.destroyed)).toBe(0);
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(editor).toContainText('終了前の追記');
    await page.evaluate(key => { window.__laminaFixture[key] = false; window.__laminaFixture.operations.length = 0; }, failure);
    await editor.press('End');
    await page.keyboard.insertText('再試行分');
    await page.evaluate(() => window.__laminaClose());
    const result = await page.evaluate(() => window.__laminaFixture);
    expect(result.destroyed).toBe(1);
    expect(result.operations).toEqual(['document', 'workspace', 'destroy']);
    expect(result.files['メモ/試験の手順.md'].content).toContain('終了前の追記再試行分');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('終了中は追加の編集を受け付けず、閉じる要求が重複しても一度だけ終了する', async ({ page }) => {
  await connectTestVault(page);
  await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '試験の手順の本文' });
  await editor.press('Control+End');
  await page.keyboard.insertText('保存待ちの本文');
  await page.evaluate(() => { window.__laminaFixture.holdSave = true; void window.__laminaClose(); void window.__laminaClose(); });
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.pendingSaves)).toBe(1);
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
  await page.keyboard.insertText('終了中の入力');
  await page.evaluate(() => window.__laminaFixture.releaseSave?.());
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.destroyed)).toBe(1);
  const saved = await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content);
  expect(saved).toContain('保存待ちの本文');
  expect(saved).not.toContain('終了中の入力');
});

test('画面状態の形式が未対応でも本文を開いて編集できる', async ({ page }) => {
  await connectTestVault(page);
  await page.evaluate(() => { localStorage.setItem('lamina.test.workspace', JSON.stringify({ version: 99, panes: [] })); });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('画面状態を復元できません');
  await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '試験の手順の本文' });
  await expect(editor).toContainText('記録先を確認する。');
  await editor.press('Control+End');
  await page.keyboard.insertText('本文の編集は継続できる。');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toContain('本文の編集は継続できる。');
});

async function openMarkdown(page: Page, content: string) {
  await connectTestVault(page);
  await page.evaluate(text => { window.__laminaFixture.files['メモ/試験の手順.md'].content = text; }, content);
  await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  return page.getByRole('textbox', { name: '試験の手順の本文' });
}

async function pasteResource(page: Page, text: string, html = '') {
  await page.locator('.cm-editor.cm-focused .cm-content').evaluate((editor, { text, html }) => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', text); if (html) clipboard.setData('text/html', html);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, { text, html });
}
async function seedMaterials(page: Page) {
  const entries = [
    { ...materialDraft('C:\\試験\\評価.xlsx'), memo: '荷重と温度の比較。', themes: ['耐久性評価'], added: '2026-11-01' },
    { ...materialDraft('\\\\server\\開発\\手順.pdf'), memo: '計測器の準備。', themes: [], added: '2026-11-03' },
    { ...materialDraft('https://team.sharepoint.com/:x:/s/dev/new?e=abc', undefined, '新しい評価.xlsx'), memo: '更新された条件。', themes: ['振動対策'], added: '2026-11-04' },
  ];
  await page.evaluate(entries => {
    for (const [i, entry] of entries.entries()) window.__laminaFixture.files[`資料/${entry.title}.md`] = { content: entry.content, revision: `resource-${i}` };
  }, entries.map((entry, index) => ({ title: entry.title, content: writeMaterial(entry) + `\n詳しい説明${index + 1}。\n` })));
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
}

test('資料：引用符付きパスを登録し、通常リンク・種類アイコン・ワンクリック起動・Undoを保持する', async ({ page }) => {
  const editor = await openMarkdown(page, '資料を確認する。\n\n'); await editor.press('Control+End');
  await pasteResource(page, '"C:\\試験\\結果 #1.xlsx"');
  const dialog = page.getByRole('dialog', { name: '資料を登録', exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '資料名', exact: true })).toHaveValue('結果 #1.xlsx');
  await expect(dialog.getByRole('combobox', { name: '資料の種類' })).toHaveValue('excel');
  await dialog.getByRole('button', { name: '登録して挿入', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(editor).toBeFocused(); await editor.press('Control+Home');
  const link = page.locator('a.cm-resource-link'); await expect(link).toHaveText('結果 #1.xlsx'); await expect(link.locator('svg')).toHaveClass(/type-excel/);
  await link.click(); await expect.poll(() => page.evaluate(() => window.__laminaFixture.openedUrls)).toContain('C:\\試験\\結果 #1.xlsx');
  const disk = await page.evaluate(() => window.__laminaFixture.files);
  expect(disk['メモ/試験の手順.md'].content).toContain('[結果 #1.xlsx](file:///C:/'); expect(disk['メモ/試験の手順.md'].content).toContain('%231.xlsx');
  expect(disk['資料/結果 #1.xlsx.md'].content).toContain("added: '2026-11-12'"); expect(disk['資料/結果 #1.xlsx.md'].content).not.toMatch(/\bid:/);
  await page.getByRole('button', { name: '結果 #1.xlsxの資料詳細', exact: true }).click();
  await page.getByRole('complementary', { name: '資料の詳細', exact: true }).getByRole('button', { name: 'プロパティ', exact: true }).click();
  const properties = page.getByRole('dialog', { name: '資料のプロパティ', exact: true }); await properties.getByRole('combobox', { name: '資料の種類' }).selectOption('pdf'); await properties.getByRole('button', { name: '変更を保存', exact: true }).click(); await expect(properties).not.toBeVisible();
  await editor.press('Control+Home'); await expect(link.locator('svg')).toHaveClass(/type-pdf/);
  // Reopen after property edits, then verify one insertion is one undo step.
  await editor.press('Control+z'); await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('資料を確認する。\n\n');
  expect(await page.evaluate(() => Object.keys(window.__laminaFixture.files).filter(path => path.startsWith('資料/')))).toHaveLength(1);
  await editor.press('Control+Shift+z'); await editor.press('Control+s'); await editor.press('Control+Home'); await expect(link).toBeVisible();
});

test('本文の資料情報は右に詳細を開き、メモ・参照元・プロパティ編集を一覧と共通にする', async ({ page }) => {
  const editor = await openMarkdown(page, '# 記録\n\n[評価表](file:///C:/試験/評価.xlsx)\n\n末尾');
  await seedMaterials(page);
  await page.getByRole('button', { name: '右サイドバーを切り替え', exact: true }).click();
  await page.getByRole('button', { name: '評価表の資料詳細', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '資料の詳細', exact: true });
  await expect(detail).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(detail.getByRole('heading', { name: '評価.xlsx', exact: true })).toBeVisible();
  await expect(detail).toContainText('荷重と温度の比較。'); await expect(detail).toContainText('耐久性評価');
  await expect(detail.getByRole('button').filter({ hasText: '試験の手順' })).toContainText('評価表');
  await expect(editor).toBeVisible(); await expect(page.getByRole('tab', { name: '試験の手順', exact: true })).toHaveAttribute('aria-selected', 'true');
  await detail.getByRole('button', { name: '資料を開く', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.openedUrls)).toContain('C:\\試験\\評価.xlsx');
  await detail.getByRole('button', { name: 'プロパティ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '資料のプロパティ', exact: true });
  await dialog.getByRole('textbox', { name: '資料のメモ', exact: true }).fill('変更したメモ。\n二行目。');
  await dialog.getByRole('button', { name: '変更を保存', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(detail).toContainText('変更したメモ。'); await expect(detail).toContainText('二行目。');
  await page.screenshot({ path: '.tools/qa/inline-material-detail.png' });
  await detail.getByRole('button', { name: '資料の詳細を閉じる', exact: true }).click(); await expect(detail).toHaveCount(0); await expect(editor).toBeFocused();
  await page.getByRole('button', { name: '資料一覧', exact: true }).click(); await page.getByRole('button', { name: '評価.xlsxの詳細', exact: true }).click();
  await expect(detail).toContainText('変更したメモ。'); await expect(detail).toContainText('二行目。');
});

test('資料：SharePointのURLとファイル名情報を保ち、登録済み資料とテーマを再利用する', async ({ page }) => {
  await connectTestVault(page); await page.getByRole('navigation', { name: 'テーマ', exact: true }).getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文', exact: true }); await editor.press('Control+End');
  const url = 'https://team.sharepoint.com/:x:/s/Dev/ABC?e=a%2Bb&d=123';
  await pasteResource(page, url, `<a href="${url.replace('&', '&amp;')}">測定結果.xlsx</a>`);
  const dialog = page.getByRole('dialog', { name: '資料を登録', exact: true });
  await expect(dialog.getByRole('textbox', { name: '資料名', exact: true })).toHaveValue('測定結果.xlsx');
  await expect(dialog.getByRole('checkbox', { name: '耐久性評価', exact: true })).toBeChecked();
  await dialog.getByLabel('資料の追加日', { exact: true }).fill('2026-10-01'); await dialog.getByRole('textbox', { name: '資料のメモ' }).fill('既存の説明');
  await dialog.getByRole('button', { name: '登録して挿入', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await editor.press('Control+End'); await pasteResource(page, url);
  const existing = page.getByRole('dialog', { name: '資料のプロパティ', exact: true }); await expect(existing).toContainText('登録済み'); await expect(existing.getByLabel('資料の追加日', { exact: true })).toHaveValue('2026-10-01'); await expect(existing.getByRole('textbox', { name: '資料のメモ' })).toHaveValue('既存の説明');
  await existing.getByRole('button', { name: '登録して挿入', exact: true }).click(); await expect(existing).not.toBeVisible();
  const files = await page.evaluate(() => window.__laminaFixture.files), materials = Object.entries(files).filter(([path]) => path.startsWith('資料/'));
  expect(materials).toHaveLength(1); expect(materials[0][1].content).toContain(url); expect(files['テーマ/耐久性評価/2026-11.md'].content.split(url)).toHaveLength(3);
});

test('資料：一覧で編集・フィルタ・参照元を確認し、資料本文と一覧タブを復元できる', async ({ page }) => {
  await connectTestVault(page); await seedMaterials(page);
  await page.evaluate(() => { window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content = '# 2026-11-12\n\n条件Aを試験した。\n[測定表](file:///C:/%E8%A9%A6%E9%A8%93/%E8%A9%95%E4%BE%A1.xlsx)\n温度は安定した。'; });
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click(); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await page.getByRole('button', { name: '資料一覧', exact: true }).click(); await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('textbox', { name: '評価.xlsxのメモ', exact: true }).fill('比較に使う最新版。'); await page.getByRole('textbox', { name: '評価.xlsxのメモ', exact: true }).press('Tab');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['資料/評価.xlsx.md'].content)).toContain('比較に使う最新版。');
  await page.getByRole('combobox', { name: '種類で絞り込み' }).selectOption('pdf'); await expect(page.getByRole('button', { name: '手順.pdfの詳細', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '評価.xlsxの詳細', exact: true })).not.toBeVisible();
  await page.getByRole('combobox', { name: '種類で絞り込み' }).selectOption(''); await page.getByRole('combobox', { name: 'テーマで絞り込み' }).selectOption('耐久性評価'); await expect(page.getByRole('button', { name: '評価.xlsxの詳細', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '評価.xlsxの詳細', exact: true }).click(); const detail = page.getByRole('complementary', { name: '資料の詳細' }); await expect(detail).toContainText('比較に使う最新版。'); await expect(detail).toContainText('条件Aを試験した。'); await expect(detail).toContainText('2026-11-12');
  await detail.getByRole('button', { name: '資料ページ・詳しい説明を開く ↗', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '評価.xlsxの本文', exact: true }); await expect(editor).toContainText('詳しい説明1。'); await expect(editor).not.toContainText('themes:'); await editor.press('Control+End'); await page.keyboard.insertText('本文への追記。'); await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['資料/評価.xlsx.md'].content)).toContain('本文への追記。');
  await page.getByRole('button', { name: '資料一覧', exact: true }).click(); await page.keyboard.press('Control+s'); await page.reload(); await expect(page.getByRole('table')).toBeVisible();
});

test('資料：パス修正で参照リンクだけを一括更新し、表示名とコードを保持する', async ({ page }) => {
  const old = 'https://example.com/old?e=ABC', next = 'https://example.com/new?e=XYZ';
  const editor = await openMarkdown(page, `[独自のラベル](${old})\n\n本文 ${old}\n\n\`[コード](${old})\`\n`);
  await page.evaluate(content => { window.__laminaFixture.files['資料/例.md'] = { content, revision: 'resource' }; }, writeMaterial({ ...materialDraft(old), title: '参考ページ', added: '2026-11-01' }));
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click(); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', ''); await editor.press('Control+End');
  await page.getByRole('button', { name: '独自のラベルの資料詳細', exact: true }).click();
  await page.getByRole('complementary', { name: '資料の詳細', exact: true }).getByRole('button', { name: 'プロパティ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '資料のプロパティ', exact: true }); await dialog.getByRole('textbox', { name: '資料のパス・URL' }).fill(next); await expect(dialog).toContainText('1か所・1ファイル'); await dialog.getByRole('button', { name: '変更を保存', exact: true }).click(); await expect(dialog).not.toBeVisible();
  const content = await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content); expect(content).toContain(`[独自のラベル](${next})`); expect(content).toContain(`本文 ${old}`); expect(content).toContain(`\`[コード](${old})\``);
});

test('資料：2件を統合してメモ・詳しい説明・テーマ・リンクを保持し、資料ページを1件にする', async ({ page }) => {
  await connectTestVault(page); await seedMaterials(page);
  await page.evaluate(() => { window.__laminaFixture.files['メモ/試験の手順.md'].content = '[古い表](file:///C:/%E8%A9%A6%E9%A8%93/%E8%A9%95%E4%BE%A1.xlsx) と [新しい表](https://team.sharepoint.com/:x:/s/dev/new?e=abc)\n\n[[資料/新しい評価.xlsx]]'; });
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click(); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', ''); await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  await page.getByRole('checkbox', { name: '評価.xlsxを選択', exact: true }).check(); await page.getByRole('checkbox', { name: '新しい評価.xlsxを選択', exact: true }).check(); await page.getByRole('button', { name: '選択した2件を統合', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '資料を統合', exact: true }); await expect(dialog.getByRole('textbox', { name: '資料のメモ' })).toHaveValue(/荷重と温度の比較。\n\n更新された条件。/); await expect(dialog.getByRole('textbox', { name: '統合後の詳しい説明' })).toHaveValue(/詳しい説明1。/); await expect(dialog.getByRole('textbox', { name: '統合後の詳しい説明' })).toHaveValue(/詳しい説明3。/);
  await dialog.getByRole('combobox', { name: '残すパス', exact: true }).selectOption('https://team.sharepoint.com/:x:/s/dev/new?e=abc'); await dialog.getByRole('button', { name: '統合して保存', exact: true }).click(); await expect(dialog).not.toBeVisible();
  const files = await page.evaluate(() => window.__laminaFixture.files); expect(files['資料/新しい評価.xlsx.md']).toBeUndefined(); expect(files['資料/評価.xlsx.md'].content).toContain('詳しい説明3。'); expect(files['資料/評価.xlsx.md'].content).toContain('振動対策'); expect(files['メモ/試験の手順.md'].content).toContain('[古い表](https://team.sharepoint.com/:x:/s/dev/new?e=abc)'); expect(files['メモ/試験の手順.md'].content).not.toContain('[[資料/新しい評価.xlsx]]');
});

test('資料：キャンセル・保存失敗・外部変更で元の本文と資料を保持する', async ({ page }) => {
  const editor = await openMarkdown(page, '元の本文。\n\n'); await editor.press('Control+End'); await pasteResource(page, 'https://example.com/a');
  let dialog = page.getByRole('dialog', { name: '資料を登録', exact: true }); await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click(); await expect(dialog).not.toBeVisible(); expect(await page.evaluate(() => Object.keys(window.__laminaFixture.files).filter(path => path.startsWith('資料/')))).toHaveLength(0);
  await editor.press('Control+End'); await pasteResource(page, 'https://example.com/a'); dialog = page.getByRole('dialog', { name: '資料を登録', exact: true });
  await page.evaluate(() => { window.__laminaFixture.operationFailure = true; }); await dialog.getByRole('button', { name: '登録して挿入', exact: true }).click(); await expect(dialog).toBeVisible(); await expect(dialog.getByRole('alert')).toContainText('保存失敗');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('元の本文。\n\n');
  await page.evaluate(() => { window.__laminaFixture.operationFailure = false; window.__laminaFixture.files['メモ/試験の手順.md'] = { content: '外部で変更された本文。', revision: 'external' }; });
  await dialog.getByRole('button', { name: '登録して挿入', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('本文が変更されています'); expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('外部で変更された本文。');
});

test('資料：クリップボードの別名とネイティブドロップのフォルダー情報を使い、コード内は登録しない', async ({ page }) => {
  const editor = await openMarkdown(page, '資料の挿入先。\n\n'); await editor.press('Control+End');
  await page.evaluate(() => { window.__laminaFixture.clipboard = { paths: ['C:\\Files\\token-file'], title: '表示名.xlsx', text: null }; window.__laminaFixture.resourceFolders = ['\\\\server\\開発\\共有']; });
  await pasteResource(page, '"C:\\Files\\token-file"');
  let dialog = page.getByRole('dialog', { name: '資料を登録', exact: true }); await expect(dialog.getByRole('textbox', { name: '資料名', exact: true })).toHaveValue('表示名.xlsx'); await expect(dialog.getByRole('combobox', { name: '資料の種類' })).toHaveValue('excel'); await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click(); await expect(dialog).not.toBeVisible();
  const bounds = (await editor.boundingBox())!;
  await page.evaluate(({ x, y }) => window.__laminaDrop(['\\\\server\\開発\\共有'], x, y), { x: bounds.x + 80, y: bounds.y + 30 });
  dialog = page.getByRole('dialog', { name: '資料を登録', exact: true }); await expect(dialog.getByRole('combobox', { name: '資料の種類' })).toHaveValue('folder'); await dialog.getByRole('button', { name: '登録して挿入', exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => window.__laminaFixture.files['資料/共有.md'].content)).toContain('type: folder');
  await editor.press('Control+End'); await page.keyboard.insertText('\n\n```text\n\n```'); await editor.press('ArrowUp'); await pasteResource(page, 'https://example.com/code-sample');
  await expect(page.getByRole('dialog', { name: '資料を登録', exact: true })).not.toBeVisible(); await expect(editor).toContainText('https://example.com/code-sample');
});

test('資料：不正なYAMLを修復し、一覧内のEscape取消とテーマ改名を反映できる', async ({ page }) => {
  await connectTestVault(page); await seedMaterials(page);
  await page.evaluate(() => { window.__laminaFixture.files['資料/修復する資料.md'] = { content: '---\ntitle: [壊れたYAML\n---\n本文。', revision: 'broken' }; });
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click(); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', ''); await page.getByRole('button', { name: '資料一覧', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('読み込めない資料ページ');
  await page.getByRole('button', { name: /^資料\/修復する資料.md —/ }).click();
  const repair = page.getByRole('textbox', { name: '修復する資料の本文', exact: true }); await repair.press('Control+a'); await page.keyboard.insertText(writeMaterial({ ...materialDraft('https://example.com/fixed'), title: '修復完了', added: '2026-11-12' })); await repair.press('Control+s');
  await page.getByRole('button', { name: '資料一覧', exact: true }).click(); await expect(page.getByRole('button', { name: '修復完了の詳細', exact: true })).toBeVisible();
  const memo = page.getByRole('textbox', { name: '評価.xlsxのメモ', exact: true }); await memo.fill('取り消す変更'); await memo.press('Escape'); expect(await page.evaluate(() => window.__laminaFixture.files['資料/評価.xlsx.md'].content)).not.toContain('取り消す変更');
  await page.getByRole('navigation', { name: 'テーマ', exact: true }).getByLabel('テーマ/耐久性評価の操作', { exact: true }).click(); await page.getByRole('menuitem', { name: '名前を変更', exact: true }).click(); const rename = page.getByRole('dialog', { name: '名前を変更', exact: true }); await rename.getByRole('textbox', { name: '名前', exact: true }).fill('耐久試験'); await rename.getByRole('button', { name: '変更', exact: true }).click(); await expect(rename).not.toBeVisible();
  expect(await page.evaluate(() => window.__laminaFixture.files['資料/評価.xlsx.md'].content)).toContain('耐久試験'); expect(await page.evaluate(() => window.__laminaFixture.files['資料/評価.xlsx.md'].content)).not.toContain('耐久性評価');
});

async function createTestFolder(page: Page, name: string) {
  await page.getByRole('button', { name: 'メモのフォルダーを作成', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新しいメモフォルダー', exact: true });
  await dialog.getByRole('textbox', { name: '名前', exact: true }).fill(name);
  await dialog.getByRole('button', { name: '作成', exact: true }).click(); await expect(dialog).not.toBeVisible();
}
test('フォルダー行からメモを追加し、子フォルダー内にも直接作成できる', async ({ page }) => {
  await connectTestVault(page); await createTestFolder(page, '評価');
  const nav = page.getByRole('navigation', { name: 'メモ', exact: true });
  await nav.getByRole('button', { name: '評価', exact: true }).click();
  await nav.getByRole('button', { name: 'メモ/評価にメモを追加', exact: true }).click();
  const noteDialog = page.getByRole('dialog', { name: '新しいメモ', exact: true });
  await expect(noteDialog).toContainText('作成先：メモ/評価');
  await noteDialog.getByRole('textbox', { name: 'メモのタイトル', exact: true }).fill('条件 #1');
  await noteDialog.getByRole('button', { name: '作成', exact: true }).click(); await expect(noteDialog).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '条件 #1の本文', exact: true })).toBeFocused();
  await page.keyboard.insertText('フォルダー内で記録を開始する。'); await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/評価/条件 #1.md']?.content)).toBe('フォルダー内で記録を開始する。');
  await nav.getByLabel('メモ/評価の操作', { exact: true }).click(); await page.getByRole('menuitem', { name: '子フォルダーを作成', exact: true }).click();
  const folderDialog = page.getByRole('dialog', { name: '新しいメモフォルダー', exact: true }); await expect(folderDialog).toContainText('作成先：メモ/評価');
  await folderDialog.getByRole('textbox', { name: '名前', exact: true }).fill('測定'); await folderDialog.getByRole('button', { name: '作成', exact: true }).click(); await expect(folderDialog).not.toBeVisible();
  await nav.getByLabel('メモ/評価/測定の操作', { exact: true }).click(); await page.getByRole('menuitem', { name: 'メモを追加', exact: true }).click();
  await noteDialog.getByRole('textbox', { name: 'メモのタイトル', exact: true }).fill('手順'); await noteDialog.getByRole('button', { name: '作成', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '手順の本文', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/評価/測定/手順.md']?.content)).toBe('');
  await page.reload(); await expect(nav.getByRole('button', { name: '手順', exact: true })).toBeVisible();
});

test('メモをドラッグでフォルダーへ移し、本文・参照リンク・画像パス・ピン留めを保持する', async ({ page }) => {
  const editor = await openMarkdown(page, '測定記録\n\n<img src="../添付/図.png" alt="図" width="320">\n\n');
  await page.evaluate(() => { window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content = '# 2026-11-12\n\n[[メモ/試験の手順]] と [[試験の手順|既存の別名]]\n'; });
  await createTestFolder(page, '整理');
  await editor.press('Control+End'); await page.keyboard.insertText('移動直前の追記');
  await page.getByRole('button', { name: 'ピン留め', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'メモ', exact: true });
  await nav.getByRole('button', { name: '試験の手順', exact: true }).dragTo(nav.getByRole('button', { name: '整理', exact: true }));
  await expect(nav.getByRole('button', { name: '試験の手順', exact: true })).toHaveAttribute('title', 'メモ/整理/試験の手順.md');
  await expect(page.getByRole('button', { name: 'ピン留めを解除', exact: true })).toBeVisible();
  const data = await page.evaluate(() => window.__laminaFixture.files);
  expect(data['メモ/試験の手順.md']).toBeUndefined();
  expect(data['メモ/整理/試験の手順.md'].content).toContain('移動直前の追記');
  expect(data['メモ/整理/試験の手順.md'].content).toContain('src="../../添付/図.png"');
  expect(data['テーマ/耐久性評価/2026-11.md'].content).toContain('[[試験の手順]] と [[試験の手順|既存の別名]]');
});

test('ドラッグ開始直後にドロップしても描画の待ち時間に依存せず移動できる', async ({ page }) => {
  await connectTestVault(page); await createTestFolder(page, '整理');
  await page.evaluate(() => {
    const source = document.querySelector('button[title="メモ/試験の手順.md"]')!;
    const target = document.querySelector('button[title="メモ/整理"]')!.closest('.nav-row')!;
    const start = source.getBoundingClientRect(), end = target.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0 };
    source.dispatchEvent(new PointerEvent('pointerdown', { ...options, clientX: start.x + 40, clientY: start.y + start.height / 2 }));
    window.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: end.x + 40, clientY: end.y + end.height / 2 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...options, clientX: end.x + 40, clientY: end.y + end.height / 2 }));
  });
  await expect(page.getByRole('navigation', { name: 'メモ', exact: true }).getByTitle('メモ/整理/試験の手順.md', { exact: true })).toBeVisible();
});

test('ドラッグで閉じたフォルダーを展開し、Escapeで移動を取り消せる', async ({ page }) => {
  await connectTestVault(page); await createTestFolder(page, '整理/子');
  const nav = page.getByRole('navigation', { name: 'メモ', exact: true }), folder = nav.getByRole('button', { name: '整理', exact: true });
  await folder.click(); await expect(folder).toHaveAttribute('aria-expanded', 'false');
  const note = nav.getByTitle('メモ/試験の手順.md', { exact: true }), start = (await note.boundingBox())!, end = (await folder.boundingBox())!;
  await page.mouse.move(start.x + 50, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(end.x + 50, end.y + end.height / 2, { steps: 8 });
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('group', { name: 'メモ直下への移動先', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.getByRole('group', { name: 'メモ直下への移動先', exact: true })).not.toBeVisible();
  await expect(note).toBeVisible(); await expect(folder).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toContain('記録先を確認する。');
});

test('メモ直下へドラッグで戻し、フォルダーも配下ごと別のフォルダーへ移せる', async ({ page }) => {
  await connectTestVault(page); await createTestFolder(page, '一時'); await createTestFolder(page, '保管');
  const nav = page.getByRole('navigation', { name: 'メモ', exact: true });
  const note = nav.getByRole('button', { name: '試験の手順', exact: true });
  await note.dragTo(nav.getByRole('button', { name: '一時', exact: true })); await expect(note).toHaveAttribute('title', 'メモ/一時/試験の手順.md');
  await nav.getByRole('button', { name: '一時', exact: true }).dragTo(nav.getByRole('button', { name: '保管', exact: true })); await expect(note).toHaveAttribute('title', 'メモ/保管/一時/試験の手順.md');
  const box = (await note.boundingBox())!; await page.mouse.move(box.x + 35, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 50, box.y + box.height / 2, { steps: 5 });
  const rootDrop = nav.getByRole('group', { name: 'メモ直下への移動先', exact: true }); await expect(rootDrop).toBeVisible();
  const target = (await rootDrop.boundingBox())!; await page.mouse.move(target.x + 50, target.y + target.height / 2, { steps: 8 }); await page.mouse.up();
  await expect(note).toHaveAttribute('title', 'メモ/試験の手順.md');
});

test('ドラッグの同名衝突・自分の子孫への移動・保存失敗では元のメモを保持する', async ({ page }) => {
  await connectTestVault(page); await createTestFolder(page, '整理/子');
  const nav = page.getByRole('navigation', { name: 'メモ', exact: true }), note = nav.getByRole('button', { name: '試験の手順', exact: true });
  await page.evaluate(() => { window.__laminaFixture.files['メモ/整理/試験の手順.md'] = { content: '移動先の既存メモ', revision: 'duplicate' }; });
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click(); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  const source = nav.getByTitle('メモ/試験の手順.md', { exact: true });
  await source.dragTo(nav.getByRole('button', { name: '整理', exact: true }));
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/整理/試験の手順.md'].content)).toBe('移動先の既存メモ');
  await nav.getByRole('button', { name: '整理', exact: true }).dragTo(nav.getByRole('button', { name: '子', exact: true }));
  await expect(nav.getByRole('button', { name: '整理', exact: true })).toHaveAttribute('title', 'メモ/整理');
  await page.evaluate(() => { window.__laminaFixture.operationFailure = true; });
  await source.dragTo(nav.getByRole('button', { name: '子', exact: true }));
  await expect(page.getByRole('alert')).toContainText('保存失敗'); await expect(source).toBeVisible();
  await page.evaluate(() => { window.__laminaFixture.operationFailure = false; });
  await source.dragTo(nav.getByRole('button', { name: '子', exact: true }));
  await expect(nav.getByTitle('メモ/整理/子/試験の手順.md', { exact: true })).toBeVisible();
  expect(await note.count()).toBe(2);
});

async function insertTestImage(page: Page, method: 'paste' | 'drop' = 'paste', label = '試験の手順の本文') {
  await page.getByRole('textbox', { name: label }).press('Control+End');
  await page.getByRole('textbox', { name: label }).evaluate(async (editor, method) => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 480;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f4f6f8'; context.fillRect(0, 0, 800, 480);
    context.fillStyle = '#dbe4eb'; context.fillRect(90, 120, 500, 180);
    context.strokeStyle = '#405c73'; context.lineWidth = 4; context.strokeRect(90, 120, 500, 180);
    context.fillStyle = '#25445d'; context.font = '24px sans-serif'; context.fillText('MEASUREMENT  1500 rpm / 3.0 kN', 90, 70);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], '測定結果.png', { type: 'image/png' }));
    editor.dispatchEvent(method === 'paste' ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }) : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, method);
  await expect(page.locator('.cm-image-frame.image-ready img')).toBeVisible();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await page.keyboard.press('Control+s');
}
async function drawAnnotation(page: Page, label: string, start: [number, number], end: [number, number]) {
  const dialog = page.getByRole('dialog', { name: '画像に注釈', exact: true });
  await dialog.getByRole('button', { name: label, exact: true }).click();
  const bounds = (await dialog.locator('.annotation-canvas canvas').boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * start[0], bounds.y + bounds.height * start[1]);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * end[0], bounds.y + bounds.height * end[1], { steps: 8 }); await page.mouse.up();
}

for (const method of ['paste', 'drop'] as const) test(`画像を${method === 'paste' ? '貼り付け' : 'ドロップ'}し、元画像・注釈情報・表示幅を保持して再開できる`, async ({ page }) => {
  await openMarkdown(page, '画像の記録\n\n');
  await insertTestImage(page, method);
  const saved = await page.evaluate(() => ({ note: window.__laminaFixture.files['メモ/試験の手順.md'].content, images: Object.values(window.__laminaFixture.images) }));
  expect(saved.note).toContain('width="640"'); expect(saved.note).toContain('../添付/');
  expect(saved.images).toHaveLength(1); expect(saved.images[0].annotation).toEqual({ version: 1, width: 800, height: 480, shapes: [] });
  expect(saved.images[0].original).toBe(saved.images[0].data);
  await page.reload(); await expect(page.locator('.cm-image-frame.image-ready img')).toBeVisible();
});

test('画像の幅をマウスで変更し、比率・元解像度・Undoと保存幅を保持する', async ({ page }) => {
  const editor = await openMarkdown(page, '画像の記録\n\n'); await insertTestImage(page);
  const image = page.locator('.cm-image-frame.image-ready img'); await image.click();
  const before = (await image.boundingBox())!;
  const handle = (await page.getByRole('button', { name: '画像の右サイズハンドル', exact: true }).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x - 150, handle.y, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeLessThan(before.width - 100);
  const after = (await image.boundingBox())!; expect(after.width / after.height).toBeCloseTo(800 / 480, 1);
  await editor.press('Control+z'); await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(before.width, 0);
  await editor.press('Control+Shift+Z'); await editor.press('Control+s');
  await page.reload(); await expect(image).toBeVisible(); await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(after.width, 0);
  expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(800);
});

test('モーダルで全種類の注釈を追加し、Undo・再編集・PNG出力を保持する', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const editor = await openMarkdown(page, '画像の記録\n\n'); await insertTestImage(page);
  await page.locator('.cm-image-frame img').dblclick();
  const dialog = page.getByRole('dialog', { name: '画像に注釈', exact: true });
  await expect(dialog.locator('canvas')).toBeVisible();
  await dialog.getByRole('combobox', { name: '注釈の色' }).selectOption('#42a5f5');
  await dialog.getByRole('combobox', { name: '線の太さ' }).selectOption('6');
  await drawAnnotation(page, '丸', [.12, .25], [.35, .6]);
  await drawAnnotation(page, '四角', [.45, .25], [.7, .65]);
  await drawAnnotation(page, '矢印', [.65, .8], [.42, .5]);
  await drawAnnotation(page, '直線', [.12, .8], [.35, .8]);
  await dialog.getByRole('button', { name: 'テキスト', exact: true }).click();
  const bounds = (await dialog.locator('canvas').boundingBox())!; await page.mouse.click(bounds.x + bounds.width * .1, bounds.y + bounds.height * .08);
  await dialog.getByRole('textbox', { name: '注釈のテキスト' }).fill('温度上昇を確認'); await dialog.getByRole('button', { name: '文字を確定', exact: true }).click();
  await dialog.getByRole('button', { name: '注釈を元に戻す', exact: true }).click();
  await dialog.getByRole('button', { name: '注釈をやり直す', exact: true }).click();
  await dialog.getByRole('button', { name: '注釈画面を拡大', exact: true }).click();
  await dialog.getByRole('button', { name: '画像全体を表示', exact: true }).click();
  await dialog.getByRole('button', { name: '完了', exact: true }).click(); await expect(dialog).not.toBeVisible(); await expect(editor).toBeFocused();
  const saved = await page.evaluate(() => Object.values(window.__laminaFixture.images)[0]);
  expect(saved.annotation!.shapes.map(shape => shape.kind)).toEqual(['ellipse', 'rect', 'arrow', 'line', 'text']);
  expect(saved.annotation!.shapes.at(-1)!.text).toBe('温度上昇を確認'); expect(saved.data).not.toBe(saved.original);
  expect(saved.annotation!.shapes[0].color).toBe('#42a5f5'); expect(saved.annotation!.shapes[0].lineWidth).toBe(6);
  expect(await page.locator('.cm-image-frame img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(800);
  await page.reload(); await expect(page.locator('.cm-image-frame.image-ready img')).toBeVisible(); await page.locator('.cm-image-frame img').dblclick();
  await expect(dialog.locator('canvas')).toBeVisible();
  await drawAnnotation(page, '丸', [.72, .2], [.9, .5]);
  await dialog.getByRole('button', { name: '完了', exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => Object.values(window.__laminaFixture.images)[0].annotation!.shapes.length)).toBe(6);
  expect(errors).toEqual([]);
});

test('月をまたぐテーマでも挿入した月だけを更新し、Undoで画像ファイルを消さない', async ({ page }) => {
  await connectTestVault(page); await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  const october = await page.evaluate(() => window.__laminaFixture.files['テーマ/耐久性評価/2026-10.md'].content);
  await insertTestImage(page, 'paste', '耐久性評価の本文');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content)).toContain('../../添付/');
  expect(await page.evaluate(() => window.__laminaFixture.files['テーマ/耐久性評価/2026-10.md'].content)).toBe(october);
  await page.getByRole('textbox', { name: '耐久性評価の本文' }).press('Control+z');
  await expect(page.locator('.cm-image-frame')).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(window.__laminaFixture.images).length)).toBe(1);
});

test('通常のMarkdown画像も注釈用にコピーし、元の画像を上書きしない', async ({ page }) => {
  const editor = await openMarkdown(page, '画像の記録\n\n'); await insertTestImage(page);
  await page.evaluate(() => {
    const fixture = window.__laminaFixture, image = Object.values(fixture.images)[0];
    fixture.images['添付/既存画像.png'] = { ...image, path: '添付/既存画像.png', annotation: null, original: null };
    fixture.files['メモ/試験の手順.md'].content = '既存の図\n\n![元の測定図](../添付/既存画像.png)\n\n末尾';
    fixture.files['メモ/試験の手順.md'].revision = 'external-image';
  });
  await page.getByRole('button', { name: '保管庫を再読み込み' }).click(); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.cm-image-frame.image-ready img')).toBeVisible();
  const original = await page.evaluate(() => window.__laminaFixture.images['添付/既存画像.png']);
  await page.locator('.cm-image-frame img').dblclick();
  const dialog = page.getByRole('dialog', { name: '画像に注釈', exact: true }); await expect(dialog.locator('canvas')).toBeVisible();
  await drawAnnotation(page, '四角', [.2, .2], [.6, .6]); await dialog.getByRole('button', { name: '完了', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await editor.press('Control+s');
  expect(await page.evaluate(() => window.__laminaFixture.images['添付/既存画像.png'])).toEqual(original);
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).not.toContain('既存画像.png');
});

test('注釈のキャンセルと保存失敗では元の画像を変更せず、編集内容を再試行できる', async ({ page }) => {
  await openMarkdown(page, '画像の記録\n\n'); await insertTestImage(page);
  const original = await page.evaluate(() => Object.values(window.__laminaFixture.images)[0]);
  await page.locator('.cm-image-frame img').dblclick();
  const dialog = page.getByRole('dialog', { name: '画像に注釈', exact: true }); await expect(dialog.locator('canvas')).toBeVisible();
  await drawAnnotation(page, '丸', [.2, .2], [.6, .6]);
  await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => Object.values(window.__laminaFixture.images)[0])).toEqual(original);
  await page.locator('.cm-image-frame img').dblclick(); await expect(dialog.locator('canvas')).toBeVisible();
  await drawAnnotation(page, '矢印', [.2, .2], [.6, .6]);
  await page.evaluate(() => { window.__laminaFixture.operationFailure = true; });
  await dialog.getByRole('button', { name: '完了', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('保存失敗');
  expect(await page.evaluate(() => Object.values(window.__laminaFixture.images)[0])).toEqual(original);
  await page.evaluate(() => { window.__laminaFixture.operationFailure = false; });
  await dialog.getByRole('button', { name: '完了', exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => Object.values(window.__laminaFixture.images)[0].annotation!.shapes.length)).toBe(1);
});

for (const kind of ['arrow', 'line'] as const) test(`${kind === 'arrow' ? '矢印' : '直線'}の両端を直接動かし、反対側の固定・ズーム・Undo・保存と再編集を保つ`, async ({ page }) => {
  await openMarkdown(page, '端点の編集\n\n'); await insertTestImage(page);
  await page.evaluate(kind => {
    const image = Object.values(window.__laminaFixture.images)[0];
    image.annotation!.shapes = [{ id: 'legacy-line', kind, x: 120, y: 100, width: 200, height: 0, rotation: 90, color: '#ef5350', lineWidth: 3, fontSize: 32, text: '' }]; image.revision += '-legacy';
  }, kind);
  const dialog = page.getByRole('dialog', { name: '画像に注釈', exact: true });
  const open = async () => { await page.locator('.cm-image-frame img').dblclick(); await expect(dialog.locator('canvas')).toBeVisible(); };
  const clickAt = async (x: number, y: number) => { const box = (await dialog.locator('canvas').boundingBox())!; await page.mouse.click(box.x + x * box.width / 800, box.y + y * box.height / 480); };
  const drag = async (from: [number, number], to: [number, number]) => {
    const box = (await dialog.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + from[0] * box.width / 800, box.y + from[1] * box.height / 480); await page.mouse.down();
    await page.mouse.move(box.x + to[0] * box.width / 800, box.y + to[1] * box.height / 480, { steps: 15 }); await page.mouse.up();
  };
  await open(); await dialog.getByRole('button', { name: '注釈画面を縮小', exact: true }).click(); await dialog.getByRole('button', { name: '注釈画面を縮小', exact: true }).click();
  await clickAt(120, 200); await expect(dialog).toContainText('両端のハンドル');
  await drag([120, 300], [500, 100]);
  await dialog.getByRole('button', { name: '注釈を元に戻す', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '注釈を元に戻す', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '注釈をやり直す', exact: true }).click();
  await clickAt(310, 100); await drag([120, 100], [600, 250]);
  await dialog.getByRole('button', { name: '完了', exact: true }).click(); await expect(dialog).not.toBeVisible();
  const image = await page.evaluate(() => Object.values(window.__laminaFixture.images)[0]);
  const shape = image.annotation!.shapes[0];
  // Mouse input rounds to screen pixels; at 64% zoom that is more than one
  // original-image pixel. Fixed endpoints are checked exactly below.
  const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(3);
  expect(shape.kind).toBe(kind); near(shape.x, 600); near(shape.y, 250);
  near(shape.x + shape.width, 500); near(shape.y + shape.height, 100); expect(shape.rotation).toBe(0);
  expect(image.data).not.toBe(image.original);
  await page.reload(); await expect(page.locator('.cm-image-frame.image-ready img')).toBeVisible();
  await open(); await clickAt(550, 175); await drag([500, 100], [600, 40]);
  await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => Object.values(window.__laminaFixture.images)[0])).toEqual(image);
  await open(); await clickAt(550, 175); await drag([500, 100], [600, 40]);
  await dialog.getByRole('button', { name: '完了', exact: true }).click(); await expect(dialog).not.toBeVisible();
  const final = await page.evaluate(() => Object.values(window.__laminaFixture.images)[0].annotation!.shapes[0]);
  expect(final.x).toBe(shape.x); expect(final.y).toBe(shape.y); near(final.x + final.width, 600); near(final.y + final.height, 40);
});

test('ライブプレビューと記法の編集を切り替えても保存するMarkdownを変えない', async ({ page }) => {
  const content = '# 表示確認\n\n**強調** と *斜体* と `a < b` と [公式資料](https://example.com/docs).\n\n- 項目\n    + 子項目\n* 別の項目\n\n1. 番号付きの項目\n\n> 引用 **太字**\n\n```ts\nconst text = "**not bold**";\nconsole.log("<script>");\n- コード内の文字列\n```\n\n入力欄';
  const editor = await openMarkdown(page, content);
  await expect(editor.locator('.cm-preview-strong').first()).toHaveText('強調');
  await expect(editor.locator('.cm-preview-emphasis')).toHaveText('斜体');
  await expect(editor.locator('.cm-preview-inline-code')).toHaveText('a < b');
  await expect(editor.locator('a.cm-preview-link')).toHaveText('公式資料');
  await expect(editor.locator('.cm-preview-quote')).toContainText('引用 太字');
  await expect(editor.locator('.cm-code-language')).toHaveText('ts');
  await expect(editor.locator('.cm-code-block .cm-preview-strong')).toHaveCount(0);
  await expect(editor.locator('.cm-list-bullet')).toHaveText(['-', '+', '*']);
  expect(await editor.locator('.cm-list-bullet').evaluateAll(markers => markers.map(marker => getComputedStyle(marker, '::after').content))).toEqual(['"•"', '"•"', '"•"']);
  await expect(editor.locator('.cm-line').filter({ hasText: '番号付きの項目' })).toHaveText('1. 番号付きの項目');
  await editor.press('Control+Home');
  await editor.press('ArrowDown');
  await editor.press('ArrowDown');
  await expect(editor.locator('.cm-line').nth(2)).toHaveText(content.split('\n')[2]);
  await editor.press('ArrowDown');
  await editor.press('ArrowDown');
  await expect(editor.locator('.cm-line').nth(4)).toHaveText('- 項目');
  await expect(editor.locator('.cm-list-bullet')).toHaveCount(3);
  await editor.press('Control+End');
  await expect(editor.locator('.cm-list-bullet')).toHaveCount(3);
  await expect(editor.locator('.cm-preview-strong').first()).toHaveText('強調');
  await page.keyboard.insertText('追記');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe(content + '追記');
  await page.screenshot({ path: '.tools/qa/live-preview.png' });
});

test('入れ子の装飾・エスケープ・コード中のバッククォートを表示し、HTMLを実行しない', async ({ page }) => {
  const content = '確認\n\n***重要*** と \\*文字\\* と `` `token` `` と [**仕様**](<https://example.com/a(b)>).\n\n<img src="x" onerror="window.__injected=true">\n<script>window.__injected=true</script>\n\n末尾';
  const editor = await openMarkdown(page, content);
  await expect(editor.locator('.cm-preview-emphasis .cm-preview-strong')).toHaveText('重要');
  await expect(editor.locator('.cm-line').nth(2)).toContainText('*文字*');
  await expect(editor.locator('.cm-preview-inline-code')).toHaveText('`token`');
  await expect(editor.locator('a.cm-preview-link')).toHaveText('仕様');
  // CodeMirror uses empty img.cm-widgetBuffer elements for cursor placement.
  await expect(editor.locator('img[src], script, [onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
  await editor.press('Control+a');
  await expect.poll(() => editor.locator('.cm-line').allTextContents().then(lines => lines.join('\n'))).toBe(content);
});

test('Webリンクをプレビューから開き、編集中の行は通常クリックで編集できる', async ({ page }) => {
  const editor = await openMarkdown(page, '確認\n\n[公式資料](https://example.com/docs?x=1&amp;y=2)\n\n末尾');
  const link = editor.locator('a.cm-preview-link');
  await link.click();
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.openedUrls)).toEqual(['https://example.com/docs?x=1&y=2']);
  await expect(page).toHaveURL('http://127.0.0.1:1420/');
  await editor.press('Control+Home');
  await editor.press('ArrowDown');
  await editor.press('ArrowDown');
  await link.click();
  expect(await page.evaluate(() => window.__laminaFixture.openedUrls.length)).toBe(1);
  await link.click({ modifiers: ['Control'] });
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.openedUrls.length)).toBe(2);
  await editor.press('Control+End');
  await link.click({ button: 'middle' });
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.openedUrls.length)).toBe(3);
  await page.evaluate(() => { window.__laminaFixture.openFailure = true; });
  await link.click();
  await expect(page.getByRole('alert')).toContainText('リンク先を開けませんでした');
});

test('参照形式と自動リンクを表示し、Web以外のスキームを起動しない', async ({ page }) => {
  const editor = await openMarkdown(page, '確認\n\n[参照][doc] と [doc] と <https://example.net/docs> と [不正](javascript:alert(1))\n\n[doc]: https://example.org/spec "仕様"\n\n末尾');
  const links = editor.locator('a.cm-preview-link');
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toHaveText('参照');
  await expect(links.nth(1)).toHaveText('doc');
  await expect(links.nth(2)).toHaveText('https://example.net/docs');
  await expect(editor.locator('a[href^="javascript:"]')).toHaveCount(0);
  await links.first().click();
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.openedUrls)).toEqual(['https://example.org/spec']);
});

test('コードブロックへカーソルを移すとフェンスを編集でき、Undoでも元の記法を保つ', async ({ page }) => {
  const content = '確認\n\n```ts\nconst value = "**literal**";\n```\n\n末尾';
  const editor = await openMarkdown(page, content);
  await expect(editor.locator('.cm-code-language')).toHaveText('ts');
  await editor.locator('.cm-code-language').click();
  await expect(editor.locator('.cm-code-language')).toHaveCount(0);
  await editor.press('Control+Home');
  for (let line = 0; line < 3; line++) await editor.press('ArrowDown');
  await expect(editor.locator('.cm-code-language')).toHaveCount(0);
  await expect(editor.locator('.cm-code-block').first()).toHaveText('```ts');
  await expect(editor.locator('.cm-code-block').last()).toHaveText('```');
  await page.keyboard.insertText('// ');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe(content.replace('const value', '// const value'));
  await editor.press('Control+z');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe(content);
});

test('月末で閉じ忘れたコードブロックが翌月のプレビューと保存を巻き込まない', async ({ page }) => {
  await connectTestVault(page);
  const october = '# 2026-10-31\n\n```ts\n**code text**';
  const november = '# 2026-11-12\n\n**今月**\n\n末尾';
  await page.evaluate(({ october, november }) => {
    window.__laminaFixture.files['テーマ/耐久性評価/2026-10.md'].content = october;
    window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content = november;
  }, { october, november });
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文' });
  await editor.press('Control+End');
  await expect(editor.locator('.cm-heading-1')).toHaveCount(2);
  await expect(editor.locator('.cm-preview-strong')).toHaveText('今月');
  await page.keyboard.insertText('追記');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => ['2026-10', '2026-11'].map(month => window.__laminaFixture.files[`テーマ/耐久性評価/${month}.md`].content))).toEqual([october, november + '追記']);
});

test('同じノートでも左右それぞれのカーソル位置に応じて記法とプレビューを表示する', async ({ page }) => {
  await openMarkdown(page, '確認\n\n**太字**\n\n末尾');
  await page.getByRole('button', { name: '左右分割を切り替え' }).click();
  const left = page.getByRole('region', { name: '左ペイン', exact: true }).getByRole('textbox');
  const right = page.getByRole('region', { name: '右ペイン', exact: true }).getByRole('textbox');
  await right.press('Control+End');
  await left.press('Control+Home');
  await left.press('ArrowDown');
  await left.press('ArrowDown');
  await expect(left.locator('.cm-preview-strong')).toHaveText('**太字**');
  await expect(right.locator('.cm-preview-strong')).toHaveText('太字');
  await left.press('End');
  await page.keyboard.insertText('追記');
  await expect(right).toContainText('太字追記');
});

test('前月の未完了コードに影響されず、翌月の箇条書きを継続・終了できる', async ({ page }) => {
  await connectTestVault(page);
  const october = '# 2026-10-31\n\n```ts\n未完了のコード';
  const november = '# 2026-11-12\n\n- 測定を完了した';
  await page.evaluate(({ october, november }) => {
    window.__laminaFixture.files['テーマ/耐久性評価/2026-10.md'].content = october;
    window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content = november;
  }, { october, november });
  await page.getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文' });
  await editor.press('Control+End');
  await editor.press('Enter');
  await page.keyboard.insertText('結論を記録した');
  await editor.press('Enter');
  await editor.press('Enter');
  await page.keyboard.insertText('通常の本文');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => ['2026-10', '2026-11'].map(month => window.__laminaFixture.files[`テーマ/耐久性評価/${month}.md`].content))).toEqual([october, november + '\n- 結論を記録した\n通常の本文']);
});

test('[[ の候補から既存ノートを挿入し、クリックとバックリンクで往復できる', async ({ page }) => {
  const editor = await openMarkdown(page, '作業の記録\n\n参照：');
  await editor.press('Control+End');
  await page.keyboard.insertText('[[耐久');
  await expect(page.getByRole('option').filter({ hasText: '耐久性評価' })).toBeVisible();
  await editor.press('Enter');
  await expect(editor).toContainText('[[耐久性評価]]');
  await editor.press('Enter');
  await expect(editor.locator('a.cm-note-link')).toHaveText('耐久性評価');
  await editor.locator('a.cm-note-link').click();
  await expect(page.getByRole('textbox', { name: '耐久性評価の本文' })).toBeVisible();
  const backlinks = page.locator('.backlink-card');
  await expect(backlinks).toHaveCount(1);
  await expect(backlinks.first()).toContainText('参照：[[耐久性評価]]');
  await backlinks.first().click();
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
});

test('テーマ名をTabで補完して#から日付を選択できる', async ({ page }) => {
  const editor = await openMarkdown(page, '参照先\n\n');
  await editor.press('Control+End');
  await page.keyboard.insertText('[[耐久');
  await expect(page.getByRole('option').filter({ hasText: '耐久性評価' })).toBeVisible();
  await editor.press('Tab');
  await page.keyboard.insertText('#2026-10');
  await expect(page.getByRole('option').filter({ hasText: '2026-10-31' })).toBeVisible();
  await editor.press('Enter');
  await expect(editor).toContainText('[[耐久性評価#2026-10-31]]');
  await editor.press('Enter');
  await editor.locator('a.cm-note-link').click();
  const target = page.getByRole('textbox', { name: '耐久性評価の本文' });
  await expect(target).toBeFocused();
  await expect(page.locator('.backlink-card')).toContainText('日付・見出し: 2026-10-31');
});

test('未作成リンクからメモを作り、ピン留め元を保って新規タブ・右ペインで開ける', async ({ page }) => {
  const editor = await openMarkdown(page, '記録\n\n[[新しい知見]]\n\n末尾');
  await editor.press('Control+End');
  await page.getByRole('button', { name: 'ピン留め', exact: true }).click();
  await editor.locator('a.cm-note-link-missing').click();
  await expect(page.getByRole('dialog', { name: 'リンク先のメモがありません' })).toBeVisible();
  await page.getByRole('button', { name: 'メモを作成', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '新しい知見の本文' })).toBeVisible();
  await expect(page.getByRole('region', { name: '左ペイン', exact: true }).getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab', { name: '試験の手順', exact: true }).click();
  await editor.press('Control+End');
  await editor.locator('a.cm-note-link').click({ modifiers: ['Control', 'Alt'] });
  await expect(page.getByRole('region', { name: '右ペイン', exact: true }).getByRole('textbox', { name: '新しい知見の本文' })).toBeVisible();
});

test('改名すると通常表示と参照先だけを更新し、指定した別名とコードは保持する', async ({ page }) => {
  await connectTestVault(page);
  await page.evaluate(() => { window.__laminaFixture.files['テーマ/耐久性評価/2026-11.md'].content = '# 2026-11-12\n\n[[試験の手順]] と [[試験の手順|以前の手順]]\n\n`[[試験の手順]]`\n'; });
  await page.getByRole('button', { name: '試験の手順', exact: true }).click();
  await page.getByRole('region', { name: '左ペイン', exact: true }).getByRole('button', { name: 'ピン留め', exact: true }).click();
  await page.getByRole('navigation', { name: 'メモ', exact: true }).getByLabel('メモ/試験の手順.mdの操作', { exact: true }).click();
  await page.getByRole('menuitem', { name: '名前を変更', exact: true }).click();
  await page.getByRole('textbox', { name: '名前', exact: true }).fill('評価の手順');
  await page.getByRole('button', { name: '変更', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '評価の手順の本文' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ピン留めを解除', exact: true })).toBeVisible();
  const data = await page.evaluate(() => window.__laminaFixture.files);
  expect(data['メモ/試験の手順.md']).toBeUndefined();
  expect(data['メモ/評価の手順.md']).toBeDefined();
  expect(data['テーマ/耐久性評価/2026-11.md'].content).toContain('[[評価の手順]] と [[評価の手順|以前の手順]]');
  expect(data['テーマ/耐久性評価/2026-11.md'].content).toContain('`[[試験の手順]]`');
});

test('フォルダー移動とアプリ終了中の移動の両方に追従し、古いパスのリンクを直す', async ({ page }) => {
  const editor = await openMarkdown(page, '確認\n\n[[メモ/参照先]]\n\n末尾');
  await page.evaluate(() => { window.__laminaFixture.files['メモ/参照先.md'] = { content: '参照先の本文', revision: 'target', identity: 'target-id' }; });
  await page.getByRole('button', { name: '保管庫を再読み込み' }).click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await page.keyboard.press('Control+s');
  await page.evaluate(() => { window.__laminaFixture.moveOffline('メモ/参照先.md', 'メモ/整理/参照先.md'); });
  await page.reload();
  await expect(editor).toBeVisible();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  const repaired = await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content);
  expect(repaired).toContain('[[参照先]]');
  await editor.press('Control+End');
  await editor.locator('a.cm-note-link').click();
  await expect(page.getByRole('textbox', { name: '参照先の本文' })).toContainText('参照先の本文');
  await page.getByRole('navigation', { name: 'メモ', exact: true }).getByLabel('メモ/整理/参照先.mdの操作', { exact: true }).click();
  await page.getByRole('menuitem', { name: '移動', exact: true }).click();
  await page.getByRole('textbox', { name: '移動先のフォルダー' }).fill('メモ/整理/設計');
  await page.getByRole('button', { name: '移動', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/整理/設計/参照先.md'].content)).toBe('参照先の本文');
});

test('全文検索で日付と周辺文章を確認して該当行へ移動する', async ({ page }) => {
  await connectTestVault(page);
  await page.getByRole('button', { name: '保管庫内を検索' }).click();
  await page.getByRole('textbox', { name: '検索する文字列' }).fill('温度推移');
  await expect(page.locator('.search-result')).toHaveCount(1);
  await expect(page.locator('.search-result')).toContainText('2026-11-11');
  await page.locator('.search-result').click();
  await expect(page.getByRole('textbox', { name: '耐久性評価の本文' })).toBeFocused();
});

test('選択部分をメモへ切り出し、元の本文にリンクとバックリンクを残す', async ({ page }) => {
  const editor = await openMarkdown(page, '保存しておきたい知見');
  await editor.press('Control+a');
  await page.getByRole('button', { name: '選択範囲をメモに切り出す' }).click();
  await page.getByRole('textbox', { name: '新しいメモのタイトル' }).fill('温度評価の知見');
  await page.getByRole('button', { name: '切り出す', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const files = await page.evaluate(() => window.__laminaFixture.files);
  expect(files['メモ/試験の手順.md'].content).toBe('[[温度評価の知見]]');
  expect(files['メモ/温度評価の知見.md'].content).toBe('保存しておきたい知見');
  await editor.press('Control+End');
  await editor.locator('a.cm-note-link').click({ modifiers: ['Control'] });
  await expect(page.getByRole('textbox', { name: '温度評価の知見の本文' })).toContainText('保存しておきたい知見');
  await expect(page.locator('.backlink-card')).toContainText('試験の手順');
});

test('名前変更に失敗しても本文と元のファイルを保持する', async ({ page }) => {
  const editor = await openMarkdown(page, '変更してはいけない本文');
  await page.getByRole('navigation', { name: 'メモ', exact: true }).getByLabel('メモ/試験の手順.mdの操作', { exact: true }).click();
  await page.getByRole('menuitem', { name: '名前を変更', exact: true }).click();
  await page.getByRole('textbox', { name: '名前', exact: true }).fill('変更後');
  await page.evaluate(() => { window.__laminaFixture.operationFailure = true; });
  await page.getByRole('button', { name: '変更', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作のテスト用保存失敗');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toBe('変更してはいけない本文');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/変更後.md'])).toBeUndefined();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(editor).toContainText('変更してはいけない本文');
});

test('補完から新規メモを作成でき、コード内では候補を出さない', async ({ page }) => {
  const editor = await openMarkdown(page, '記録\n\n');
  await editor.press('Control+End');
  await page.keyboard.insertText('[[新しいノート');
  await expect(page.getByRole('option').filter({ hasText: '新規メモを作成' })).toBeVisible();
  await editor.press('Enter');
  await expect(page.getByRole('textbox', { name: '新しいノートの本文' })).toBeVisible();
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toContain('[[新しいノート]]');
  expect(await page.evaluate(() => window.__laminaFixture.files['メモ/新しいノート.md'].content)).toBe('');
  const newEditor = page.getByRole('textbox', { name: '新しいノートの本文' });
  await page.keyboard.insertText('```md\n[[');
  await page.clock.runFor(100);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(newEditor).toContainText('[[');
});

test('同名ノートをパス付きの候補で選び、正しいノートへリンクする', async ({ page }) => {
  const editor = await openMarkdown(page, '参照\n\n');
  await page.evaluate(() => { window.__laminaFixture.files['メモ/a/仕様.md'] = { content: 'Aの仕様', revision: 'a' }; window.__laminaFixture.files['メモ/b/仕様.md'] = { content: 'Bの仕様', revision: 'b' }; });
  await page.getByRole('button', { name: '保管庫を再読み込み' }).click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await editor.press('Control+End');
  await page.keyboard.insertText('[[仕様');
  await expect(page.getByRole('option').filter({ hasText: 'メモ/a/仕様.md' })).toBeVisible();
  await page.getByRole('option').filter({ hasText: 'メモ/b/仕様.md' }).click();
  await expect(editor).toContainText('[[メモ/b/仕様]]');
  await editor.press('Enter');
  await editor.locator('a.cm-note-link').click();
  await expect(page.getByRole('textbox', { name: '仕様の本文' })).toContainText('Bの仕様');
});

test('起動中の外部変更通知で移動を反映し、リンクと表示を更新する', async ({ page }) => {
  const editor = await openMarkdown(page, '参照\n\n[[メモ/追跡先]]\n\n末尾');
  await page.evaluate(() => { window.__laminaFixture.files['メモ/追跡先.md'] = { content: '外部移動の対象', revision: 'watch', identity: 'watch' }; });
  await page.getByRole('button', { name: '保管庫を再読み込み' }).click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await page.evaluate(() => { window.__laminaFixture.moveOffline('メモ/追跡先.md', 'メモ/移動先/追跡先.md'); });
  await page.evaluate(() => window.__laminaChanged());
  await page.clock.runFor(500);
  await expect.poll(() => page.evaluate(() => window.__laminaFixture.files['メモ/試験の手順.md'].content)).toContain('[[追跡先]]');
  await editor.press('Control+End');
  await editor.locator('a.cm-note-link').click();
  await expect(page.getByRole('textbox', { name: '追跡先の本文' })).toContainText('外部移動の対象');
});
