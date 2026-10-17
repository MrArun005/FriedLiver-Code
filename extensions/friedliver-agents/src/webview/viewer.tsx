// One image viewer for every surface: a chat's step thumbnails and its Images strip, and the Images view.
// It opens on the image clicked with the whole set around it: arrows, a filmstrip, a counter, zoom and pan.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { SOURCE_LABEL, isOutside, type GalleryImage } from '../shared/gallery';
import type { AgentKey, AppState } from '../shared/model';
import { humanTitle } from '../shared/stepImages';
import { ago } from '../shared/view';
import { clampPan, fitScale, MAX_SCALE, navTo, zoomTo } from '../shared/viewer';
import { Glyph, Icon, send, useHostImage, useNearScreen } from './common';

const PLATFORM = document.body.dataset.platform;
const REVEAL = PLATFORM === 'darwin' ? 'Reveal in Finder' : PLATFORM === 'win32' ? 'Reveal in File Explorer' : 'Open containing folder';
/** Horizontal trackpad travel that turns the page, and the pause before the next. */
const SWIPE_PX = 60;
const SWIPE_MS = 350;

/** The image's data: URI: from the state when it came as data, else the host's thumbnail (or whole image) of its file. */
export function useSrc(img: GalleryImage | undefined, state: AppState, kind: 'imageThumb' | 'imageSrc', enabled: boolean): string | null | undefined {
  const fromFile = useHostImage(kind, img?.path ?? '', enabled && !!img?.path);
  if (!img) return undefined;
  if (img.imageId) return state.images.find((i) => i.id === img.imageId)?.src ?? null;
  return fromFile;
}

interface Props {
  images: readonly GalleryImage[];
  start: number;
  state: AppState;
  now: number;
  /** The chat an image came from, for its line under the title. */
  chatOf(chatId: string): { title: string; agent: AgentKey } | undefined;
  /** Closed on this image: the caller puts focus back where it came from. */
  onClose(key: string): void;
}

export function Viewer({ images, start, state, now, chatOf, onClose }: Props) {
  const [at, setAt] = useState(Math.max(0, Math.min(images.length - 1, start)));
  const img = images[Math.min(at, images.length - 1)];
  // null: fit to the view; else the scale (1 = the image's own size) and the pan from the centre.
  const [zoom, setZoom] = useState<{ s: number; x: number; y: number } | null>(null);
  const imgEl = useRef<HTMLImageElement>(null);
  // The image's own size, read off the element (a cached image may never fire load again).
  const natural = () => {
    const i = imgEl.current;
    return i && i.naturalWidth ? { w: i.naturalWidth, h: i.naturalHeight } : null;
  };
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const full = useSrc(img, state, 'imageSrc', true);
  // Past the preview's size cap the thumbnail stands in.
  const thumb = useSrc(img, state, 'imageThumb', full === null);
  const src = full ?? thumb;

  const go = (i: number) => {
    if (i === at || i < 0 || i >= images.length) return;
    setAt(i);
    setZoom(null);
  };
  const stageSize = () => {
    const r = canvas.current?.getBoundingClientRect();
    return { w: r?.width ?? 1, h: r?.height ?? 1 };
  };
  const fit = () => {
    const nat = natural();
    return nat ? fitScale(nat.w, nat.h, stageSize().w, stageSize().h) : 1;
  };
  const scaleTo = (s: number, x = zoom?.x ?? 0, y = zoom?.y ?? 0) => {
    const nat = natural();
    if (!nat) return;
    const f = fit();
    const next = Math.min(MAX_SCALE, Math.max(f, s));
    if (Math.abs(next - f) < 1e-6) return setZoom(null);
    const { w, h } = stageSize();
    setZoom({ s: next, ...clampPan(x, y, nat.w * next, nat.h * next, w, h) });
  };
  const zoomBy = (how: 'in' | 'out' | 'fit' | 'toggle') => scaleTo(zoomTo(how, zoom?.s ?? fit(), fit()));

  // Keys while open: the latest handlers, one listener.
  const live = useRef({ go, zoomBy, at, close: () => onClose(img.key), n: images.length });
  live.current = { go, zoomBy, at, close: () => onClose(img.key), n: images.length };
  // Layout effect: the keys work the moment the viewer is on screen.
  useLayoutEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const k = live.current;
      const to = navTo(e.key, k.at, k.n);
      if (e.key === 'Escape') k.close();
      else if (to !== undefined) k.go(to);
      else if (e.key === '+' || e.key === '=') k.zoomBy('in');
      else if (e.key === '-' || e.key === '_') k.zoomBy('out');
      else if (e.key === '0') k.zoomBy('fit');
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Wheel and pinch (Ctrl+wheel) zoom; a sideways swipe turns the page, or pans a zoomed image.
  const wheel = useRef({ acc: 0, last: 0 });
  const zoomRef = useRef({ zoom, scaleTo, go, at });
  zoomRef.current = { zoom, scaleTo, go, at };
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { zoom: z, scaleTo: to, go: move, at: here } = zoomRef.current;
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!sideways || e.ctrlKey) return to((z?.s ?? fit()) * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
      if (z) return to(z.s, z.x - e.deltaX, z.y - e.deltaY);
      const w = wheel.current;
      w.acc += e.deltaX;
      if (Math.abs(w.acc) < SWIPE_PX || e.timeStamp - w.last < SWIPE_MS) return;
      move(here + Math.sign(w.acc));
      w.acc = 0;
      w.last = e.timeStamp;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // The filmstrip keeps the current image in view.
  useLayoutEffect(() => {
    strip.current?.children[at]?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [at]);

  // Drag to pan, when zoomed.
  const drag = useRef<{ x: number; y: number; zx: number; zy: number } | null>(null);
  const chat = chatOf(img.chatId);
  const path = img.path;
  const nat = natural();
  const imgStyle = zoom && nat ? { width: `${nat.w * zoom.s}px`, height: `${nat.h * zoom.s}px`, transform: `translate(calc(-50% + ${zoom.x}px), calc(-50% + ${zoom.y}px))` } : undefined;
  return (
    <div class="gallery-overlay viewer" onClick={(e) => e.target === e.currentTarget && onClose(img.key)}>
      <div class="gallery-preview" ref={box} role="dialog" aria-modal="true" aria-label={`${img.title}, ${at + 1} of ${images.length}`} tabIndex={-1}>
        <header class="preview-head">
          <span class="viewer-count" aria-live="polite">
            {at + 1} / {images.length}
          </span>
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
            </div>
          </div>
          <div class="preview-actions">
            <span class="viewer-zoom" role="group" aria-label="Zoom">
              <button type="button" class="ghost icon-btn" aria-label="Zoom out (−)" title="Zoom out (−)" disabled={!zoom} onClick={() => zoomBy('out')}>
                <Icon name="minus" />
              </button>
              <button type="button" class="ghost sm viewer-scale" title="Fit, or 100% (0, double-click)" onClick={() => zoomBy('toggle')}>
                {zoom ? `${Math.round(zoom.s * 100)}%` : 'Fit'}
              </button>
              <button type="button" class="ghost icon-btn" aria-label="Zoom in (+)" title="Zoom in (+)" onClick={() => zoomBy('in')}>
                <Icon name="plus" />
              </button>
            </span>
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
              <button
                type="button"
                class="sm"
                onClick={() => {
                  send({ type: 'openChat', chatId: img.chatId, ...(img.stepId ? { item: img.stepId } : {}) });
                  onClose(img.key);
                }}
              >
                <Icon name="ask" /> {img.stepId ? 'Go to step in chat' : 'Go to chat'}
              </button>
            )}
            <button type="button" class="ghost icon-btn" aria-label="Close (Esc)" title="Close (Esc)" onClick={() => onClose(img.key)}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div class="preview-stage">
          <button type="button" class="preview-nav" data-dir="prev" aria-label="Previous image (←)" title="Previous (←)" disabled={at === 0} onClick={() => go(at - 1)}>
            <Icon name="chevron" size={20} />
          </button>
          <div
            class="viewer-canvas"
            ref={canvas}
            data-zoomed={zoom ? '' : undefined}
            onDblClick={() => zoomBy('toggle')}
            onPointerDown={(e) => {
              if (!zoom) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, zx: zoom.x, zy: zoom.y };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d && zoom) scaleTo(zoom.s, d.zx + e.clientX - d.x, d.zy + e.clientY - d.y);
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            {src ? (
              <img
                class="preview-img"
                src={src}
                alt={img.title}
                draggable={false}
                ref={imgEl}
                style={imgStyle}
              />
            ) : (
              <div class="preview-none">{src === null ? `${img.path ? humanTitle(img.path) : img.title} can’t be shown here. Open it in the editor.` : ''}</div>
            )}
          </div>
          <button type="button" class="preview-nav" data-dir="next" aria-label="Next image (→)" title="Next (→)" disabled={at === images.length - 1} onClick={() => go(at + 1)}>
            <Icon name="chevron" size={20} />
          </button>
        </div>
        {images.length > 1 && (
          <div class="viewer-strip" ref={strip} role="listbox" aria-label="Images" aria-orientation="horizontal">
            {images.map((im, i) => (
              <StripThumb key={im.key} img={im} state={state} current={i === at} onPick={() => go(i)} />
            ))}
          </div>
        )}
        {/* The neighbours' whole images, loaded ahead: two at most. */}
        <Preload img={images[at + 1]} state={state} />
        <Preload img={images[at - 1]} state={state} />
      </div>
    </div>
  );
}

function StripThumb({ img, state, current, onPick }: { img: GalleryImage; state: AppState; current: boolean; onPick(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNearScreen(ref);
  const src = useSrc(img, state, 'imageThumb', near || current);
  return (
    <button ref={ref} type="button" role="option" class="viewer-thumb" aria-selected={current} aria-label={img.title} title={img.title} onClick={onPick}>
      {src ? <img src={src} alt="" draggable={false} /> : <span class="viewer-thumb-name">{(img.path?.split('.').pop() ?? 'img').toUpperCase()}</span>}
    </button>
  );
}

function Preload({ img, state }: { img?: GalleryImage; state: AppState }) {
  useSrc(img, state, 'imageSrc', !!img);
  return null;
}
