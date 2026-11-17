import { test, expect } from '@playwright/test';
import { connectTestVault } from './fixtures/vault';

// Recording a DOM snapshot after every key would dominate this measurement.
test.use({ trace: 'off' });

test('日常性能：24か月・300メモ・画像付きの保管庫で入力とタブ復帰を計測する', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await connectTestVault(page, false);
  await page.evaluate(() => {
    const fixture = window.__laminaFixture;
    for (const path of Object.keys(fixture.files)) if (path.startsWith('テーマ/')) delete fixture.files[path];
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
    const context = canvas.getContext('2d')!; context.fillStyle = '#566e59'; context.fillRect(0, 0, 200, 100); context.fillStyle = '#fff'; context.fillText('測定結果', 20, 40);
    const data = canvas.toDataURL('image/png').split(',')[1];
    fixture.images['添付/performance/rendered.png'] = { path: '添付/performance/rendered.png', data, mime: 'image/png', revision: 'image-performance', annotation: null, original: null };
    for (let index = 0; index < 24; index++) {
      const month = `${2025 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
      fixture.files[`テーマ/耐久性評価/${month}.md`] = { revision: month, content: Array.from({ length: 20 }, (_, day) => `# ${month}-${String(day + 1).padStart(2, '0')}\n\n- 条件Aで耐久性の試験を実施した。\n    - 荷重・温度・振動を確認した。\n- [ ] 次回の比較条件を確認する。\n\n結論を記録し、測定結果を振り返る。\n\n![測定図](../../添付/performance/rendered.png)\n`).join('\n') };
    }
    for (let index = 0; index < 300; index++) fixture.files[`メモ/技術メモ${index}.md`] = { revision: String(index), content: `# 技術メモ${index}\n\n` + '試験条件と観察結果を記録する。\n'.repeat(20) };
  });
  await page.getByRole('button', { name: '保管庫を再読み込み', exact: true }).click(); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  const start = performance.now();
  await page.getByRole('navigation', { name: 'テーマ', exact: true }).getByRole('button', { name: '耐久性評価', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '耐久性評価の本文', exact: true }); await expect(editor).toBeVisible(); await editor.press('Control+End');
  const openMs = performance.now() - start;
  const profile = await page.context().newCDPSession(page); await profile.send('Profiler.enable'); await profile.send('Profiler.start');
  const samples: number[] = [];
  for (let index = 0; index < 20; index++) {
    const before = performance.now(); await page.keyboard.press(index % 2 ? 'ArrowUp' : 'ArrowDown');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))); samples.push(performance.now() - before);
  }
  const typing: number[] = [];
  await editor.press('Control+End'); await editor.press('End');
  for (let index = 0; index < 8; index++) { const before = performance.now(); await page.keyboard.insertText('記録'); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))); typing.push(performance.now() - before); }
  await page.getByRole('navigation', { name: 'メモ', exact: true }).getByRole('button', { name: '試験の手順', exact: true }).click({ modifiers: ['Control'] });
  const beforeReturn = performance.now(); await page.getByRole('tab', { name: '耐久性評価', exact: true }).click(); await expect(editor).toBeFocused(); const returnMs = performance.now() - beforeReturn;
  const percentile = (values: number[], ratio: number) => Math.round([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * ratio))] * 10) / 10;
  const cpu = await profile.send('Profiler.stop'); await testInfo.attach('daily-cpu-profile', { body: JSON.stringify(cpu.profile), contentType: 'application/json' });
  const result = { environment: 'Chromium開発ビルド・Tauri IPC代替・DOMトレース無効。操作開始から次の描画フレームまで。Windows実機の保証値ではない。', months: 24, memos: 300, imageReferences: 480, openMs: Math.round(openMs), tabReturnMs: Math.round(returnMs), navigationP50Ms: percentile(samples, .5), navigationP95Ms: percentile(samples, .95), typingP50Ms: percentile(typing, .5), typingP95Ms: percentile(typing, .95) };
  await testInfo.attach('daily-performance', { body: JSON.stringify(result, null, 2), contentType: 'application/json' }); console.log(JSON.stringify(result));
  expect(result.navigationP95Ms).toBeLessThan(200); expect(result.typingP95Ms).toBeLessThan(400);
  await expect(editor).toContainText('記録記録'); await page.screenshot({ path: '.tools/qa/daily-long-note.png' });
});
