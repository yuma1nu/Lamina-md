// Keep a per-document save in flight until newer edits have also been persisted.
// Callers arriving during the save receive the same completion promise.
export class SaveQueue {
  private running = new Map<string, Promise<void>>();
  private requested = new Set<string>();
  constructor(private readonly persist: (id: string) => Promise<void>) {}
  run(id: string): Promise<void> {
    this.requested.add(id);
    const existing = this.running.get(id);
    if (existing) return existing;
    const promise = Promise.resolve().then(async () => {
      while (this.requested.delete(id)) await this.persist(id);
    }).finally(() => this.running.delete(id));
    this.running.set(id, promise);
    return promise;
  }
}
