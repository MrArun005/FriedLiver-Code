/**
 * Checkpoints. Every agent write already passes through FriedLiver, so the
 * content a file had before each turn is known; undoing a turn writes it back.
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

  latest(chatId: string): TurnFiles | null {
    const turn = this.turns.get(chatId)?.at(-1);
    return turn && turn.before.size ? { turnId: turn.turnId, files: [...turn.before.keys()] } : null;
  }

  /**
   * Restores the files a turn changed. Only the newest turn can be undone, so
   * a later turn's edits are never silently overwritten.
   */
  async undo(chatId: string, turnId: string, io: UndoIo): Promise<string[]> {
    const list = this.turns.get(chatId) ?? [];
    const turn = list.at(-1);
    if (!turn || turn.turnId !== turnId) throw new Error('Only the most recent turn can be undone.');
    for (const [file, content] of turn.before) {
      if (content === null) await io.remove(file);
      else await io.write(file, content);
    }
    list.pop();
    return [...turn.before.keys()];
  }
}
