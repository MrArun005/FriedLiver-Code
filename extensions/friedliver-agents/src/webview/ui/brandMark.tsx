// The FriedLiver mark (COMPONENTS.md v2 §1.6; owner, 2026-10-21: the Beacon mockups' outline mark is the logo): a
// line drawing with a 16% fill in --brand, 2px at 40 and up, 1.5px below. Never a control. The drawing lives
// in friedliverMark.ts (the one source: the Demo agent's mark and the editor-tab icons use it too).
import { FRIEDLIVER_MARK } from './friedliverMark';

export function BrandMark({ size = 16, class: className }: { size?: number; class?: string }) {
  const w = size >= 40 ? 2 : 1.5;
  return (
    <svg class={`fl-brand${className ? ` ${className}` : ''}`} width={size} height={size} viewBox={FRIEDLIVER_MARK.viewBox} aria-hidden="true" focusable="false">
      <path d={FRIEDLIVER_MARK.fill} fill="currentColor" fill-opacity=".16" stroke="currentColor" stroke-width={w} vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      <path d={FRIEDLIVER_MARK.d} fill="none" stroke="currentColor" stroke-width={w} vector-effect="non-scaling-stroke" stroke-linecap="round" />
    </svg>
  );
}
