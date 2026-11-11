// The companion: a character runs in to the middle of the window with whatever an agent
// waits on (a permission, a command, an edit to review, a question), and answers it right there.
// The workbench draws it (patches/0310-companion.patch); this side decides what it shows and routes
// a click back through the very message the chat's own card sends, by the request's own id.
// Nothing here answers on its own: an answer needs a click on a choice of an item still waiting.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approvalOf, tilde } from '../shared/approval';
import { entryActions, inbox, type InboxEntry } from '../shared/inbox';
import type { WebviewMessage } from '../shared/messages';
import type { AppState } from '../shared/model';

export interface CompanionChoice {
  id: string;
  label: string;
  kind: 'primary' | 'secondary' | 'danger';
}

/** What `_friedliver.companion.show` takes. */
export interface CompanionItem {
  id: string;
  chatId: string;
  agentLabel: string;
  chatTitle: string;
  question: string;
  detail?: string;
  choices: CompanionChoice[];
  /** A data: URI of the idle picture; empty when there is none (the bubble shows alone). */
  character: string;
  /** A data: URI of the run cycle; without it the idle picture slides in. */
  characterRun?: string;
  /** A video for the character standing (and the run-in, without a run video); the pictures above are its fallback. */
  video?: CompanionVideo;
  videoRun?: CompanionVideo;
}

/** A video as the workbench gets it: its bytes once, with the first ask that uses it; after that by key. */
export interface CompanionVideo {
  key: string;
  type: string;
  bytes?: Uint8Array;
}

/** A video file a character uses. `key` changes with the file (path, size, time). */
export interface VideoRef {
  key: string;
  type: string;
  path: string;
}

/** A character: a built-in name, a local image path, or `{ idle, run }` paths. */
export type CharacterSetting = string | { idle?: unknown; run?: unknown };

export const DEFAULT_CHARACTERS: Record<string, string> = {
  claude: 'jas',
  codex: 'bolt',
  gemini: 'owl',
  antigravity: 'thunder',
  copilot: 'fox',
  opencode: 'panda',
  demo: 'smash',
};
/** Any other agent (a custom one). */
export const CUSTOM_CHARACTER = 'skip';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const VIDEO_TYPES: Record<string, string> = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime' };
const EXTENSIONS = [...Object.keys(TYPES), ...Object.keys(VIDEO_TYPES)];
const BUILTIN_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A local image as a data: URI, or undefined: an absolute path to an .svg/.png/.gif/.webp file of at
 * most 5 MB. No URLs, no relative paths, nothing else. Data URIs keep the workbench from loading any
 * file or address itself (its CSP allows data: images; an SVG in an <img> runs no script).
 */
export function imageData(file: string): string | undefined {
  try {
    if (!path.isAbsolute(file)) return undefined;
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) return undefined;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES || st.size === 0) return undefined;
    return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/**
 * A local video: an absolute path to a .webm/.mp4/.m4v/.mov file of at most 20 MB that hasn't failed
 * to play before as it is now. Its bytes are read when it is first shown, never base64'd.
 */
export function videoRef(file: string, failed: (key: string) => boolean = () => false): VideoRef | undefined {
  try {
    if (!path.isAbsolute(file)) return undefined;
    const type = VIDEO_TYPES[path.extname(file).toLowerCase()];
    if (!type) return undefined;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_VIDEO_BYTES || st.size === 0) return undefined;
    const key = createHash('sha256').update(`${file}\0${st.size}\0${st.mtimeMs}`).digest('hex');
    return failed(key) ? undefined : { key, type, path: file };
  } catch {
    return undefined;
  }
}

/** A picture (data: URI) or a video. */
type Media = { image: string } | { video: VideoRef };

/** `~/x` is in your home folder. */
export const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p);

function media(raw: string, failed: (key: string) => boolean): Media | undefined {
  const file = expandHome(raw);
  const image = imageData(file);
  if (image) return { image };
  const video = videoRef(file, failed);
  return video ? { video } : undefined;
}

/** `<dir>/<stem>.(svg|png|gif|webp|webm|mp4|m4v|mov)`, the first that loads. */
function firstMedia(dir: string, stem: string, failed: (key: string) => boolean): Media | undefined {
  for (const ext of EXTENSIONS) {
    const m = media(path.join(dir, `${stem}${ext}`), failed);
    if (m) return m;
  }
  return undefined;
}

export interface CharacterOptions {
  /** extensions/friedliver-agents/media/characters */
  builtinDir: string;
  /** friedliver.companion.characters, from the user's own settings only. */
  characters: Record<string, CharacterSetting> | undefined;
  /** friedliver.companion.folder, from the user's own settings only. */
  folder: string | undefined;
  /** The clone of friedliver.companion.repo, when there is one (host/characterRepo.ts). */
  repoDir?: string;
  /** Videos that couldn't play here (by key): passed over, so the built-in character stands in. */
  failed?: (key: string) => boolean;
}

export interface CharacterLook {
  character: string;
  characterRun?: string;
  video?: VideoRef;
  videoRun?: VideoRef;
}

/**
 * An agent's pictures. The user's folder first (`<folder>/<agentId>.*`, `<agentId>-run.*`), then the
 * characters setting (a name, a path, or `{ idle, run }`), then the built-in default. Any picture that
 * doesn't load falls back to the built-in default (`skip` for a custom agent).
 */
export function characterFor(agentId: string, o: CharacterOptions): CharacterLook | undefined {
  const failed = o.failed ?? (() => false);
  const builtin = (name: string): CharacterLook | undefined => {
    if (!BUILTIN_NAME.test(name)) return undefined;
    const idle = imageData(path.join(o.builtinDir, `${name}.svg`));
    const run = imageData(path.join(o.builtinDir, `${name}-run.svg`));
    return { character: idle ?? '', ...(run ? { characterRun: run } : {}) };
  };
  const fallback = () => builtin(Object.prototype.hasOwnProperty.call(DEFAULT_CHARACTERS, agentId) ? DEFAULT_CHARACTERS[agentId] : CUSTOM_CHARACTER);
  // Own media over the built-in: a video keeps the built-in pictures as its fallback; one video runs in and stays.
  const pair = (idle: Media | undefined, run: Media | undefined): CharacterLook | undefined => {
    if (!idle) return undefined;
    const base: CharacterLook = 'image' in idle ? { character: idle.image } : { ...(fallback() ?? { character: '' }), video: idle.video };
    if (run && 'image' in run) base.characterRun = run.image;
    if (run && 'video' in run) base.videoRun = run.video;
    return base;
  };
  // `<dir>/<agentId>.*` and `<agentId>-run.*`: the folder setting, or the repository's clone.
  const fromDir = (raw: string | undefined) => {
    const dir = raw && expandHome(raw);
    if (!dir || !path.isAbsolute(dir) || !/^[\w-]+$/.test(agentId)) return undefined;
    const idle = firstMedia(dir, agentId, failed);
    return idle ? pair(idle, firstMedia(dir, `${agentId}-run`, failed)) : undefined;
  };
  const fromSetting = () => {
    const own = o.characters && Object.prototype.hasOwnProperty.call(o.characters, agentId) ? o.characters[agentId] : undefined;
    if (typeof own === 'string' && own) return path.isAbsolute(expandHome(own)) ? pair(media(own, failed), undefined) : builtin(own);
    if (own && typeof own === 'object') {
      return pair(typeof own.idle === 'string' ? media(own.idle, failed) : undefined, typeof own.run === 'string' ? media(own.run, failed) : undefined);
    }
    return undefined;
  };
  // Your own entry, then your folder, then your repository, then the built-in; anything that doesn't load passes to the next.
  return fromSetting() ?? fromDir(o.folder) ?? fromDir(o.repoDir) ?? fallback();
}

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/**
 * The card's words: a short, human question ("Run a command?", "Edit 3 files?", "Read a file?"), and
 * what it acts on in full in the detail (the command exactly as it will run, every path).
 */
export function askWords(entry: InboxEntry, a: ReturnType<typeof approvalOf>): { question: string; detail?: string } {
  const i = entry.item;
  const where = a.where && !/^and \d+ more$/.test(a.where) ? a.where : undefined;
  const words = (question: string, lines: (string | undefined)[]) => {
    const detail = [...lines, where].filter((l): l is string => !!l).join('\n');
    return detail ? { question, detail } : { question };
  };
  const line = i.kind === 'command' ? i.commandLine : i.kind === 'permission' ? i.detail?.command?.line : undefined;
  if (line) return words('Run a command?', [line]);
  if (i.kind === 'review') return words('Accept this edit?', [tilde(i.path)]);
  if (i.kind === 'permission') {
    const files = i.detail?.files?.map((f) => tilde(f.path)) ?? [];
    if (files.length) return words(`${a.verb || 'Edit'} ${count(files.length, 'a file', 'files')}?`, files);
    const reads = i.detail?.locations?.map(tilde) ?? [];
    if (reads.length) return words(`${i.toolKind === 'search' ? 'Search' : 'Read'} ${count(reads.length, 'a file', 'files')}?`, reads);
    if (i.detail?.url) return words('Fetch a web page?', [i.detail.url]);
    return words('Use a tool?', [i.title]);
  }
  if (i.kind === 'bridge') return words(entry.kind === 'browser' ? 'Use the browser?' : entry.kind === 'memory' ? 'Use memory?' : 'Message another agent?', [entry.title]);
  return words(entry.title, []);
}

/** One waiting entry as the companion shows it, and the message each choice sends. Never a remembered scope. */
export function companionEntry(state: Pick<AppState, 'chats'>, entry: InboxEntry): { item: Omit<CompanionItem, 'character' | 'characterRun'>; agent: string; answers: Map<string, WebviewMessage> } | undefined {
  const chat = state.chats.find((c) => c.id === entry.chatId);
  if (!chat) return undefined;
  const i = entry.item;
  const answers = new Map<string, WebviewMessage>();
  const choices: CompanionChoice[] = [];
  let question: string;
  let detail: string | undefined;
  const actions = entryActions(entry, state);
  if (i.kind === 'question') {
    question = i.message;
    actions.choices.forEach((c, n) => {
      answers.set(`option${n}`, c.message);
      choices.push({ id: `option${n}`, label: c.label, kind: n === 0 ? 'primary' : 'secondary' });
    });
  } else {
    const a = approvalOf(i, chat, state);
    ({ question, detail } = askWords(entry, a));
    // Careful requests are press-and-hold in the chat, and plans and mode switches need reading: those are allowed there, not here.
    const readFirst = actions.primary === 'open' || (i.kind === 'permission' && (!!i.detail?.plan || i.toolKind === 'switch_mode'));
    if (actions.allow && !a.hold && !readFirst) {
      answers.set('allow', actions.allow);
      choices.push({ id: 'allow', label: a.yes === 'Allow' ? 'Allow once' : a.yes, kind: 'primary' });
    }
  }
  if (actions.deny) {
    answers.set('deny', actions.deny);
    choices.push({ id: 'deny', label: i.kind === 'question' ? 'Skip' : i.kind === 'review' ? 'Reject' : 'Deny', kind: 'secondary' });
  }
  return {
    item: { id: entry.id, chatId: chat.id, agentLabel: chat.label, chatTitle: chat.title, question, ...(detail ? { detail } : {}), choices },
    agent: chat.agent,
    answers,
  };
}

export interface CompanionDeps {
  /** Runs a workbench command: `_friedliver.companion.show` / `.hide`. */
  run(command: '_friedliver.companion.show' | '_friedliver.companion.hide', arg: unknown): void;
  /** Sends a card's message down the chat's own path (the host's message handler). */
  answer(message: WebviewMessage): void;
  enabled(): boolean;
  /** The core's state now: a click re-checks against it, so an answer that just arrived elsewhere wins. */
  state(): Pick<AppState, 'chats'>;
  character(agentId: string, failed: (key: string) => boolean): CharacterLook | undefined;
  /** A video file couldn't play in the window: said once per file as it is now. */
  videoFailed?(file: string): void;
}

export class Companion {
  /** What the workbench shows, by request id, with the message each of its choices sends. */
  private readonly shown = new Map<string, Map<string, WebviewMessage>>();
  /** Answered here and still waiting in the state (the core hasn't caught up): never shown or answered again. */
  private readonly sent = new Set<string>();
  /** Videos whose bytes the workbench has, by key, with their file. */
  private readonly videos = new Map<string, string>();
  /** Videos that couldn't play (by key: path, size, time), so they aren't tried on every ask. */
  private readonly failedVideos = new Set<string>();

  constructor(private readonly deps: CompanionDeps) {}

  /** Shows what started waiting, hides what stopped (answered here, in the chat, or elsewhere). */
  update(state: Pick<AppState, 'chats'>): void {
    const live = new Set<string>();
    const entries = inbox(state).entries;
    const waiting = new Set(entries.map((e) => e.id));
    for (const id of this.sent) if (!waiting.has(id)) this.sent.delete(id);
    if (this.deps.enabled()) {
      for (const entry of entries) {
        if (this.sent.has(entry.id)) continue;
        if (this.shown.has(entry.id)) {
          live.add(entry.id);
          continue;
        }
        const e = companionEntry(state, entry);
        const look = e && this.deps.character(e.agent, (key) => this.failedVideos.has(key));
        if (!e || !look) continue;
        live.add(entry.id);
        this.shown.set(entry.id, e.answers);
        const { video, videoRun, ...pictures } = look;
        const v = this.sendVideo(video);
        const vr = videoRun && videoRun.key === video?.key ? (v && { key: v.key, type: v.type }) : this.sendVideo(videoRun);
        this.deps.run('_friedliver.companion.show', { ...e.item, ...pictures, ...(v ? { video: v } : {}), ...(vr ? { videoRun: vr } : {}) } satisfies CompanionItem);
      }
    }
    for (const id of [...this.shown.keys()]) {
      if (live.has(id)) continue;
      this.shown.delete(id);
      this.deps.run('_friedliver.companion.hide', id);
    }
  }

  /**
   * A click: answers exactly the request it showed, once. An id that isn't showing (answered, gone, or
   * never shown) or a choice it didn't offer does nothing.
   */
  answer(id: unknown, choiceId: unknown): boolean {
    if (typeof id !== 'string' || typeof choiceId !== 'string') return false;
    this.update(this.deps.state());
    const message = this.shown.get(id)?.get(choiceId);
    if (!message) return false;
    this.shown.delete(id);
    this.sent.add(id);
    this.deps.run('_friedliver.companion.hide', id);
    this.deps.answer(message);
    return true;
  }

  /** A video for the workbench: its bytes the first time, its key after. A file that can't be read is left out. */
  private sendVideo(ref: VideoRef | undefined): CompanionVideo | undefined {
    if (!ref) return undefined;
    if (this.videos.has(ref.key)) return { key: ref.key, type: ref.type };
    try {
      const bytes = fs.readFileSync(ref.path);
      if (bytes.byteLength > MAX_VIDEO_BYTES) return undefined;
      this.videos.set(ref.key, ref.path);
      return { key: ref.key, type: ref.type, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    } catch {
      return undefined;
    }
  }

  /** The workbench couldn't play a video it was sent: remembered for the file as it is now, said once. Unknown keys do nothing. */
  videoFailed(key: unknown): boolean {
    if (typeof key !== 'string' || this.failedVideos.has(key)) return false;
    const file = this.videos.get(key);
    if (!file) return false;
    this.failedVideos.add(key);
    this.deps.videoFailed?.(file);
    return true;
  }

  /** Hides everything (the setting turned off, the extension stopping). */
  clear(): void {
    this.update({ chats: [] });
  }
}
