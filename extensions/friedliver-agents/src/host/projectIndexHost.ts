// The editor side of the project index (projectIndex.ts): one index per trusted
// workspace folder, kept in globalStorage between sessions, refreshed from a
// FileSystemWatcher, shown in the status bar, and answering the index_* tools.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { answerIndex, ProjectIndex, type IndexCall } from './projectIndex';

/** Files indexed between yields to the editor, so indexing stays in the background. */
const BATCH = 100;
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

  constructor(private readonly storage: string) {
    this.item.name = 'FriedLiver Project Index';
    this.item.command = 'friedliver.index.rebuild';
    this.disposables.push(
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
      return new ProjectIndex(f.uri.fsPath, { maxFiles: cfg.maxFiles, maxBytes: cfg.maxBytes, exclude });
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
        if (!fresh) await ix.load(await readFile(this.file(ix), 'utf8').then(JSON.parse, () => undefined));
        const files = await ix.list();
        ix.prune(new Set(files));
        for (let i = 0; i < files.length; i++) {
          if (gen !== this.generation) return;
          if (!(await ix.update(files[i])) && ix.capped) break;
          if (i % BATCH === 0) {
            this.status(`$(sync~spin) Index · ${this.count().toLocaleString()} files`);
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      }
    } finally {
      if (gen === this.generation) {
        this.building = false;
        this.status(`$(database) Index · ${this.count().toLocaleString()} files${this.indexes.some((ix) => ix.capped) ? ' (capped)' : ''}`);
        this.scheduleSave();
      }
    }
  }

  private async flush(gen: number): Promise<void> {
    this.changeTimer = undefined;
    const paths = [...this.changed];
    this.changed.clear();
    for (const abs of paths) {
      if (gen !== this.generation) return;
      const ix = this.indexes.find((x) => abs.startsWith(x.root + path.sep));
      // Outside every folder (or the folder itself): never indexed.
      if (ix) await ix.update(path.relative(ix.root, abs));
    }
    if (!this.building) this.status(`$(database) Index · ${this.count().toLocaleString()} files`);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
  }

  private async save(): Promise<void> {
    await mkdir(this.storage, { recursive: true }).catch(() => {});
    for (const ix of this.indexes) await writeFile(this.file(ix), JSON.stringify(ix)).catch(() => {});
  }

  private file(ix: ProjectIndex): string {
    return path.join(this.storage, `index-${createHash('sha256').update(ix.root).digest('hex').slice(0, 16)}.json`);
  }

  private count(): number {
    return this.indexes.reduce((n, ix) => n + ix.size, 0);
  }

  private status(text: string): void {
    this.item.text = text;
    this.item.tooltip = 'FriedLiver project index, which agents search with the index_* tools. Click to rebuild.';
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
