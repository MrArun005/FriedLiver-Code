import path from 'node:path';
import * as vscode from 'vscode';
import type { AgentCore, PendingReview } from './core';

export const PROPOSED_SCHEME = 'friedliver-proposed';

interface Entry {
  content: Uint8Array;
  mtime: number;
  readonly: boolean;
}

/**
 * Holds what an agent proposes to write, in memory, so the diff editor can
 * show it and the user can edit it (revert hunks) before anything touches disk.
 * Paths are `/<reviewId>/<file name>`; the original of a new file is
 * `/<reviewId>/original/<file name>` and read-only.
 */
export class ProposedFs implements vscode.FileSystemProvider {
  private readonly files = new Map<string, Entry>();
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;

  set(uri: vscode.Uri, text: string, readonly: boolean): void {
    this.files.set(uri.path, { content: Buffer.from(text, 'utf8'), mtime: Date.now(), readonly });
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  text(uri: vscode.Uri): string | undefined {
    const entry = this.files.get(uri.path);
    return entry && Buffer.from(entry.content).toString('utf8');
  }

  /** Forgets a review's proposal and its empty original. */
  removeReview(reviewId: string): void {
    for (const p of [...this.files.keys()]) {
      if (p.split('/')[1] !== reviewId) continue;
      this.files.delete(p);
      this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri: vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: p }) }]);
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.get(uri);
    return {
      type: vscode.FileType.File,
      ctime: entry.mtime,
      mtime: entry.mtime,
      size: entry.content.byteLength,
      permissions: entry.readonly ? vscode.FilePermission.Readonly : undefined,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return this.get(uri).content;
  }

  /** Saving the proposal (Ctrl+S) keeps the user's edits in memory; Accept writes them to disk. */
  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const entry = this.get(uri);
    if (entry.readonly) throw vscode.FileSystemError.NoPermissions(uri);
    entry.content = content;
    entry.mtime = Date.now();
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  private get(uri: vscode.Uri): Entry {
    const entry = this.files.get(uri.path);
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return entry;
  }
}

export function proposedUri(reviewId: string, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${reviewId}/${path.basename(file)}` });
}

function originalUri(review: PendingReview): vscode.Uri {
  return review.before === null
    ? vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${review.reviewId}/original/${path.basename(review.path)}` })
    : vscode.Uri.file(review.path);
}

export function reviewIdOf(uri: vscode.Uri | undefined): string | undefined {
  if (uri?.scheme !== PROPOSED_SCHEME) return undefined;
  return uri.path.split('/')[1] || undefined;
}

/** Agent edits in VS Code's own diff editor: original on the left, the editable proposal on the right. */
export class ReviewUi implements vscode.Disposable {
  readonly fs = new ProposedFs();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly core: () => AgentCore) {
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(PROPOSED_SCHEME, this.fs, { isCaseSensitive: true }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateContext()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateContext()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
    );
    // Reviews live in memory; diff tabs restored from an earlier window have nothing behind them.
    void vscode.window.tabGroups.close(this.tabs(() => true)).then(undefined, () => {});
  }

  /** Registers the proposal and opens the diff without taking focus from the chat. */
  async show(review: PendingReview): Promise<void> {
    this.fs.set(proposedUri(review.reviewId, review.path), review.proposed, false);
    if (review.before === null) this.fs.set(originalUri(review), '', true);
    await this.open(review.reviewId, true);
  }

  async open(reviewId: string, preserveFocus = false): Promise<void> {
    const review = this.core().review(reviewId);
    if (!review) return;
    const name = path.basename(review.path);
    const title = `${name} (${review.agentLabel}'s edit${review.before === null ? ', new file' : ''})`;
    await vscode.commands.executeCommand('vscode.diff', originalUri(review), proposedUri(reviewId, review.path), title, {
      preview: false,
      preserveFocus,
    } satisfies vscode.TextDocumentShowOptions);
  }

  /** Accepts what is left of the proposal, including the user's own edits to it. */
  accept(reviewId = this.activeReviewId()): boolean {
    const review = reviewId && this.core().review(reviewId);
    if (!review) return false;
    const uri = proposedUri(review.reviewId, review.path);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    this.core().decideReview(review.reviewId, true, open?.getText() ?? this.fs.text(uri) ?? review.proposed);
    return true;
  }

  reject(reviewId = this.activeReviewId()): boolean {
    if (!reviewId || !this.core().review(reviewId)) return false;
    this.core().decideReview(reviewId, false);
    return true;
  }

  /** Called by the core once a review is decided. */
  async close(reviewId: string): Promise<void> {
    // Save edited proposals first (into memory) so closing doesn't ask "Save changes?".
    for (const doc of vscode.workspace.textDocuments) {
      if (reviewIdOf(doc.uri) === reviewId && doc.isDirty) await doc.save().then(undefined, () => false);
    }
    await vscode.window.tabGroups.close(this.tabs((id) => id === reviewId)).then(undefined, () => false);
    this.fs.removeReview(reviewId);
    this.updateContext();
  }

  activeReviewId(): string | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) return reviewIdOf(input.modified);
    if (input instanceof vscode.TabInputText) return reviewIdOf(input.uri);
    return undefined;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private tabs(match: (reviewId: string) => boolean): vscode.Tab[] {
    return vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => {
        const uri = t.input instanceof vscode.TabInputTextDiff ? t.input.modified : t.input instanceof vscode.TabInputText ? t.input.uri : undefined;
        const id = reviewIdOf(uri);
        return id !== undefined && match(id);
      });
  }

  private updateContext(): void {
    const id = this.activeReviewId();
    void vscode.commands.executeCommand('setContext', 'friedliver.reviewActive', id !== undefined && this.core().review(id) !== undefined);
  }
}
