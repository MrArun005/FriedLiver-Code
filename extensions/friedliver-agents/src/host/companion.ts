// The companion: a character peeks in at the bottom-left corner of the window with whatever an agent
// waits on (a permission, a command, an edit to review, a question), and answers it right there.
// The workbench draws it (patches/0310-companion.patch); this side decides what it shows and routes
// a click back through the very message the chat's own card sends, by the request's own id.
// Nothing here answers on its own: an answer needs a click on a choice of an item still waiting.
import fs from 'node:fs';
import path from 'node:path';
import { approvalOf } from '../shared/approval';
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
const TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
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

/** `<dir>/<stem>.(svg|png|gif|webp)`, the first that loads. */
function firstImage(dir: string, stem: string): string | undefined {
  for (const ext of Object.keys(TYPES)) {
    const data = imageData(path.join(dir, `${stem}${ext}`));
    if (data) return data;
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
}

/**
 * An agent's pictures. The user's folder first (`<folder>/<agentId>.*`, `<agentId>-run.*`), then the
 * characters setting (a name, a path, or `{ idle, run }`), then the built-in default. Any picture that
 * doesn't load falls back to the built-in default (`skip` for a custom agent).
 */
export function characterFor(agentId: string, o: CharacterOptions): { character: string; characterRun?: string } | undefined {
  const builtin = (name: string) => {
    if (!BUILTIN_NAME.test(name)) return undefined;
    const idle = imageData(path.join(o.builtinDir, `${name}.svg`));
    const run = imageData(path.join(o.builtinDir, `${name}-run.svg`));
    return { character: idle ?? '', ...(run ? { characterRun: run } : {}) };
  };
  const fallback = () => builtin(Object.prototype.hasOwnProperty.call(DEFAULT_CHARACTERS, agentId) ? DEFAULT_CHARACTERS[agentId] : CUSTOM_CHARACTER);
  const pair = (idle: string | undefined, run: string | undefined) => (idle ? { character: idle, ...(run ? { characterRun: run } : {}) } : fallback());

  if (o.folder && path.isAbsolute(o.folder) && /^[\w-]+$/.test(agentId)) {
    const idle = firstImage(o.folder, agentId);
    if (idle) return pair(idle, firstImage(o.folder, `${agentId}-run`));
  }
  const own = o.characters && Object.prototype.hasOwnProperty.call(o.characters, agentId) ? o.characters[agentId] : undefined;
  if (typeof own === 'string' && own) {
    if (path.isAbsolute(own)) return pair(imageData(own), undefined);
    return builtin(own) ?? fallback();
  }
  if (own && typeof own === 'object') {
    const idle = typeof own.idle === 'string' ? imageData(own.idle) : undefined;
    const run = typeof own.run === 'string' ? imageData(own.run) : undefined;
    return pair(idle, run);
  }
  return fallback();
}

/** One waiting entry as the companion shows it, and the message each choice sends. Never a remembered scope. */
export function companionEntry(state: Pick<AppState, 'chats'>, entry: InboxEntry): { item: Omit<CompanionItem, 'character' | 'characterRun'>; agent: string; answers: Map<string, WebviewMessage> } | undefined {
  const chat = state.chats.find((c) => c.id === entry.chatId);
  if (!chat) return undefined;
  const i = entry.item;
  const answers = new Map<string, WebviewMessage>();
  const choices: CompanionChoice[] = [];
  let question = entry.title;
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
    // A command shows whole, as it will run: the title may shorten it.
    const line = i.kind === 'command' ? i.commandLine : i.kind === 'permission' ? i.detail?.command?.line : undefined;
    detail = [line, a.where].filter(Boolean).join('\n') || undefined;
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
  character(agentId: string): { character: string; characterRun?: string } | undefined;
}

export class Companion {
  /** What the workbench shows, by request id, with the message each of its choices sends. */
  private readonly shown = new Map<string, Map<string, WebviewMessage>>();
  /** Answered here and still waiting in the state (the core hasn't caught up): never shown or answered again. */
  private readonly sent = new Set<string>();

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
        const look = e && this.deps.character(e.agent);
        if (!e || !look) continue;
        live.add(entry.id);
        this.shown.set(entry.id, e.answers);
        this.deps.run('_friedliver.companion.show', { ...e.item, ...look } satisfies CompanionItem);
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

  /** Hides everything (the setting turned off, the extension stopping). */
  clear(): void {
    this.update({ chats: [] });
  }
}
