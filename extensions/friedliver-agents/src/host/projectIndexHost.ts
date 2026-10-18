// The editor side of the project index (projectIndex.ts): one index per trusted
// workspace folder, kept in globalStorage between sessions (with its Merkle
// tree), refreshed from a FileSystemWatcher, shown in the status bar, and
// answering the index_* tools. On open the saved index answers at once, then
// catches up in the background: git's hint, then the change journal since the
// saved mark (macOS FSEvents), else a stat of every file. Only changed files are
// read, and only changed content is re-indexed. A git checkout, pull or branch
// switch (HEAD moving) or a .gitignore edit re-runs the stat pass.
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { fseventsJournal, journalHelper, type Journal, type JournalMark } from './changeJournal';
import { answerIndex, docsFileOf, ProjectIndex, readIndexFile, saveIndexFile, type IndexCall } from './projectIndex';

/** git files that move on a checkout, pull or branch switch: re-check every file's stat then. */
const HEAD_MOVED = /[/\\]\.git[/\\](HEAD|ORIG_HEAD|FETCH_HEAD)$/;
const SAVE_DELAY_MS = 30_000;
const CHANGE_DELAY_MS = 1_000;

export class ProjectIndexHost implements vscode.Disposable {
  private indexes: ProjectIndex[] = [];
  /** true: a first build, answers incomplete. 'verifying': answering from the saved index while it catches up. */
  private building: boolean | 'verifying' = false;
  private readonly journal?: Journal;
  /** The journal mark taken at the last save: the next save's mark, once the watcher has had time to deliver what came before. */
  private readonly pending = new Map<ProjectIndex, JournalMark | undefined>();
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
    extensionPath?: string,
  ) {
    const helper = extensionPath ? journalHelper(extensionPath) : undefined;
    this.journal = helper ? fseventsJournal(helper) : undefined;
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
    this.item.show();
    this.pending.clear();
    // Every saved tree loads at once, without touching the files: the tree, the status and
    // index_changes are ready now. A missing, corrupt or older save loads nothing: a full build.
    if (!fresh) for (const ix of this.indexes) ix.load(await readIndexFile(this.file(ix)));
    if (gen !== this.generation) return;
    this.building = this.indexes.every((ix) => ix.size > 0) ? 'verifying' : true;
    this.status(this.building === 'verifying' ? `${this.summary()} · checking changes` : `$(sync~spin) Index · ${this.count().toLocaleString()} files`);
    try {
      // The saved docs stream in while the files are checked; a doc whose file changed meanwhile is skipped.
      const tick = () => this.tick(gen);
      const done = await Promise.all(this.indexes.map((ix) => Promise.all([ix.loadDocs(docsFileOf(this.file(ix)), tick), ix.catchUp(this.journal, tick)])));
      if (done.some(([, mode]) => !mode)) return;
    } finally {
      if (gen === this.generation) {
        this.building = false;
        this.status(this.summary());
        this.scheduleSave();
      }
    }
  }

  /** Between batches: yields to the editor, shows progress, and says whether to go on (not superseded). */
  private async tick(gen: number): Promise<boolean> {
    if (gen !== this.generation) return false;
    if (this.building === true) this.status(`$(sync~spin) Index · ${this.count().toLocaleString()} files`);
    await new Promise((r) => setTimeout(r, 0));
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
      // HEAD moved: the watcher may not report every file a big checkout touched. A .gitignore edit can
      // hide files no event names. The stat pass is cheap.
      if (!this.building && inside.some((abs) => HEAD_MOVED.test(abs) || path.basename(abs) === '.gitignore')) {
        await ix.syncAll(() => this.tick(gen));
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
      // Half-loaded docs would save half an index.
      if (ix.loading) continue;
      if (!this.building) {
        // The mark saved is the one taken at the previous save (or at open): the watcher has delivered
        // everything before it by now, so the next open replays the journal from there.
        const now = await this.journal?.now(ix.root);
        if (this.pending.get(ix)) ix.mark = this.pending.get(ix);
        this.pending.set(ix, now);
      }
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
