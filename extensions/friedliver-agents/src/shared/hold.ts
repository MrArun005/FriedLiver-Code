// Press and hold to allow a careful request: the key or the pointer has to stay down for HOLD_MS.
// Let go sooner and nothing happens (the fill drains back); a held key's auto-repeat changes nothing.

export const HOLD_MS = 600;

export class Hold {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly done: () => void,
    private readonly ms = HOLD_MS,
  ) {}

  get holding(): boolean {
    return this.timer !== undefined;
  }

  /** Down: starts the count, once; a second start while holding (key repeat) is ignored. Returns whether it started. */
  start(): boolean {
    if (this.timer !== undefined) return false;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.done();
    }, this.ms);
    return true;
  }

  /** Up, or the pointer left: cancels a hold that hasn't finished. */
  release(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
