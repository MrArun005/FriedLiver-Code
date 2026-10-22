// Agent marks (COMPONENTS.md v2 §2.22b). Since 2026-10-21 (owner) the known agents show their vendor's own
// logo (ui/logos.ts: sources, colours and the rules for using them); an unknown agent a neutral line glyph on
// the 16 grid with the icon set's 1.5px stroke. FriedLiver's own mark (Demo) is the outline mark.
import type { AgentGlyph } from '../../shared/agentForm';
import { customAgent, type AgentKey, type BuiltinAgentKey } from '../../shared/model';
import { FRIEDLIVER_MARK } from './friedliverMark';
import { ANTIGRAVITY_LOGO, CLAUDE_LOGO, COPILOT_LOGO, GEMINI_LOGO, OPENAI_LOGO, OPENCODE_LOGO } from './logos';

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

export const MARKS: Record<BuiltinAgentKey | 'agent', Mark> = {
  claude: { d: CLAUDE_LOGO, viewBox: '0 0 24 24', logo: { color: 'var(--logo-claude)' } },
  codex: { d: OPENAI_LOGO, viewBox: '0 0 24 24', logo: { color: 'var(--logo-openai)' } },
  gemini: { d: GEMINI_LOGO, viewBox: '0 0 24 24', logo: { color: 'var(--logo-gemini)' } },
  antigravity: { d: '', viewBox: ANTIGRAVITY_LOGO.viewBox, svg: ANTIGRAVITY_LOGO.svg },
  copilot: { d: COPILOT_LOGO, viewBox: '0 0 24 24', logo: { color: 'var(--logo-github)' } },
  opencode: { d: '', viewBox: OPENCODE_LOGO.viewBox, svg: OPENCODE_LOGO.svg },
  demo: FRIEDLIVER_MARK,
  // Any other agent: a small robot face.
  agent: { d: 'M2.5 5h11v8h-11zM8 2.25V5M6 8.5v1M10 8.5v1' },
};

/** The neutral marks a custom agent can wear (shared/agentForm.ts AGENT_GLYPHS), line glyphs on the 16 grid. */
export const GLYPHS: Record<AgentGlyph, Mark> = {
  agent: MARKS.agent,
  terminal: { d: 'M2.5 3h11v10h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5' },
  hexagon: { d: 'M8 1.75l5.5 3.1v6.3L8 14.25l-5.5-3.1v-6.3zM8 5.5v5' },
  spark: { d: 'M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2' },
};

export const markFor = (agent: string): Mark => {
  if (Object.hasOwn(MARKS, agent) && agent !== 'agent') return MARKS[agent as keyof typeof MARKS];
  return GLYPHS[customAgent(agent as AgentKey)?.glyph ?? 'agent'];
};
