// Agent marks (COMPONENTS.md v2 §2.22b). Since 2026-10-21 (owner) the known agents show their vendor's own
// logo (ui/logos.ts: sources, colours and the rules for using them); an unknown agent a neutral line glyph on
// the 16 grid with the icon set's 1.5px stroke. FriedLiver's own mark (Demo) is the outline mark.
import type { AgentKey } from '../../shared/model';
import { FRIEDLIVER_MARK } from './friedliverMark';
import { ANTIGRAVITY_LOGO, CLAUDE_LOGO, GEMINI_LOGO, OPENAI_LOGO } from './logos';

/**
 * A drawing in `viewBox` (16 × 16 unless given). Line marks: `d` stroked, `fill` filled at 16%. Logos: `logo`
 * filled in `color` (a CSS colour, a --logo-* token), or `svg`, a vendor's own multi-layer body as published.
 */
export interface Mark {
  d: string;
  fill?: string;
  viewBox?: string;
  logo?: { color: string };
  svg?: string;
}

export const MARKS: Record<AgentKey | 'agent', Mark> = {
  claude: { d: CLAUDE_LOGO, viewBox: '0 0 24 24', logo: { color: 'var(--logo-claude)' } },
  codex: { d: OPENAI_LOGO, viewBox: '0 0 24 24', logo: { color: 'var(--logo-openai)' } },
  gemini: { d: GEMINI_LOGO, viewBox: '0 0 24 24', logo: { color: 'var(--logo-gemini)' } },
  antigravity: { d: '', viewBox: ANTIGRAVITY_LOGO.viewBox, svg: ANTIGRAVITY_LOGO.svg },
  demo: FRIEDLIVER_MARK,
  // Any other agent: a small robot face.
  agent: { d: 'M2.5 5h11v8h-11zM8 2.25V5M6 8.5v1M10 8.5v1' },
};

export const markFor = (agent: string): Mark => (Object.hasOwn(MARKS, agent) && agent !== 'agent' ? MARKS[agent as keyof typeof MARKS] : MARKS.agent);
