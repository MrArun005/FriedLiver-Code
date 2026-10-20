// Agent marks (COMPONENTS.md v2 §2.22b): one small monochrome drawing per agent, on the 16 grid with the
// icon set's 1.5px stroke. Neutral glyphs, not the vendors' logos: the repo ships none and licences vary.
import type { AgentKey } from '../../shared/model';
import { FRIEDLIVER_MARK } from './friedliverMark';

/** `d` is stroked, `fill` is filled; both in `viewBox` (16 × 16 unless given). */
export interface Mark {
  d: string;
  fill?: string;
  viewBox?: string;
}

// TODO(integrator, Beacon B/B2): spec §2.22b moves Codex off `{ }` (it reads as a JSON file icon) to its own
// glyph, drawn in phase B (design/v2-workbench, COMPONENTS.md agent marks). Until that lands this placeholder
// keeps the braces; replace only this constant, then run `node scripts/agent-icons.mjs`.
export const CODEX_MARK: Mark = { d: 'M6 2.5c-1.4 0-2 .6-2 1.8v1.5c0 1-.5 1.7-1.5 2.2 1 .5 1.5 1.2 1.5 2.2v1.5c0 1.2.6 1.8 2 1.8M10 2.5c1.4 0 2 .6 2 1.8v1.5c0 1 .5 1.7 1.5 2.2-1 .5-1.5 1.2-1.5 2.2v1.5c0 1.2-.6 1.8-2 1.8' };

export const MARKS: Record<AgentKey | 'agent', Mark> = {
  // An eight-ray burst.
  claude: { d: 'M8 1.75v4M8 10.25v4M1.75 8h4M10.25 8h4M3.6 3.6l2.8 2.8M9.6 9.6l2.8 2.8M12.4 3.6 9.6 6.4M6.4 9.6 3.6 12.4' },
  codex: CODEX_MARK,
  // A four-point sparkle.
  gemini: { d: 'M8 1.75C8.5 5.5 10.5 7.5 14.25 8 10.5 8.5 8.5 10.5 8 14.25 7.5 10.5 5.5 8.5 1.75 8 5.5 7.5 7.5 5.5 8 1.75Z' },
  // An arrow lifting off a baseline.
  antigravity: { d: 'M8 11.25V2.75M4.75 6 8 2.75 11.25 6M3.25 13.75h9.5' },
  demo: FRIEDLIVER_MARK,
  // Any other agent: a small robot face.
  agent: { d: 'M2.5 5h11v8h-11zM8 2.25V5M6 8.5v1M10 8.5v1' },
};

export const markFor = (agent: string): Mark => (Object.hasOwn(MARKS, agent) && agent !== 'agent' ? MARKS[agent as keyof typeof MARKS] : MARKS.agent);
