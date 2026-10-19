/**
 * Checkpoints for writes FriedLiver sees: its own (every write an agent makes
 * through ACP passes through it) and files an agent asked to edit, recorded
 * before the edit. Undoing a turn writes the old content back. Changes an agent
 * makes on its own are found by the host's git checkpoints instead.
 */
export interface TurnFiles {
  turnId: string;
  files: string[];
}

interface Turn {
  turnId: string;
  /** Content before the turn's first write to each path; null means the file didn't exist. */
  before: Map<string, string | null>;
}

export interface UndoIo {
  write(file: string, content: string): Promise<void>;
  remove(file: string): Promise<void>;
}

const KEEP_TURNS = 20;

export class TurnLog {
  private readonly turns = new Map<string, Turn[]>();
  private nextId = 1;

  begin(chatId: string): string {
    const turn: Turn = { turnId: `turn-${this.nextId++}`, before: new Map() };
    const list = this.turns.get(chatId) ?? [];
    list.push(turn);
    if (list.length > KEEP_TURNS) list.shift();
    this.turns.set(chatId, list);
    return turn.turnId;
  }

  /** Called before each write; only the first write per path per turn is remembered. */
  record(chatId: string, file: string, before: string | null): void {
    const turn = this.turns.get(chatId)?.at(-1);
    if (turn && !turn.before.has(file)) turn.before.set(file, before);
  }

  /** What the latest turn saw in `file` before it changed; undefined when that turn didn't record it. */
  before(chatId: string, file: string): string | null | undefined {
    return this.turns.get(chatId)?.at(-1)?.before.get(file);
  }

  /** Forgets a file the latest turn recorded but didn't change, e.g. an edit the user turned down. */
  drop(chatId: string, file: string): void {
    this.turns.get(chatId)?.at(-1)?.before.delete(file);
  }

  /**
   * What a file held before the oldest kept turn that changed it, which is
   * where the chat started from unless it ran more than KEEP_TURNS turns.
   * Null: the chat created it. Undefined: no kept turn changed it.
   */
  firstBefore(chatId: string, file: string): string | null | undefined {
    for (const turn of this.turns.get(chatId) ?? []) if (turn.before.has(file)) return turn.before.get(file);
    return undefined;
  }

  /** Numbers new turns after ids restored from an earlier window, so a restored card never matches a new turn. */
  continueAfter(turnIds: Iterable<string>): void {
    for (const id of turnIds) {
      const n = Number(/^turn-(\d+)$/.exec(id)?.[1]);
      if (n >= this.nextId) this.nextId = n + 1;
    }
  }

  forget(chatId: string): void {
    this.turns.delete(chatId);
  }

  latest(chatId: string): TurnFiles | null {
    const turn = this.turns.get(chatId)?.at(-1);
    return turn && turn.before.size ? { turnId: turn.turnId, files: [...turn.before.keys()] } : null;
  }

  /**
   * Restores the files a turn changed. Only the newest turn can be undone, so
   * a later turn's edits are never silently overwritten.
   */
  async undo(chatId: string, turnId: string, io: UndoIo, skip: (file: string) => boolean = () => false): Promise<string[]> {
    const list = this.turns.get(chatId) ?? [];
    const turn = list.at(-1);
    if (!turn || turn.turnId !== turnId) throw new Error('Only the most recent turn can be undone.');
    for (const [file, content] of turn.before) {
      if (skip(file)) continue;
      if (content === null) await io.remove(file);
      else await io.write(file, content);
    }
    list.pop();
    return [...turn.before.keys()].filter((f) => !skip(f));
  }

  /** The latest turn's id, even when it recorded nothing. */
  current(chatId: string): string | undefined {
    return this.turns.get(chatId)?.at(-1)?.turnId;
  }
}
