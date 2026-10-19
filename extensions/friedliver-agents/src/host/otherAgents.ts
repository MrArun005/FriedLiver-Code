// Other agent extensions people may want next to FriedLiver's agents. Offered
// from the extension gallery (Open VSX in the FriedLiver app) as their
// publishers ship them; FriedLiver never bundles or changes them.

export interface OtherAgent {
  /** The gallery id, publisher.name. */
  id: string;
  name: string;
  publisher: string;
  what: string;
}

export const OTHER_AGENTS: readonly OtherAgent[] = [
  { id: 'Anthropic.claude-code', name: 'Claude Code', publisher: 'Anthropic', what: "Anthropic's own Claude Code in the editor" },
  { id: 'saoudrizwan.claude-dev', name: 'Cline', publisher: 'Cline', what: 'An open-source coding agent for many model providers' },
  { id: 'RooVeterinaryInc.roo-cline', name: 'Roo Code', publisher: 'Roo Code', what: 'A coding agent with modes for writing, planning and debugging' },
  { id: 'kilocode.Kilo-Code', name: 'Kilo Code', publisher: 'Kilo Code', what: 'An open-source coding agent with many model providers' },
  { id: 'Continue.continue', name: 'Continue', publisher: 'Continue', what: 'Chat, autocomplete and agents with the models you choose' },
];
