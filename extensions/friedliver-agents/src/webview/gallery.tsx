import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { IMAGE_SOURCES, SOURCE_LABEL, collectGallery, filterGallery, isOutside, sourceCounts, type GalleryChat, type GalleryImage, type ImageSource, type OutsideImages } from '../shared/gallery';
import type { AppState } from '../shared/model';
import { humanTitle } from '../shared/stepImages';
import { ago } from '../shared/view';
import { Glyph, Icon, send, useHostImage, useNearScreen, usePersisted, useTabStrip } from './common';

const PLATFORM = document.body.dataset.platform;
const REVEAL = PLATFORM === 'darwin' ? 'Reveal in Finder' : PLATFORM === 'win32' ? 'Reveal in File Explorer' : 'Open containing folder';

interface Props {
  state: AppState;
  outside: readonly OutsideImages[];
  now: number;
  /** The Agent Manager's own search box; the side view draws its own. */
  query?: string;
}

/**
 * Every image an agent read, took or made, and every image you attached: a tab
 * per chat that has any (All first), filters by how it came, a search, a grid of
 * thumbnails loaded as they near the screen, and a large preview.
 */
export function Gallery({ state, outside, now, query: outerQuery }: Props) {
  const { images, chats } = useMemo(() => collectGallery(state, outside), [state, outside]);
  const [savedTab, setTab] = usePersisted<string>('imagesTab', '');
  const [sources, setSources] = usePersisted<ImageSource[]>('imagesSources', []);
  const [ownQuery, setQuery] = useState('');
  const query = outerQuery ?? ownQuery;
  // A tab whose chat has no image any more (closed, rewound) falls back to All.
  const tab = chats.some((c) => c.id === savedTab) ? savedTab : '';
  const shown = useMemo(() => filterGallery(images, chats, { tab: tab || undefined, sources, query }), [images, chats, tab, sources, query]);
  const counts = useMemo(() => sourceCounts(images, tab || undefined), [images, tab]);
  const chatOf = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats]);
  const [openKey, setOpenKey] = useState<string>();
  const at = openKey ? shown.findIndex((i) => i.key === openKey) : -1;

  const strip = useRef<HTMLDivElement>(null);
  const over = useTabStrip(strip, chats.length, tab);
  const toggle = (s: ImageSource) => setSources(sources.includes(s) ? sources.filter((x) => x !== s) : [...sources, s]);

  if (!images.length) {
    return (
      <div class="gallery">
        <div class="gallery-empty">
          <h2>No images yet</h2>
          <p>Screenshots and image files agents read or make, and images you attach, show up here, by chat.</p>
        </div>
      </div>
    );
  }
  const tabs: (GalleryChat | null)[] = [null, ...chats];
  return (
    <div class="gallery">
      <div class="gallery-tabs tabs" ref={strip} role="tablist" aria-label="Chats with images" data-overflow={over ? '' : undefined}>
        {tabs.map((c, n) => {
          const id = c?.id ?? '';
          const selected = id === tab;
          return (
            <span key={id || 'all'} class="tab-wrap" data-active={selected ? '' : undefined}>
              <button
                role="tab"
                class="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                title={c ? `${c.title}: ${c.count} image${c.count === 1 ? '' : 's'}` : `Every chat: ${images.length} images`}
                onClick={() => setTab(id)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  e.preventDefault();
                  const next = (n + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
                  setTab(tabs[next]?.id ?? '');
                  (strip.current?.children[next]?.firstElementChild as HTMLElement | null)?.focus();
                }}
              >
                {c ? <Glyph agent={c.agent} size="sm" /> : <Icon name="grid" size={14} />}
                <span class="tab-title">{c ? c.title : 'All'}</span>
                <span class="tab-count">{c ? c.count : images.length}</span>
              </button>
            </span>
          );
        })}
      </div>
      <div class="gallery-bar">
        <div class="gallery-filters" role="group" aria-label="Show images that were">
          {IMAGE_SOURCES.filter((s) => counts[s] || sources.includes(s)).map((s) => (
            <button key={s} type="button" class="filter-chip" aria-pressed={sources.includes(s)} onClick={() => toggle(s)}>
              {SOURCE_LABEL[s]}
              <span class="filter-count">{counts[s]}</span>
            </button>
          ))}
        </div>
        {outerQuery === undefined && (
          <label class="search gallery-search">
            <Icon name="search" />
            <input type="search" value={ownQuery} placeholder="Search images" aria-label="Search images" onInput={(e) => setQuery(e.currentTarget.value)} />
          </label>
        )}
      </div>
      {shown.length ? (
        <ul class="gallery-grid" aria-label={`${shown.length} image${shown.length === 1 ? '' : 's'}`}>
          {shown.map((img) => (
            <Card key={img.key} img={img} chat={tab ? undefined : chatOf.get(img.chatId)} state={state} now={now} onOpen={() => setOpenKey(img.key)} />
          ))}
        </ul>
      ) : (
        <div class="gallery-empty">
          <p>No image matches{query ? ` “${query}”` : ''}{sources.length ? ` in ${sources.map((s) => SOURCE_LABEL[s]).join(', ')}` : ''}.</p>
        </div>
      )}
      {at >= 0 && (
        <Preview
          img={shown[at]}
          chat={chatOf.get(shown[at].chatId)}
          state={state}
          now={now}
          position={`${at + 1} of ${shown.length}`}
          onMove={(d) => setOpenKey(shown[(at + d + shown.length) % shown.length].key)}
          onClose={() => {
            const key = shown[at].key;
            setOpenKey(undefined);
            requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('.gallery-card')].find((el) => el.dataset.key === key)?.focus());
          }}
        />
      )}
    </div>
  );
}

/** The image's data: URI: from the state when it came as data, else the host's thumbnail (or whole image) of its file. */
function useSrc(img: GalleryImage, state: AppState, kind: 'imageThumb' | 'imageSrc', enabled: boolean): string | null | undefined {
  const fromFile = useHostImage(kind, img.path ?? '', enabled && !!img.path);
  if (img.imageId) return state.images.find((i) => i.id === img.imageId)?.src ?? null;
  return fromFile;
}

function Card({ img, chat, state, now, onOpen }: { img: GalleryImage; chat?: GalleryChat; state: AppState; now: number; onOpen(): void }) {
  const ref = useRef<HTMLLIElement>(null);
  const near = useNearScreen(ref);
  const src = useSrc(img, state, 'imageThumb', near);
  return (
    <li ref={ref} class="gallery-item">
      <button type="button" class="gallery-card" data-key={img.key} title={img.path ?? img.title} onClick={onOpen}>
        <span class="gallery-thumb" data-state={src ? 'ready' : src === null ? 'name' : 'wait'}>
          {src ? <img src={src} alt="" onLoad={fit} /> : src === null ? <span class="gallery-ext">{extension(img)}</span> : null}
        </span>
        <span class="gallery-title">{img.title}</span>
        {chat && (
          <span class="gallery-chat">
            <Glyph agent={chat.agent} size="sm" />
            <span class="gallery-chat-title">{chat.title}</span>
          </span>
        )}
        <span class="gallery-meta">
          <span>{SOURCE_LABEL[img.source]}</span>
          <span class="gallery-time">{ago(img.at, now)}</span>
        </span>
      </button>
    </li>
  );
}

/** A strip (a tab bar, a toolbar) or an image smaller than its card shows whole, not cropped and blown up. */
function fit(e: Event) {
  const i = e.currentTarget as HTMLImageElement;
  const ratio = i.naturalWidth / Math.max(1, i.naturalHeight);
  const small = i.naturalWidth < i.clientWidth && i.naturalHeight < i.clientHeight;
  if (ratio > 2.4 || ratio < 0.5 || small) i.dataset.fit = 'whole';
}

const extension = (img: GalleryImage) => (img.path?.split('.').pop() ?? 'image').toUpperCase();

/** The image large, inside the view: ← → (and the arrows) for the next, Esc closes. */
function Preview({ img, chat, state, now, position, onMove, onClose }: { img: GalleryImage; chat?: GalleryChat; state: AppState; now: number; position: string; onMove(delta: number): void; onClose(): void }) {
  const full = useSrc(img, state, 'imageSrc', true);
  // Past the preview's size cap the thumbnail stands in.
  const thumb = useSrc(img, state, 'imageThumb', full === null);
  const src = full ?? thumb;
  const box = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const keys = useRef({ onMove, onClose });
  keys.current = { onMove, onClose };
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') keys.current.onClose();
      else if (e.key === 'ArrowRight') keys.current.onMove(1);
      else if (e.key === 'ArrowLeft') keys.current.onMove(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const path = img.path;
  return (
    <div class="gallery-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="gallery-preview" ref={box} role="dialog" aria-modal="true" aria-label={img.title} tabIndex={-1}>
        <header class="preview-head">
          <div class="preview-text">
            <h2 class="preview-title">{img.title}</h2>
            <div class="preview-meta">
              <span>{SOURCE_LABEL[img.source]}</span>
              {chat && (
                <span class="gallery-chat">
                  <Glyph agent={chat.agent} size="sm" />
                  <span class="gallery-chat-title">{chat.title}</span>
                </span>
              )}
              <span>{ago(img.at, now)}</span>
              <span>{position}</span>
            </div>
          </div>
          <div class="preview-actions">
            {path && (
              <>
                <button type="button" class="sm" onClick={() => send({ type: 'openImage', path })}>
                  <Icon name="open" /> Open in editor
                </button>
                <button type="button" class="sm" onClick={() => send({ type: 'revealImage', path })}>
                  <Icon name="file" /> {REVEAL}
                </button>
                <button
                  type="button"
                  class="sm"
                  onClick={() => {
                    send({ type: 'copy', text: path });
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  <Icon name={copied ? 'check' : 'copy'} /> {copied ? 'Copied' : 'Copy path'}
                </button>
              </>
            )}
            {!isOutside(img.chatId) && (
              <button type="button" class="sm" onClick={() => send({ type: 'openChat', chatId: img.chatId, ...(img.stepId ? { item: img.stepId } : {}) })}>
                <Icon name="ask" /> {img.stepId ? 'Go to step in chat' : 'Go to chat'}
              </button>
            )}
            <button type="button" class="ghost icon-btn" aria-label="Close (Esc)" title="Close (Esc)" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div class="preview-stage">
          <button type="button" class="preview-nav" data-dir="prev" aria-label="Previous image (←)" title="Previous (←)" onClick={() => onMove(-1)}>
            <Icon name="chevron" size={20} />
          </button>
          {src ? (
            <img class="preview-img" src={src} alt={img.title} />
          ) : (
            <div class="preview-none">{src === null ? `${img.path ? humanTitle(img.path) : img.title} can’t be shown here. Open it in the editor.` : ''}</div>
          )}
          <button type="button" class="preview-nav" data-dir="next" aria-label="Next image (→)" title="Next (→)" onClick={() => onMove(1)}>
            <Icon name="chevron" size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
