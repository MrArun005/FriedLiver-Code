// The Images view: every image any agent read, made or was given, by chat.
// Pure: the host and the webviews both use it, and the tests.
import { AGENT_FACES, type AgentKey, type AppState, type ChatView, type ImageItem } from './model';
import { stepImage } from './stepImages';
import { chatName } from './names';

/** How an image came into a chat. */
export type ImageSource = 'read' | 'screenshot' | 'attached' | 'created';
export const IMAGE_SOURCES: readonly ImageSource[] = ['read', 'screenshot', 'attached', 'created'];
export const SOURCE_LABEL: Record<ImageSource, string> = { read: 'Read', screenshot: 'Screenshot', attached: 'Attached', created: 'Created by tool' };

/** What the host tells the Images view about its copies (see host/imageStore.ts). */
export interface ImageStoreInfo {
  /** Bytes the copies use, and the limit (the friedliver.images.storageLimitMB setting). */
  used: number;
  cap: number;
  pinned: string[];
  hidden: string[];
}

/** How long "Done looking" can be undone, in seconds. */
export const UNDO_SECONDS = 8;

/** The images a tab's Done looking covers: its chat's (or every one), less the pinned. */
export function doneScope(images: readonly GalleryImage[], pinned: ReadonlySet<string>, chatId?: string): GalleryImage[] {
  return images.filter((i) => (!chatId || i.chatId === chatId) && !pinned.has(i.key));
}

/** "212 MB", "1 GB": storage at a glance. */
export function bytesText(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 / 1024)} MB`;
  const gb = n / 1024 ** 3;
  return `${gb < 10 ? Number(gb.toFixed(1)) : Math.round(gb)} GB`;
}

/** At most this many images in one view, the newest. */
export const MAX_GALLERY = 2000;

/** An image a Claude Code session outside FriedLiver read or took, from its transcript. */
export interface OutsideImage {
  path: string;
  title: string;
  source: 'read' | 'screenshot';
  at: number;
}

/** A Claude Code session outside FriedLiver with the images in its transcript (and its subagents'). */
export interface OutsideImages {
  id: string;
  title: string;
  cwd: string;
  images: OutsideImage[];
}

export interface GalleryImage {
  /** Unique in the view. */
  key: string;
  /** A FriedLiver chat's id, or `claude:<session id>` for a session outside FriedLiver. */
  chatId: string;
  /** The transcript item to reveal ("Go to step"); FriedLiver chats only. */
  stepId?: string;
  /** A file: its thumbnail and preview come from the host, after its checks. */
  path?: string;
  /** Else an image held in the state (a data: URI): one you attached, or a tool's output. */
  imageId?: string;
  title: string;
  source: ImageSource;
  at: number;
}

/** A chat with images: one tab of the view. */
export interface GalleryChat {
  id: string;
  title: string;
  agent: AgentKey;
  /** A Claude Code session outside FriedLiver: no step to go to. */
  outside?: true;
  count: number;
  /** Its newest image, for the tab order. */
  latest: number;
}

const OUTSIDE = 'claude:';
export const isOutside = (chatId: string) => chatId.startsWith(OUTSIDE);

/** The images of one FriedLiver chat, in transcript order, each file once. */
export function chatGallery(chat: ChatView, images: readonly ImageItem[]): GalleryImage[] {
  const byId = new Map(images.map((i) => [i.id, i]));
  const out: GalleryImage[] = [];
  const seen = new Set<string>();
  let at = chat.createdAt;
  for (const item of chat.items) {
    if ((item.kind === 'user' || item.kind === 'agent') && item.at) at = item.at;
    if (item.kind === 'user') {
      for (const id of item.images) {
        const img = byId.get(id);
        if (img && !seen.has(id)) {
          seen.add(id);
          out.push({ key: `${chat.id}\0${id}`, chatId: chat.id, imageId: id, title: img.title, source: 'attached', at: img.at ?? at });
        }
      }
    } else if (item.kind === 'tool') {
      const when = item.startedAt ?? at;
      const step = stepImage(item);
      if (step && !seen.has(step.path)) {
        seen.add(step.path);
        out.push({ key: `${chat.id}\0${step.path}`, chatId: chat.id, stepId: item.id, path: step.path, title: step.title, source: step.source, at: when });
      }
    }
  }
  // Images a tool sent back as data (not a file) or the agent put in a reply; and ones you sent with an @-question.
  for (const img of images) {
    if (img.chatId !== chat.id || seen.has(img.id)) continue;
    seen.add(img.id);
    out.push({ key: `${chat.id}\0${img.id}`, chatId: chat.id, imageId: img.id, ...(img.stepId ? { stepId: img.stepId } : {}), title: img.title, source: img.from === 'you' ? 'attached' : 'created', at: img.at ?? chat.lastActivity });
  }
  return out;
}

/** Every image in the view, newest first, with the chats that have any as tabs (the newest first too). */
export function collectGallery(state: AppState, outside: readonly OutsideImages[] = []): { images: GalleryImage[]; chats: GalleryChat[] } {
  const images: GalleryImage[] = [];
  const chats: GalleryChat[] = [];
  const add = (chat: Omit<GalleryChat, 'count' | 'latest'>, mine: GalleryImage[]) => {
    if (!mine.length) return;
    images.push(...mine);
    chats.push({ ...chat, count: mine.length, latest: Math.max(...mine.map((i) => i.at)) });
  };
  for (const chat of state.chats) add({ id: chat.id, title: chatName(chat), agent: chat.agent }, chatGallery(chat, state.images));
  for (const s of outside) {
    const id = `${OUTSIDE}${s.id}`;
    add(
      { id, title: s.title, agent: 'claude', outside: true },
      s.images.map((i) => ({ key: `${id}\0${i.path}`, chatId: id, path: i.path, title: i.title, source: i.source, at: i.at })),
    );
  }
  images.sort((a, b) => b.at - a.at);
  chats.sort((a, b) => b.latest - a.latest);
  return { images, chats };
}

export interface GalleryFilter {
  /** A chat's id, or undefined for All. */
  tab?: string;
  /** Sources to show; empty shows every source. */
  sources: readonly ImageSource[];
  query: string;
}

/** The images a tab shows, newest first and at most MAX_GALLERY: its chat's, of the chosen sources, matching every word of the query (title, file name, chat, agent). */
export function filterGallery(images: readonly GalleryImage[], chats: readonly GalleryChat[], f: GalleryFilter): GalleryImage[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  const chatOf = new Map(chats.map((c) => [c.id, c]));
  const out: GalleryImage[] = [];
  for (const img of images) {
    if (out.length >= MAX_GALLERY) break;
    if (matches(img)) out.push(img);
  }
  return out;

  function matches(img: GalleryImage): boolean {
    if (f.tab && img.chatId !== f.tab) return false;
    if (f.sources.length && !f.sources.includes(img.source)) return false;
    if (!words.length) return true;
    const chat = chatOf.get(img.chatId);
    const hay = `${img.title} ${img.path?.split(/[\\/]/).pop() ?? ''} ${chat?.title ?? ''} ${chat ? AGENT_FACES[chat.agent].name : ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }
}

/** How many images of each source the tab has, for the filter chips. */
export function sourceCounts(images: readonly GalleryImage[], tab?: string): Record<ImageSource, number> {
  const out: Record<ImageSource, number> = { read: 0, screenshot: 0, attached: 0, created: 0 };
  for (const img of images) if (!tab || img.chatId === tab) out[img.source]++;
  return out;
}
