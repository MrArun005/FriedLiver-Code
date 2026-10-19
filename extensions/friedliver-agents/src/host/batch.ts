import type { Action } from '../shared/model';

/** Actions a second past which batches go out every `maxMs` instead of every `ms`; below half of it, back again. */
export const BUSY_RATE = 100;

/**
 * Coalesces the core's actions for the webviews. The first one after a quiet
 * spell goes out at once; any that follow within `ms` go together in one
 * message, in order. A streaming agent sends many small updates, and one
 * postMessage each keeps every webview busy. Under load (fifteen agents
 * streaming is several hundred updates a second) the batches grow: one every
 * `maxMs`, so each webview folds and draws about twenty times a second
 * instead of thirty, and the workbench, which carries every message to the
 * webviews, passes on fewer.
 */
export class ActionBatcher {
  private queue: Action[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private interval: number;

  constructor(
    private readonly send: (actions: Action[]) => void,
    private readonly ms = 30,
    private readonly maxMs = 50,
  ) {
    this.interval = ms;
  }

  push(action: Action): void {
    if (this.timer) {
      this.queue.push(action);
      return;
    }
    this.send([action]);
    this.timer = setTimeout(() => this.tick(), this.interval);
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
    if (!this.queue.length) {
      this.interval = this.ms;
      return;
    }
    const perSecond = (this.queue.length * 1000) / this.interval;
    this.flush();
    if (perSecond >= BUSY_RATE) this.interval = this.maxMs;
    else if (perSecond < BUSY_RATE / 2) this.interval = this.ms;
    this.timer = setTimeout(() => this.tick(), this.interval);
  }
}
