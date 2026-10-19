// The listening mic's voice visualizer: white bars that rise and fall with the speaker's loudness.
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { BARS, visualizerFrame } from '../shared/dictation';

/** The latest loudness from the host (0…1) and when it came (performance.now()). */
export type LevelRef = { current: { level: number; at: number } };

export function MicVisualizer({ level }: { level: LevelRef }) {
  // Reduced motion: a simple pulsing dot instead of moving bars.
  const reduced = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);
  const bars = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (reduced) return;
    let shown = 0;
    let last = 0;
    let frame = 0;
    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      if (t - last < 33) return; // about 30 frames a second
      last = t;
      const f = visualizerFrame(shown, level.current.level, t - level.current.at, t);
      shown = f.shown;
      const el = bars.current;
      if (!el) return;
      // Straight to the DOM: no render per frame.
      f.bars.forEach((h, i) => (el.children[i] as HTMLElement | undefined)?.style.setProperty('transform', `scaleY(${h.toFixed(3)})`));
      el.dataset.level = shown.toFixed(2);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  if (reduced) return <span class="mic-dot" aria-hidden="true" />;
  return (
    <span class="mic-bars" ref={bars} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}
