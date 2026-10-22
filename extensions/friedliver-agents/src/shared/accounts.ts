// Agents & Accounts: what each agent's card shows and what the page may ask
// for (docs/ACCOUNTS.md). Pure, so the host, the page and the tests agree.
// Secrets never come here: a card says only whether a key is set.
import type { LinkMode } from './links';
import { AGENT_FACES, AGENT_KEYS, isAgentKey, type AgentKey } from './model';
import { isSystemTool, type SystemSettingsView, type SystemTool } from './system';
import { defaultChoices, offers, optionKey, type AgentDefaults, type SessionOption } from './session';

export type SignInState = 'signed-in' | 'needs-sign-in' | 'not-installed' | 'error';
export type VendorKey = Exclude<AgentKey, 'demo'>;

export const SIGN_IN_TEXT: Record<SignInState, string> = {
  'signed-in': 'Signed in',
  'needs-sign-in': 'Needs sign-in',
  'not-installed': 'Not installed',
  error: 'Problem',
};

export const isVendor = (agent: AgentKey): agent is VendorKey => agent !== 'demo';

/** An ACP sign-in method as FriedLiver offers it (agent-core signInMethods). */
export interface MethodView {
  id: string;
  name: string;
  description?: string;
  kind: 'browser' | 'terminal' | 'key';
}

/** Which identity the agent says it runs as (its `_auth/status_update`), as agent-core checked it. */
export interface Identity {
  /** none, account, api_key, external or gateway. */
  kind: string;
  label: string;
  detail?: string;
  email?: string;
  plan?: string;
  organization?: string;
}

/**
 * What FriedLiver last learned about an agent's sign-in, kept in the user's
 * globalState so showing it never starts the agent. Only Check, Refresh, a
 * sign-in or sign-out, or a chat's session with that agent change it.
 */
export interface AccountRecord {
  status: SignInState;
  /** When it was learned, ms since the epoch. */
  at: number;
  /** The adapter's version, and what to do when it is too old. */
  version?: string;
  update?: string;
  message?: string;
  /** The sign-in methods the agent offered (ACP authMethods). */
  methods?: MethodView[];
  identity?: Identity;
  /** The method last used to sign in from FriedLiver, by name. */
  via?: string;
  /** The agent signs out itself (ACP `logout`). */
  logout?: boolean;
}

const MAX_METHODS = 12;

/**
 * Folds what was just learned into the record. An identity the agent reports
 * decides the status (it comes after a sign-in or sign-out); one from before a
 * new status is dropped when the agent is gone or signed out.
 */
export function noteAccount(prev: AccountRecord | undefined, patch: Partial<AccountRecord>, at = Date.now()): AccountRecord {
  const next: AccountRecord = { ...prev, status: prev?.status ?? 'needs-sign-in', ...patch, at };
  if (patch.methods) next.methods = patch.methods.slice(0, MAX_METHODS);
  if (patch.identity) {
    next.status = patch.identity.kind === 'none' ? 'needs-sign-in' : 'signed-in';
    delete next.message;
  } else if (patch.status) {
    // A check's answer wins over an identity that says otherwise.
    const stale = patch.status === 'signed-in' ? prev?.identity?.kind === 'none' : prev?.identity?.kind !== 'none';
    if (stale) delete next.identity;
    if (!('message' in patch)) delete next.message;
  }
  if (patch.version !== undefined && !('update' in patch)) delete next.update;
  if (next.status === 'not-installed') {
    delete next.methods;
    delete next.version;
    delete next.update;
  }
  return next;
}

// ---- API keys and other credentials FriedLiver keeps for an agent ----

export interface KeyField {
  /** The environment variable the agent gets it as. */
  env: string;
  label: string;
  /** Kept in SecretStorage and never shown again; other fields show their value. */
  secret: boolean;
  placeholder?: string;
}

export interface KeySetup {
  id: 'apiKey' | 'vertex';
  name: string;
  description: string;
  fields: KeyField[];
  /** Any one group, all filled in, is enough. Default: every field. */
  requires?: string[][];
  /** Variables that come with it, not typed in. */
  fixed?: Record<string, string>;
  /** The agent's own ACP method for this, called after the key is saved so the agent records the choice. */
  acpMethods: string[];
}

export const KEY_SETUPS: Record<VendorKey, KeySetup[]> = {
  claude: [
    {
      id: 'apiKey',
      name: 'Anthropic API key',
      description: 'A key from the Anthropic Console, billed per use. Claude prefers it over a subscription login.',
      fields: [{ env: 'ANTHROPIC_API_KEY', label: 'API key', secret: true }],
      acpMethods: [],
    },
  ],
  codex: [
    {
      id: 'apiKey',
      name: 'OpenAI API key',
      description: 'A key from the OpenAI platform, billed per use.',
      fields: [{ env: 'OPENAI_API_KEY', label: 'API key', secret: true }],
      acpMethods: ['api-key', 'openai-api-key'],
    },
  ],
  gemini: [
    {
      id: 'apiKey',
      name: 'Gemini API key',
      description: 'A key from Google AI Studio, for the Gemini Developer API.',
      fields: [{ env: 'GEMINI_API_KEY', label: 'API key', secret: true }],
      acpMethods: ['gemini-api-key'],
    },
    {
      id: 'vertex',
      name: 'Vertex AI',
      description:
        'Your Google Cloud project and location, with gcloud application-default credentials on this machine, or a Vertex AI API key (express mode).',
      fields: [
        { env: 'GOOGLE_CLOUD_PROJECT', label: 'Project ID', secret: false, placeholder: 'my-project' },
        { env: 'GOOGLE_CLOUD_LOCATION', label: 'Location', secret: false, placeholder: 'us-central1' },
        { env: 'GOOGLE_API_KEY', label: 'Vertex AI API key (express mode)', secret: true },
      ],
      requires: [['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'], ['GOOGLE_API_KEY']],
      fixed: { GOOGLE_GENAI_USE_VERTEXAI: 'true' },
      acpMethods: ['vertex-ai'],
    },
  ],
  // agy signs in with Google itself; its API-key mode lives in its own settings.json, which FriedLiver never edits.
  antigravity: [],
};

export function keySetup(agent: AgentKey, id: unknown): KeySetup | undefined {
  return isVendor(agent) ? KEY_SETUPS[agent].find((s) => s.id === id) : undefined;
}

const PLAIN_VALUE = /^[\w.:@/-]{1,200}$/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A typed-in value FriedLiver will keep: one line, no control characters; non-secret ones plain words only. */
export function validKeyValue(field: KeyField, value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (v.length > 4096 || CONTROL.test(v)) return 'One line, without control characters.';
  if (!field.secret && !PLAIN_VALUE.test(v)) return 'Letters, digits and . - _ : / @ only.';
  return undefined;
}

/** Whether the values are enough for the setup, e.g. Vertex AI's project and location, or its key. */
export function setupComplete(setup: KeySetup, values: Record<string, string | undefined>): boolean {
  const groups = setup.requires ?? [setup.fields.map((f) => f.env)];
  return groups.some((g) => g.every((env) => !!values[env]?.trim()));
}

/** The environment the agent gets for a saved setup: its fields and its fixed variables. */
export function setupEnv(setup: KeySetup, values: Record<string, string | undefined>): Record<string, string> {
  if (!setupComplete(setup, values)) return {};
  const env: Record<string, string> = {};
  for (const f of setup.fields) {
    const v = values[f.env]?.trim();
    if (v) env[f.env] = v;
  }
  return { ...env, ...setup.fixed };
}

/** The agent's offered ACP method that goes with a setup, if it offers one. */
export function acpMethodFor(setup: KeySetup, offered: MethodView[] | undefined): string | undefined {
  return offered?.find((m) => setup.acpMethods.includes(m.id))?.id;
}

/**
 * The sign-in methods a card offers: the agent's browser and terminal methods.
 * Its key methods are covered by FriedLiver's key setups; one FriedLiver has
 * no setup for (a custom gateway) isn't offered.
 */
export function signInMethodsFor(offered: MethodView[] | undefined): MethodView[] {
  return (offered ?? []).filter((m) => m.kind !== 'key');
}

/** A method id the page may ask for: one the agent offered, by id. */
export function offeredMethod(offered: MethodView[] | undefined, methodId: string): MethodView | undefined {
  return offered?.find((m) => m.id === methodId);
}

// ---- The agents' own CLIs ----

export interface CliLine {
  /** Typed into a terminal; FriedLiver's own constant, plain characters only. */
  command: string;
  /** What to do once it runs, for a CLI that signs in or out from inside. */
  then?: string;
}

export interface CliAccount {
  /** Absent when FriedLiver doesn't offer the CLI's own sign-in (Gemini: Google login lives in Antigravity). */
  signIn?: CliLine;
  signOut: CliLine;
  note: string;
}

/** Each vendor's own CLI login, for a terminal; FriedLiver never deletes a CLI's files itself. */
export const CLI_ACCOUNTS: Record<VendorKey, CliAccount> = {
  claude: {
    signIn: { command: 'claude auth login' },
    signOut: { command: 'claude auth logout' },
    note: 'Claude Code’s CLI. FriedLiver’s Claude adapter uses the same login.',
  },
  codex: {
    signIn: { command: 'codex login' },
    signOut: { command: 'codex logout' },
    note: 'The Codex CLI (npm install -g @openai/codex). codex-acp uses the same login, in ~/.codex.',
  },
  gemini: {
    signOut: { command: 'gemini', then: 'Type /signout, which clears its cached credentials.' },
    note: 'The Gemini CLI itself: the same program FriedLiver runs in ACP mode.',
  },
  antigravity: {
    signIn: { command: 'agy', then: 'Choose Google OAuth and finish in the browser, then type /quit.' },
    signOut: { command: 'agy', then: 'Type /logout, which signs out and clears its saved tokens.' },
    note: 'Google’s Antigravity CLI. It has no ACP mode, so FriedLiver runs it through its own adapter with the same login. It can’t stop to ask, so Manual, Plan and /discuss are talk only (FriedLiver reads the project for it, in a deny-by-default sandbox); Edit automatically and Auto run it in the project. macOS only for now.',
  },
};

// ---- Default model and effort for new chats ----

/** The model and effort the agent's last session offered (cached per agent), and the user's choices. */
export function modelChoices(d: AgentDefaults | undefined): { model?: SessionOption; effort?: SessionOption; chosen: Record<string, string | boolean> } {
  const options = d?.options ?? [];
  return {
    model: options.find((o) => o.category === 'model' && o.type === 'select'),
    effort: options.find((o) => o.category === 'thought_level' && o.type === 'select'),
    chosen: defaultChoices(d),
  };
}

/**
 * The agent's defaults with what a session just offered: the fresh options
 * replace those of the same category, others are kept (a model list that
 * comes as Gemini's `models` stays when only config options change). Modes
 * aren't kept; the user's choices stay as they are.
 */
export function mergeOffered(prev: AgentDefaults | undefined, fresh: SessionOption[]): AgentDefaults {
  const options = fresh.filter((o) => o.category !== 'mode');
  const kept = (prev?.options ?? []).filter((o) => !options.some((n) => (n.category ?? `id:${n.id}`) === (o.category ?? `id:${o.id}`)));
  return { ...prev, options: [...kept, ...options], chosen: prev?.chosen ?? {} };
}

export type DefaultKey = 'model' | 'thought_level';

/** A default choice the page may set: a value the agent's cached option offers. */
export function validDefault(d: AgentDefaults | undefined, key: DefaultKey, value: string): boolean {
  const option = d?.options.find((o) => optionKey(o) === key);
  return !!option && offers(option, value);
}

// ---- Which agents the pickers show, and their sign-in marks ----

/**
 * Why `agent` can't run on this platform, or undefined when it can. Antigravity runs only inside macOS's sandbox
 * (agyAcp.ts PLATFORM_REFUSAL), so elsewhere it is hidden from pickers and refused by name until a sandbox exists.
 */
export function unavailableOn(agent: AgentKey, platform: string): string | undefined {
  if (agent !== 'antigravity' || platform === 'darwin') return undefined;
  return `Antigravity isn’t available on ${platform === 'win32' ? 'Windows' : 'Linux'} yet: FriedLiver runs it only inside macOS’s sandbox for now.`;
}

/** The agents pickers and menus offer: not the ones this platform can't run; the fake Demo agent only in tests (FRIEDLIVER_TEST_AGENTS=1). */
export function shownAgents(showDemo: boolean, platform: string = process.platform): AgentKey[] {
  return AGENT_KEYS.filter((a) => (showDemo || a !== 'demo') && !unavailableOn(a, platform));
}

export interface AgentRoster {
  agents: AgentKey[];
  /** The last known sign-in, per agent; absent when never checked. */
  signIn: Partial<Record<AgentKey, SignInState>>;
}

export function rosterOf(showDemo: boolean, records: Partial<Record<AgentKey, AccountRecord>>, platform: string = process.platform): AgentRoster {
  const agents = shownAgents(showDemo, platform);
  const signIn: AgentRoster['signIn'] = {};
  for (const a of agents) if (records[a]) signIn[a] = records[a]!.status;
  return { agents, signIn };
}

/** An agent the Accounts page last found missing: never preselected for a new task. Unchecked agents may be. */
export function installedOrUnknown(roster: AgentRoster, agent: AgentKey): boolean {
  return roster.signIn[agent] !== 'not-installed';
}

/**
 * The agents a new task (or Run on Several Agents) starts with: the last choice, without the ones the
 * Accounts page found not installed; else the first shown agent that is signed in, then the first not
 * known to be missing, then Demo. Picking an agent by hand still works whatever its status.
 */
export function preselectAgents(roster: AgentRoster, saved: readonly AgentKey[]): AgentKey[] {
  const kept = saved.filter((a) => roster.agents.includes(a) && installedOrUnknown(roster, a));
  if (kept.length) return kept;
  const priorityOrder: AgentKey[] = ['antigravity', ...roster.agents.filter((a) => a !== 'antigravity')];
  const first =
    priorityOrder.find((a) => roster.agents.includes(a) && a !== 'demo' && roster.signIn[a] === 'signed-in') ??
    priorityOrder.find((a) => roster.agents.includes(a) && a !== 'demo' && installedOrUnknown(roster, a)) ??
    (roster.agents.includes('demo') ? 'demo' : roster.agents[0]);
  return first ? [first] : [];
}

// ---- The page ----

export interface KeyView {
  id: KeySetup['id'];
  name: string;
  description: string;
  /** Per field: whether it is set, and the value of a non-secret one. */
  fields: { env: string; label: string; secret: boolean; set: boolean; value?: string }[];
  /** Saved and complete, so the agent gets it. */
  active: boolean;
}

export interface AccountCard {
  agent: AgentKey;
  name: string;
  record?: AccountRecord;
  checking?: boolean;
  /** What is going on now (signing in, signing out), shown on the card. */
  busy?: string;
  installCommand?: string;
  signIn: MethodView[];
  keys: KeyView[];
  /** A key variable the editor's own environment already gives the agent, by name only. */
  envKey?: string;
  cli?: CliAccount;
  /** One sentence: which way of signing in is in use. */
  active?: string;
  model?: SessionOption;
  effort?: SessionOption;
  chosen: Record<string, string | boolean>;
  /** Set when this platform can't run the agent ("macOS only for now"): the card shows only that. */
  unavailable?: string;
}

export interface AccountsView {
  cards: AccountCard[];
  /** The card to scroll to; `n` grows each time the page is opened on one. */
  focus?: { agent: AgentKey; n: number };
  /** Where links you click open. */
  links: LinkMode;
  /** "Mac & Windows control": the system_* tools' settings. */
  system?: SystemSettingsView;
}

/** Which way of signing in is in use, as well as FriedLiver can tell without asking the agent. */
export function activeMethod(card: Pick<AccountCard, 'record' | 'keys' | 'envKey' | 'agent'>): string | undefined {
  const id = card.record?.identity;
  if (id && id.kind !== 'none') return [id.label, id.email, id.organization, id.detail].filter(Boolean).join(' · ');
  const key = card.keys.find((k) => k.active);
  if (key) return `${key.name}, saved in FriedLiver`;
  if (card.envKey) return `${card.envKey} from the editor’s environment`;
  if (card.record?.status !== 'signed-in') return undefined;
  if (card.record.via) return `Signed in with ${card.record.via}`;
  return card.agent === 'demo' ? 'No account needed' : `${AGENT_FACES[card.agent].name}’s own login (its CLI’s saved credentials)`;
}

// ---- Messages from the page, checked before the host acts on them ----

export type CliWhat = 'install' | 'signIn' | 'signOut';

export type AccountsMessage =
  | { type: 'ready' }
  /** Where links you click open (friedliver.links.openIn). */
  | { type: 'setLinks'; mode: LinkMode }
  /** Starts the agent and a short session: sign-in, version and models. */
  | { type: 'check'; agent: AgentKey }
  /** One of the agent's own browser or terminal methods, by id. */
  | { type: 'signIn'; agent: AgentKey; methodId: string }
  /** The host asks for the values itself; the page never sees a key. */
  | { type: 'setKey'; agent: VendorKey; setup: KeySetup['id'] }
  | { type: 'clearKey'; agent: VendorKey }
  /** The agent's own sign-out (ACP logout). */
  | { type: 'signOut'; agent: AgentKey }
  | { type: 'terminal'; agent: VendorKey; what: CliWhat }
  | { type: 'copy'; agent: VendorKey; what: CliWhat }
  | { type: 'setDefault'; agent: AgentKey; key: DefaultKey; value: string }
  /** friedliver.system.enabled, .fullAutoAllowed, or one tool in .tools (the host confirms turning Full auto on). */
  | { type: 'setSystem'; key: 'enabled' | 'fullAutoAllowed' | SystemTool; value: boolean }
  /** Shows the "FriedLiver: System Actions" log. */
  | { type: 'systemLog' };

const METHOD_ID = /^[\w.:-]{1,128}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isWhat = (v: unknown): v is CliWhat => v === 'install' || v === 'signIn' || v === 'signOut';

/**
 * The message if it is well formed and names an agent the page shows (Demo only
 * when shown). The host still checks a method id against what the agent offers
 * and a default against what it last offered.
 */
export function parseAccountsMessage(raw: unknown, shown: readonly AgentKey[]): AccountsMessage | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  const m = raw;
  if (m.type === 'ready' || m.type === 'systemLog') return { type: m.type };
  if (m.type === 'setLinks') return m.mode === 'builtin' || m.mode === 'external' ? { type: 'setLinks', mode: m.mode } : null;
  if (m.type === 'setSystem') {
    const key = m.key;
    return (key === 'enabled' || key === 'fullAutoAllowed' || isSystemTool(key)) && typeof m.value === 'boolean' ? { type: 'setSystem', key, value: m.value } : null;
  }
  if (!isAgentKey(m.agent) || !shown.includes(m.agent)) return null;
  const agent = m.agent;
  switch (m.type) {
    case 'check':
    case 'signOut':
      return { type: m.type, agent };
    case 'signIn':
      return typeof m.methodId === 'string' && METHOD_ID.test(m.methodId) ? { type: 'signIn', agent, methodId: m.methodId } : null;
    case 'setKey': {
      const setup = keySetup(agent, m.setup);
      return setup && isVendor(agent) ? { type: 'setKey', agent, setup: setup.id } : null;
    }
    case 'clearKey':
      return isVendor(agent) ? { type: 'clearKey', agent } : null;
    case 'terminal':
    case 'copy':
      return isVendor(agent) && isWhat(m.what) ? { type: m.type, agent, what: m.what } : null;
    case 'setDefault':
      return (m.key === 'model' || m.key === 'thought_level') && typeof m.value === 'string' && m.value.length > 0 && m.value.length <= 256
        ? { type: 'setDefault', agent, key: m.key, value: m.value }
        : null;
    default:
      return null;
  }
}
