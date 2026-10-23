// Just enough of the Model Context Protocol for the FriedLiver tools: answers
// to initialize, ping, tools/list and tools/call, for the server over stdio
// (server.ts) and the one over HTTP (http.ts). An agent that takes only stdio
// servers starts its own copy of dist/bridge.js per session and keeps it for as
// long as the session lives, so fifteen chats are fifteen of these processes.
// With the MCP SDK, zod and ajv in it, each one held about 10 MB more than the
// runtime itself; written out here, it holds next to nothing.
import { AGENT_KEYS } from '../shared/model';
import { SYSTEM_LIMITS, SYSTEM_TOOLS, unsupportedOn, type SystemTool } from '../shared/system';
import { READ_LIMITS } from '../host/indexReads';
import { SHOT } from '../host/browserRules';
import { SNAPSHOT_LIMITS } from '../host/pageText';
import { BRIDGE_LIMITS, PERMISSION_HOOK_TOOL, parseCall, type BridgeCall } from './protocol';

/** Newest first; a client asking for another version gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

const INSTRUCTIONS = {
  head:
    'Tools from FriedLiver, the editor you run in. They reach the other coding agents and chats open there. ' +
    'The user may be asked to allow each call, and may say no; carry on without it if so.',
  browser: 'The browser_* tools drive the browser built into FriedLiver (http and https pages only), which the user sees beside the code.',
  system: "The system_* tools act on the user's Mac or Windows PC (open apps, files and links, the clipboard, notifications, volume, window screenshots); each is asked for.",
  index:
    'The index_* tools query a ready index of this project and cost far fewer tokens than reading files: ' +
    'find code with index_search or index_symbols (not grep), look at a file with index_outline, read just the part you need with index_read (a symbol or lines, not the whole file), ' +
    'and after a file changed use index_diff (what changed since you saw it) or index_changes with since "last_turn" instead of reading it again.',
};

/** The server's instructions, naming only the kinds of tools this session was offered. */
export function instructionsFor(tools: readonly { name: string }[]): string {
  const has = (prefix: string) => tools.some((t) => t.name.startsWith(prefix));
  return [INSTRUCTIONS.head, has('browser_') && INSTRUCTIONS.browser, has('system_') && INSTRUCTIONS.system, has('index_') && INSTRUCTIONS.index].filter(Boolean).join(' ');
}

const CHAT_ID = { type: 'string', pattern: '^[\\w.:-]{1,128}$' };
const NO_INPUT = { type: 'object', properties: {} };

/** What tools/list says: the same tools, words and schemas the MCP SDK made from the zod schemas before. */
export const TOOLS = [
  {
    name: 'list_agents',
    title: 'List agents',
    description: 'Lists the coding agents FriedLiver can start, with the key to pass as `agent` to ask_agent.',
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_chats',
    title: 'List chats',
    description:
      'Lists the chats open in FriedLiver: id, agent, task and whether each is busy. This chat is marked. ' +
      'Use an id with read_chat, send_to_chat, or as chat_id for ask_agent.',
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ask_agent',
    title: 'Ask another agent',
    description:
      'Asks another coding agent a question and waits for its answer, which can take minutes. ' +
      'It works in the same folder and gets a short summary of this chat, so make the question self-contained. ' +
      'Good for a second opinion, a review, or a part of the task another agent is better at. ' +
      'Asking the same agent again continues the same consultation; pass chat_id to ask a specific chat instead. ' +
      'The user is asked to allow it first unless they already did.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          // Built-in agents, or a custom one the user added (`custom:<id>`, as list_agents names it).
          pattern: `^(${AGENT_KEYS.filter((a) => a !== 'demo').join('|')}|custom:[a-z][a-z0-9]{1,23})$`,
          description: 'Which agent: claude, codex (GPT), gemini, antigravity (Google models through the Antigravity CLI), copilot (GitHub Copilot CLI), opencode (OpenCode), or a custom agent by the key list_agents gives.',
        },
        prompt: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.text, description: 'The question or request, written for the other agent.' },
        chat_id: { description: 'Ask this existing chat (it must be idle and use `agent`) instead of starting or reusing a consultation.', ...CHAT_ID },
      },
      required: ['agent', 'prompt'],
    },
  },
  {
    name: 'send_to_chat',
    title: 'Message a chat',
    description:
      'Sends a message to another FriedLiver chat, as if the user typed it there, and returns at once without its reply. ' +
      'The chat must be idle. Use read_chat later to see what it answered. The user is asked to allow it first unless they already did.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { ...CHAT_ID, description: 'A chat id from list_chats, like "chat-3".' },
        message: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.text, description: 'The message, written for the agent in that chat.' },
      },
      required: ['chat_id', 'message'],
    },
  },
  {
    name: 'read_chat',
    title: 'Read a chat',
    description: 'Reads the latest messages of another FriedLiver chat: what the user and its agent said. The user is asked to allow it first unless they already did.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { ...CHAT_ID, description: 'A chat id from list_chats, like "chat-3".' },
        last: { description: 'How many of the latest messages to return. Default 10.', type: 'integer', minimum: 1, maximum: BRIDGE_LIMITS.last },
      },
      required: ['chat_id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'remember',
    title: 'Remember',
    description:
      'Saves one short fact about this project (a convention, a command, a decision) to .friedliver/memory.md, ' +
      'which every agent in FriedLiver gets at the start of its next sessions. Only durable facts, not progress notes. ' +
      'The user is asked to allow it first unless they already did.',
    inputSchema: {
      type: 'object',
      properties: { fact: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.text, description: 'The fact, in one sentence.' } },
      required: ['fact'],
    },
  },
  ...indexTools(),
  ...browserTools(),
  ...systemTools(),
].map((t) => ({ ...t, execution: { taskSupport: 'forbidden' } }));

function indexTools() {
  const PATH = { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.query, description: 'A file path relative to the workspace folder, like "src/app.ts".' };
  const ro = { annotations: { readOnlyHint: true } };
  const PREFER = ' Cheaper than grep or reading files for "where is X": use it first.';
  return [
    {
      name: 'index_search',
      title: 'Search the project index',
      description:
        "Searches FriedLiver's index of this project by keywords or identifiers (camelCase and snake_case parts match too). Returns the best-ranked files, " +
        'each with its matching definitions and a few numbered ±3-line windows, within a token budget. Repeated windows are named, not repeated.' + PREFER,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.query, description: 'Words or identifiers, like "refresh token expiry" or "parseConfig".' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many files to return. Default 10.' },
          budget: { type: 'integer', minimum: READ_LIMITS.minBudget, maximum: READ_LIMITS.maxBudget, description: `Most tokens the answer may take. Default ${READ_LIMITS.budget}.` },
        },
        required: ['query'],
      },
      ...ro,
    },
    {
      name: 'index_symbols',
      title: 'Find definitions',
      description: 'Finds where functions, classes, types and the like with this name are defined in the project (exact name, else names starting with it).' + PREFER,
      inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.query, description: 'A name, like "UserService".' } }, required: ['name'] },
      ...ro,
    },
    {
      name: 'index_read',
      title: 'Read part of a file',
      description:
        'Reads one definition (symbol, e.g. "parseConfig" or "UserService.save") or a line range of a project file, with numbered lines and a one-line header. ' +
        'Use it instead of reading whole files: a file over 150 lines comes back as its outline unless you name a symbol or lines.',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH,
          symbol: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.query, description: 'A function, class, method or type in the file; Outer.inner for one inside another.' },
          lines: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2, description: 'First and last line, like [120, 180]. Not with symbol.' },
        },
        required: ['path'],
      },
      ...ro,
    },
    {
      name: 'index_outline',
      title: 'Outline a file',
      description: 'The signatures of the definitions in one file, with their lines: the cheapest look at a file. Then index_read a symbol.',
      inputSchema: { type: 'object', properties: { path: PATH }, required: ['path'] },
      ...ro,
    },
    {
      name: 'index_related',
      title: 'Related files',
      description: 'The files a file imports and the project files that import it (TS/JS, Python, Go, Java/Kotlin).',
      inputSchema: { type: 'object', properties: { path: PATH }, required: ['path'] },
      ...ro,
    },
    {
      name: 'index_diff',
      title: 'Diff since you saw it',
      description:
        'A compact unified diff of a project file against the version you were last shown in this chat (by index_read or a file read FriedLiver saw). ' +
        'Use it instead of re-reading a file after it changed.',
      inputSchema: { type: 'object', properties: { path: PATH }, required: ['path'] },
      ...ro,
    },
    {
      name: 'index_changes',
      title: 'Changed files',
      description:
        "The project's current hash (the root of a Merkle tree over the indexed files) and the files added, modified or deleted since an earlier hash: by default since the project was last opened.",
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            pattern: '^([0-9a-fA-F]{8,64}|last_turn)$',
            description: '"last_turn" for what changed since your previous turn in this chat (marking files you already have), or an earlier project hash (8+ characters).',
          },
        },
      },
      ...ro,
    },
  ];
}

function browserTools() {
  const tool = (name: string, title: string, description: string, properties: Record<string, object> = {}, required: string[] = [], readOnly = false) => ({
    name,
    title,
    description,
    inputSchema: Object.keys(properties).length ? { type: 'object', properties, ...(required.length ? { required } : {}) } : NO_INPUT,
    ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
  });
  const SELECTOR = { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.url, description: 'An element id from browser_snapshot with elements: true, like "e12", or a CSS selector like "#submit".' };
  const ASKS = ' The user is asked to allow it first unless the chat is in Auto mode.';
  const DOWNLOADS = ' If it starts a download, the user is asked to allow that too; the result then gives the saved file\'s path, size and sha256.';
  return [
    tool('browser_open', 'Open a page', 'Opens an http or https URL in FriedLiver\'s browser (opening the browser if needed) and waits for it to load. localhost:3000 works too.' + ASKS + DOWNLOADS, {
      url: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.url, description: 'http://, https://, or a bare localhost:<port> address.' },
    }, ['url']),
    tool(
      'browser_snapshot',
      'Read the page',
      "The open page's main content as compact markdown (headings, lists, links, code, tables; no menus, footers or banners), within a token budget. " +
        'Again on the same page, only what changed since your last snapshot. With elements: true, the links, buttons and fields instead, each with an id like e12 to pass as selector to browser_click and browser_type. Use it rather than a screenshot whenever text answers the question.',
      {
        elements: { type: 'boolean', description: 'List the interactive elements (ids for browser_click / browser_type) instead of the content.' },
        budget: { type: 'integer', minimum: SNAPSHOT_LIMITS.minBudget, maximum: SNAPSHOT_LIMITS.maxBudget, description: `Most tokens the answer may take. Default ${SNAPSHOT_LIMITS.budget}.` },
        full: { type: 'boolean', description: 'The whole page even if you saw it before, not just the change.' },
      },
      [],
      true,
    ),
    tool('browser_click', 'Click', 'Clicks an element on the open page, found by CSS selector or by its visible text (give one of the two).' + ASKS + DOWNLOADS, {
      selector: SELECTOR,
      text: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.url, description: 'Visible text of a link, button or label.' },
    }),
    tool('browser_type', 'Type', 'Focuses a field on the open page and types text into it, replacing what it held.' + ASKS, {
      selector: SELECTOR,
      text: { type: 'string', maxLength: BRIDGE_LIMITS.text, description: 'What to type.' },
    }, ['selector', 'text']),
    tool(
      'browser_screenshot',
      'Screenshot',
      "Saves a JPEG of the visible page, or of one element, to a private file in FriedLiver's storage and returns its path and its cost in image tokens; read that file to see it. " +
        'Only for what text can not tell (layout, colors, images): browser_snapshot is far cheaper. Crop to the element you care about with selector.',
      {
        selector: { ...SELECTOR, description: 'Only this element (an id like "e12" from browser_snapshot, or a CSS selector), with a small margin.' },
        max_width: { type: 'integer', minimum: SHOT.minWidth, maximum: SHOT.maxMaxWidth, description: `Widest the image may be, in pixels. Default ${SHOT.maxWidth}.` },
      },
      [],
      true,
    ),
    tool('browser_console', 'Console', 'The open page\'s console messages and uncaught errors since you last asked, repeats collapsed, the newest ~6,000 characters.', {}, [], true),
    tool('browser_back', 'Go back', 'Goes back one page in the browser\'s history.' + ASKS),
    tool('browser_reload', 'Reload', 'Reloads the open page.' + ASKS),
  ];
}

function systemTools() {
  const ASKS = ' The user is asked to allow it first; on Linux it is not supported.';
  const NAME = { type: 'string', minLength: 1, maxLength: SYSTEM_LIMITS.name };
  const WINDOW = { type: 'integer', minimum: 1, maximum: 0x7fffffff, description: 'A window id from system_apps.' };
  // No top-level oneOf (Claude's API refuses it): "exactly one of" is in the words and checked by parseCall.
  const schema = (properties: Record<string, object>, required: string[] = []) => ({
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  });
  return [
    {
      name: 'system_open',
      title: 'Open an app, file or link',
      description:
        'Opens exactly one of: an installed app by its name from system_apps (`app`), an existing document, image, media file or folder by absolute path (`path`; no programs, scripts or private folders), ' +
        'or an http/https link (`url`; in FriedLiver\'s browser or the system browser, as the user chose).' + ASKS,
      inputSchema: schema(
        { app: { ...NAME, description: 'An app name exactly as system_apps lists it, like "Spotify".' }, path: { ...NAME, description: 'An absolute path.' }, url: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.url, description: 'An http:// or https:// URL.' } },
      ),
    },
    {
      name: 'system_apps',
      title: 'List apps and windows',
      description: 'Lists the installed apps (names to pass to system_open) and the running apps with their windows (ids to pass to system_focus and system_screenshot_window).' + ASKS,
      inputSchema: NO_INPUT,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'system_focus',
      title: 'Bring to the front',
      description: 'Brings to the front exactly one of: a running app (`app`, its name from system_apps) or the app of a window (`window`, its id).' + ASKS,
      inputSchema: schema({ app: { ...NAME, description: 'A running app\'s name.' }, window: WINDOW }),
    },
    {
      name: 'system_shortcut',
      title: 'Run an Apple Shortcut',
      description: 'macOS only: runs one of the user\'s Shortcuts by its exact name.' + ASKS,
      inputSchema: schema({ name: { ...NAME, description: 'The Shortcut\'s exact name.' } }, ['name']),
    },
    {
      name: 'system_clipboard_read',
      title: 'Read the clipboard',
      description: `The text on the clipboard (up to ${SYSTEM_LIMITS.clipboard / 1024} KB). Asked for every time.` + ASKS,
      inputSchema: NO_INPUT,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'system_clipboard_write',
      title: 'Copy to the clipboard',
      description: `Puts text on the clipboard, replacing what it held (up to ${SYSTEM_LIMITS.clipboard / 1024} KB).` + ASKS,
      inputSchema: schema({ text: { type: 'string', minLength: 1, description: 'The text.' } }, ['text']),
    },
    {
      name: 'system_notify',
      title: 'Show a notification',
      description: 'Shows a system notification.' + ASKS,
      inputSchema: schema(
        { title: { type: 'string', minLength: 1, maxLength: SYSTEM_LIMITS.title, description: 'A short title.' }, body: { type: 'string', maxLength: SYSTEM_LIMITS.body, description: 'The message.' } },
        ['title', 'body'],
      ),
    },
    {
      name: 'system_volume',
      title: 'Volume',
      description: 'Reads the output volume, sets it (0–100), mutes or unmutes it.' + ASKS,
      inputSchema: schema(
        { action: { type: 'string', enum: ['get', 'set', 'mute', 'unmute'] }, level: { type: 'integer', minimum: 0, maximum: 100, description: 'For "set" only.' } },
        ['action'],
      ),
    },
    {
      name: 'system_screenshot_window',
      title: 'Screenshot a window',
      description: 'Saves a PNG of one window (an id from system_apps) to a private file and returns its path; read that file to see it. Asked for every time.' + ASKS,
      inputSchema: schema({ window: WINDOW }, ['window']),
      annotations: { readOnlyHint: true },
    },
  ];
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: true;
}

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

/** What a line from the client asks for: a reply now, a tool call to make, or nothing (a notification or garbage). */
export type Handled =
  | { reply: object }
  | { call: BridgeCall['tool']; args: Record<string, unknown>; id: string | number; progressToken?: string | number }
  | null;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const result = (id: string | number, value: object) => ({ jsonrpc: '2.0', id, result: value });
const error = (id: string | number, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
export const toolError = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * The browser tools: all a client outside FriedLiver (EXTERNAL_CLIENT, Claude Code through friedliver-browser)
 * is offered. Not the system_* tools: those act on the whole computer, and only FriedLiver's own chats get them.
 */
export const EXTERNAL_TOOLS = TOOLS.filter((t) => t.name.startsWith('browser_'));

/** Tools left out of a session (`omit`, names): system_* this platform lacks or the user turned off, index_* with the index off. */
export const OMIT_ENV = 'FRIEDLIVER_OMIT_TOOLS';

/**
 * The tools a session is not offered, so tools/list (sent with every session, and counted against the
 * agent's context) carries only what can work: the system_* tools this platform doesn't have, all of them
 * when the user turned them off or there is no system host, the ones turned off one by one, and the
 * index_* tools when the project index is off.
 */
export function omittedTools(o: { platform: 'mac' | 'win' | 'other'; system?: { enabled: boolean; tools: Record<SystemTool, boolean> }; index: boolean }): string[] {
  const off = new Set<string>(!o.system?.enabled ? SYSTEM_TOOLS : [...unsupportedOn(o.platform), ...SYSTEM_TOOLS.filter((t) => !o.system!.tools[t])]);
  if (!o.index) for (const t of TOOLS) if (t.name.startsWith('index_')) off.add(t.name);
  return [...off];
}

const listed = new Map<string, (typeof TOOLS)[number][]>();
/** The tools a session is offered: `omit` taken out of TOOLS (or EXTERNAL_TOOLS). The same list object for the same ask. */
export function toolsFor(omit: readonly string[] = [], external = false): (typeof TOOLS)[number][] {
  const base = external ? EXTERNAL_TOOLS : TOOLS;
  if (!omit.length) return base;
  const key = `${external ? 'x' : ''}:${[...omit].sort().join(',')}`;
  let tools = listed.get(key);
  if (!tools) {
    const out = new Set(omit);
    tools = base.filter((t) => !out.has(t.name));
    if (listed.size > 64) listed.clear();
    listed.set(key, tools);
  }
  return tools;
}

/** One JSON-RPC message from the agent; `external` offers and takes EXTERNAL_TOOLS only, `omit` none of those tools. */
export function handle(raw: unknown, external = false, omit: readonly string[] = []): Handled {
  const tools = toolsFor(omit, external);
  if (!isObj(raw)) return null;
  const m = raw as Message;
  // Notifications (initialized, cancelled, progress) need no answer.
  if (!isId(m.id) || typeof m.method !== 'string') return null;
  const id = m.id;
  const params = isObj(m.params) ? m.params : {};
  switch (m.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return {
        reply: result(id, {
          protocolVersion: typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'friedliver', version: '1.0.0' },
          instructions: instructionsFor(tools),
        }),
      };
    }
    case 'ping':
      return { reply: result(id, {}) };
    case 'tools/list':
      return { reply: result(id, { tools }) };
    case 'tools/call': {
      const name = params.name;
      // Claude Code's PermissionRequest hook calls this unlisted tool, so the model never sees it.
      if (external && name === PERMISSION_HOOK_TOOL) {
        const args = params.arguments;
        return isObj(args) && parseCall(name, args) ? { call: name, args, id } : { reply: result(id, toolError('Invalid arguments')) };
      }
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { reply: result(id, toolError(`MCP error -32602: Tool ${String(name)} not found`)) };
      const args = params.arguments === undefined ? {} : params.arguments;
      // The editor checks every call again; this is so the agent hears what is wrong at once.
      if (!isObj(args) || !parseCall(tool.name, args)) {
        return { reply: result(id, toolError(`MCP error -32602: Input validation error: Invalid arguments for tool ${tool.name}; see its input schema.`)) };
      }
      const meta = isObj(params._meta) ? params._meta : {};
      return { call: tool.name as BridgeCall['tool'], args, id, ...(isId(meta.progressToken) ? { progressToken: meta.progressToken } : {}) };
    }
    default:
      return { reply: error(id, -32601, 'Method not found') };
  }
}

/** The answer to a tool call. */
export function toolReply(id: string | number, value: ToolResult): object {
  return result(id, value);
}

/** A progress note for a call still waiting on the editor (or the user). */
export function progress(progressToken: string | number, n: number): object {
  return { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: n, message: 'Waiting for FriedLiver' } };
}
