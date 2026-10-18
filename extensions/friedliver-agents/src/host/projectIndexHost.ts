// The editor side of the project index (projectIndex.ts): one index per trusted
// workspace folder, kept in globalStorage between sessions (with its Merkle
// tree), refreshed from a FileSystemWatcher, shown in the status bar, and
// answering the index_* tools. On open only files whose stat changed are read,
// and only those whose content changed are re-indexed; a git checkout, pull or
// branch switch (HEAD moving) re-runs that same stat pass.
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { answerIndex, ProjectIndex, readIndexFile, saveIndexFile, STAT_BATCH, type IndexCall } from './projectIndex';

/** git files that move on a checkout, pull or branch switch: re-check every file's stat then. */
const HEAD_MOVED = /[/\\]\.git[/\\](HEAD|ORIG_HEAD|FETCH_HEAD)$/;
const SAVE_DELAY_MS = 30_000;
const CHANGE_DELAY_MS = 1_000;

export class ProjectIndexHost implements vscode.Disposable {
  private indexes: ProjectIndex[] = [];
  private building = false;
  private generation = 0;
  private readonly item = vscode.window.createStatusBarItem('friedliver.index', vscode.StatusBarAlignment.Right, 98);
  private readonly disposables: vscode.Disposable[] = [this.item];
  private watcher?: vscode.FileSystemWatcher;
  private readonly changed = new Set<string>();
  private changeTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;

  constructor(
    private readonly storage: string,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.item.name = 'FriedLiver Project Index';
    this.item.command = 'friedliver.index.rebuild';
    this.disposables.push(
      // A full rebuild: the saved index and its kept roots are dropped and every file is read again.
      vscode.commands.registerCommand('friedliver.index.rebuild', () => this.rebuild(true)),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.rebuild(false)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuild(false)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('friedliver.index') || e.affectsConfiguration('files.exclude')) this.rebuild(false);
      }),
    );
    this.rebuild(false);
  }

  answer(call: IndexCall): Promise<string> {
    return answerIndex(this.indexes, call, this.building);
  }

  private config() {
    const c = vscode.workspace.getConfiguration('friedliver.index');
    return {
      enabled: c.get<boolean>('enabled', true),
      maxFiles: Math.max(100, c.get<number>('maxFiles', 50_000)),
      maxBytes: Math.max(10, c.get<number>('maxMemoryMB', 150)) * 1024 * 1024,
    };
  }

  private rebuild(fresh: boolean): void {
    const gen = ++this.generation;
    this.watcher?.dispose();
    this.watcher = undefined;
    const cfg = this.config();
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    // Never index an untrusted folder: its files are not the user's to hand to agents yet.
    if (!cfg.enabled || !vscode.workspace.isTrusted || !folders.length) {
      this.indexes = [];
      this.item.hide();
      return;
    }
    this.indexes = folders.map((f) => {
      const exclude = Object.entries(vscode.workspace.getConfiguration('files', f.uri).get<Record<string, boolean>>('exclude') ?? {})
        .filter(([, on]) => on === true)
        .map(([glob]) => glob);
      return new ProjectIndex(f.uri.fsPath, { maxFiles: cfg.maxFiles, maxBytes: cfg.maxBytes, exclude, log: this.log });
    });
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const queue = (uri: vscode.Uri) => {
      if (uri.scheme !== 'file') return;
      this.changed.add(uri.fsPath);
      this.changeTimer ??= setTimeout(() => void this.flush(gen), CHANGE_DELAY_MS);
    };
    this.watcher.onDidCreate(queue);
    this.watcher.onDidChange(queue);
    this.watcher.onDidDelete(queue);
    void this.build(gen, fresh);
  }

  private async build(gen: number, fresh: boolean): Promise<void> {
    this.building = true;
    this.item.show();
    try {
      for (const ix of this.indexes) {
        // A missing, corrupt or older saved index loads nothing: this becomes a full build.
        if (!fresh) await ix.load(await readIndexFile(this.file(ix)));
        if (!(await this.sync(gen, ix))) return;
      }
    } finally {
      if (gen === this.generation) {
        this.building = false;
        this.status(this.summary());
        this.scheduleSave();
      }
    }
  }

  /** Every listed file through update(): a stat each, a read only where it changed. False when superseded. */
  private async sync(gen: number, ix: ProjectIndex): Promise<boolean> {
    const files = await ix.list();
    ix.prune(new Set(files));
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      if (gen !== this.generation) return false;
      if (!(await ix.updateBatch(files.slice(i, i + STAT_BATCH)))) break;
      if (this.building) this.status(`$(sync~spin) Index · ${this.count().toLocaleString()} files`);
      await new Promise((r) => setTimeout(r, 0));
    }
    return gen === this.generation;
  }

  /** `Index · 12,345 files · #1a2b3c4d · 7 changed since last open`. */
  private summary(): string {
    const changed = this.indexes.reduce((n, ix) => n + (ix.changes(undefined, 0)?.total ?? 0), 0);
    const ids = this.indexes.map((ix) => `#${ix.tree.root().slice(0, 8)}`).join(' ');
    const since = this.indexes.some((ix) => ix.tree.base) ? ` · ${changed.toLocaleString()} changed since last open` : '';
    return `$(database) Index · ${this.count().toLocaleString()} files${this.indexes.some((ix) => ix.capped) ? ' (capped)' : ''} · ${ids}${since}`;
  }

  private async flush(gen: number): Promise<void> {
    this.changeTimer = undefined;
    const paths = [...this.changed];
    this.changed.clear();
    for (const ix of this.indexes) {
      if (gen !== this.generation) return;
      // Outside every folder (or the folder itself): never indexed. The rest go through the full build's filters.
      const inside = paths.filter((abs) => abs.startsWith(ix.root + path.sep));
      // HEAD moved: the watcher may not report every file a big checkout touched. The stat pass is cheap.
      if (!this.building && inside.some((abs) => HEAD_MOVED.test(abs))) {
        await this.sync(gen, ix);
        continue;
      }
      const rels = inside.map((abs) => path.relative(ix.root, abs));
      if (rels.length) await ix.updateMany(rels);
    }
    if (!this.building) this.status(this.summary());
    this.scheduleSave();
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
  }

  private async save(): Promise<void> {
    for (const ix of this.indexes) {
      // Keeps this root for later diffs (index_changes) and as the next open's base.
      ix.tree.snapshot();
      await saveIndexFile(this.file(ix), ix).catch((e: Error) => this.log(`Project index: could not save ${this.file(ix)}: ${e.message}`));
    }
  }

  private file(ix: ProjectIndex): string {
    return path.join(this.storage, `index-${createHash('sha256').update(ix.root).digest('hex').slice(0, 16)}.json`);
  }

  private count(): number {
    return this.indexes.reduce((n, ix) => n + ix.size, 0);
  }

  private status(text: string): void {
    this.item.text = text;
    const roots = this.indexes.map((ix) => `${path.basename(ix.root)}: ${ix.tree.root()}`).join('\n');
    this.item.tooltip = `FriedLiver project index, which agents search with the index_* tools. Project hash:\n${roots}\nClick to rebuild it in full.`;
  }

  dispose(): void {
    this.generation++;
    clearTimeout(this.changeTimer);
    clearTimeout(this.saveTimer);
    void this.save();
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
