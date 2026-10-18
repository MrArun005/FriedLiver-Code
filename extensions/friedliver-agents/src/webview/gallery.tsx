import { useMemo, useRef, useState } from 'preact/hooks';
import { IMAGE_SOURCES, SOURCE_LABEL, collectGallery, filterGallery, sourceCounts, type GalleryChat, type GalleryImage, type ImageSource, type OutsideImages } from '../shared/gallery';
import type { AppState } from '../shared/model';
import { ago } from '../shared/view';
import { Glyph, Icon, useNearScreen, usePersisted, useTabStrip } from './common';
import { Viewer, useSrc } from './viewer';
import { FilterPill, Tab } from './ui';


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
            <Tab
              key={id || 'all'}
              selected={selected}
              tabIndex={selected ? 0 : -1}
                title={c ? `${c.title}: ${c.count} image${c.count === 1 ? '' : 's'}` : `Every chat: ${images.length} images`}
                onSelect={() => setTab(id)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  e.preventDefault();
                  const next = (n + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
                  setTab(tabs[next]?.id ?? '');
                  (strip.current?.children[next]?.firstElementChild as HTMLElement | null)?.focus();
                }}
              >
                {c ? <Glyph agent={c.agent} size="sm" /> : <Icon name="grid" size={14} />}
                <span class="fl-tab__label tab-title">{c ? c.title : 'All'}</span>
                <span class="fl-count tab-count">{c ? c.count : images.length}</span>
            </Tab>
          );
        })}
      </div>
      <div class="gallery-bar">
        <div class="gallery-filters" role="group" aria-label="Show images that were">
          {IMAGE_SOURCES.filter((s) => counts[s] || sources.includes(s)).map((s) => (
            <FilterPill key={s} size="md" class="filter-chip" pressed={sources.includes(s)} onPress={() => toggle(s)}>
              {SOURCE_LABEL[s]} <span class="fl-pill__sub filter-count">{counts[s]}</span>
            </FilterPill>
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
        <Viewer
          images={shown}
          start={at}
          state={state}
          now={now}
          chatOf={(id) => chatOf.get(id)}
          onClose={(key) => {
            setOpenKey(undefined);
            requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('.gallery-card')].find((el) => el.dataset.key === key)?.focus());
          }}
        />
      )}
    </div>
  );
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
