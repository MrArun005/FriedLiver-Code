import type { Action } from '../shared/model';

/**
 * Coalesces the core's actions for the webviews. The first one after a quiet
 * spell goes out at once; any that follow within `ms` go together in one
 * message, in order. A streaming agent sends many small updates, and one
 * postMessage each keeps every webview busy.
 */
export class ActionBatcher {
  private queue: Action[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly send: (actions: Action[]) => void,
    private readonly ms = 30,
  ) {}

  push(action: Action): void {
    if (this.timer) {
      this.queue.push(action);
      return;
    }
    this.send([action]);
    this.timer = setTimeout(() => this.tick(), this.ms);
  }

  /**
   * Sends what is queued now. Call it before giving a surface a snapshot:
   * the snapshot already includes the queued actions, so they must reach
   * only the surfaces that had the state before.
   */
  flush(): void {
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    this.send(batch);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
  }

  private tick(): void {
    this.timer = undefined;
    if (!this.queue.length) return;
    this.flush();
    this.timer = setTimeout(() => this.tick(), this.ms);
  }
}
