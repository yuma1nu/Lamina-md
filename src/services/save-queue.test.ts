import { describe, expect, it } from 'vitest';
import { SaveQueue } from './save-queue';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
describe('保存キュー', () => {
  it('保存中に届いた更新も同じ完了待ちの対象にする', async () => {
    const pause = gate();
    const saved: string[] = [];
    let text = '最初の記録';
    const queue = new SaveQueue(async () => {
      const snapshot = text;
      if (!saved.length) await pause.promise;
      saved.push(snapshot);
    });
    const first = queue.run('note');
    await Promise.resolve();
    text = '保存中の追加編集';
    const second = queue.run('note');
    expect(second).toBe(first);
    pause.resolve();
    await second;
    expect(saved).toEqual(['最初の記録', '保存中の追加編集']);
  });

  it('失敗後も更新を再試行できる', async () => {
    let fail = true;
    const saved: string[] = [];
    const queue = new SaveQueue(async id => { if (fail) throw new Error('disk full'); saved.push(id); });
    await expect(queue.run('note')).rejects.toThrow('disk full');
    fail = false;
    await queue.run('note');
    expect(saved).toEqual(['note']);
  });
});
