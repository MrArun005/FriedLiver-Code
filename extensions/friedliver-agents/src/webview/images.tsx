import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ImageItem } from '../shared/model';
import { useHost } from './common';

/** Images you attach and images the agent reads or sends, newest first; click to enlarge. */
function Images() {
  const { state } = useHost();
  const [zoomed, setZoomed] = useState<ImageItem | null>(null);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setZoomed(null);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  if (state.images.length === 0) {
    return <div class="empty">Images you attach, and screenshots or image files the agent reads, show up here.</div>;
  }
  return (
    <div class="images">
      {[...state.images].reverse().map((img) => (
        <figure key={img.id}>
          <button class="thumb" onClick={() => setZoomed(img)} title="Click to enlarge">
            <img src={img.src} alt={img.title} />
          </button>
          <figcaption>
            <span class="caption">{img.title}</span> <span class="tag">{img.from === 'you' ? 'you' : 'agent'}</span>
          </figcaption>
        </figure>
      ))}
      {zoomed && (
        <div class="lightbox" role="dialog" aria-label={zoomed.title} onClick={() => setZoomed(null)}>
          <img src={zoomed.src} alt={zoomed.title} />
          <div class="hint">{zoomed.title} · click or press Esc to close</div>
        </div>
      )}
    </div>
  );
}

render(<Images />, document.getElementById('root')!);
