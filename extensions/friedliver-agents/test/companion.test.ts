// The companion: shows each request that starts waiting, hides it once answered anywhere, and a click
// answers exactly the request it showed through the chat card's own message; stale ids do nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Companion, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, characterFor, expandHome, imageData, videoRef, type CompanionItem } from '../src/host/companion';
import type { WebviewMessage } from '../src/shared/messages';
import { EMPTY_STATE, type AppState, type ChatView, type Item } from '../src/shared/model';

const chat = (id: string, over: Partial<ChatView> = {}): ChatView => ({
  id,
  agent: 'claude',
  label: 'Claude',
  title: `Topic ${id}`,
  cwd: '/w',
  createdAt: 0,
  busy: true,
  changedFiles: 0,
  items: [],
  depth: 0,
  files: [],
  lastActivity: 0,
  turns: 0,
  ...over,
});
const OPTIONS = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'always', name: "Yes, and don't ask again", kind: 'allow_always' },
  { optionId: 'no', name: 'No', kind: 'reject_once' },
];
const run = (requestId: string, line: string, at = 1): Item => ({ kind: 'permission', requestId, title: line, toolKind: 'execute', options: OPTIONS, detail: { command: { line } }, at });
const state = (...chats: ChatView[]): AppState => ({ ...EMPTY_STATE, chats });

function setup(opts: { enabled?: boolean; character?: (a: string) => { character: string } | undefined } = {}) {
  const calls: { command: string; arg: unknown }[] = [];
  const answers: WebviewMessage[] = [];
  let current: AppState = EMPTY_STATE;
  const c = new Companion({
    run: (command, arg) => calls.push({ command, arg }),
    answer: (m) => answers.push(m),
    enabled: () => opts.enabled ?? true,
    state: () => current,
    character: opts.character ?? (() => ({ character: 'data:image/svg+xml;base64,AA==' })),
  });
  const set = (s: AppState) => {
    current = s;
    c.update(s);
  };
  const shown = () => calls.filter((x) => x.command === '_friedliver.companion.show').map((x) => x.arg as CompanionItem);
  const hidden = () => calls.filter((x) => x.command === '_friedliver.companion.hide').map((x) => x.arg);
  return { c, set, calls, answers, shown, hidden };
}

describe('the companion', () => {
  it('shows a request once when it starts waiting, with Allow once and Deny', () => {
    const t = setup();
    const s = state(chat('a', { items: [run('r1', 'npm test')] }));
    t.set(s);
    t.set(s);
    expect(t.shown()).toHaveLength(1);
    const item = t.shown()[0];
    expect(item).toMatchObject({ id: 'r1', chatId: 'a', agentLabel: 'Claude', chatTitle: 'Topic a', character: 'data:image/svg+xml;base64,AA==' });
    expect(item.detail).toContain('npm test');
    expect(item.choices).toEqual([
      { id: 'allow', label: 'Allow once', kind: 'primary' },
      { id: 'deny', label: 'Deny', kind: 'secondary' },
    ]);
  });

  it('hides it once answered elsewhere (in the chat)', () => {
    const t = setup();
    t.set(state(chat('a', { items: [run('r1', 'npm test')] })));
    t.set(state(chat('a', { items: [{ ...run('r1', 'npm test'), answer: 'Yes' } as Item] })));
    expect(t.hidden()).toEqual(['r1']);
  });

  it('a click answers exactly the request it showed, through the card message, once', () => {
    const t = setup();
    t.set(state(chat('a', { items: [run('r1', 'npm test'), run('r2', 'npm run lint', 2)] })));
    expect(t.c.answer('r2', 'allow')).toBe(true);
    expect(t.answers).toEqual([{ type: 'permission', requestId: 'r2', optionId: 'yes' }]);
    expect(t.hidden()).toEqual(['r2']);
    expect(t.c.answer('r2', 'allow')).toBe(false);
    expect(t.c.answer('r1', 'deny')).toBe(true);
    expect(t.answers[1]).toEqual({ type: 'permission', requestId: 'r1', optionId: 'no' });
  });

  it('never sends a remembered scope, and ignores stale ids, unknown choices and junk', () => {
    const t = setup();
    t.set(state(chat('a', { items: [run('r1', 'npm test')] })));
    expect(t.c.answer('r1', 'always')).toBe(false);
    expect(t.c.answer('nope', 'allow')).toBe(false);
    expect(t.c.answer(42, 'allow')).toBe(false);
    expect(t.c.answer('r1', { id: 'allow' })).toBe(false);
    expect(t.answers).toEqual([]);
  });

  it('ignores a click on a request answered in the chat a moment ago, before its hide arrived', () => {
    const answers: WebviewMessage[] = [];
    const s = state(chat('a', { items: [run('r1', 'npm test')] }));
    let now: AppState = s;
    const c = new Companion({ run: () => {}, answer: (m) => answers.push(m), enabled: () => true, state: () => now, character: () => ({ character: '' }) });
    c.update(s);
    now = state(chat('a', { items: [{ ...run('r1', 'npm test'), answer: 'Yes' } as Item] }));
    expect(c.answer('r1', 'allow')).toBe(false);
    expect(answers).toEqual([]);
  });

  it('offers no allow for careful requests or plans: those are allowed in the chat', () => {
    const t = setup();
    const plan: Item = { kind: 'permission', requestId: 'p', title: 'Ready to code?', toolKind: 'switch_mode', options: OPTIONS, detail: { plan: 'Do it' }, at: 1 };
    t.set(state(chat('a', { items: [plan, run('force', 'git push --force', 2)] })));
    for (const item of t.shown()) expect(item.choices.map((x) => x.id)).not.toContain('allow');
    expect(t.c.answer('p', 'allow')).toBe(false);
    expect(t.c.answer('force', 'allow')).toBe(false);
  });

  it('a question offers its options and Skip', () => {
    const t = setup();
    const q: Item = { kind: 'question', requestId: 'q', message: 'Which store?', state: 'awaiting', at: 1, fields: [{ key: 'store', title: 'Store', type: 'choice', options: [{ value: 'json', title: 'JSON' }, { value: 'sqlite', title: 'SQLite (Recommended)' }] }] };
    t.set(state(chat('a', { items: [q] })));
    const item = t.shown()[0];
    expect(item.question).toBe('Which store?');
    expect(item.choices.map((x) => x.kind)).toEqual(['primary', 'secondary', 'secondary']);
    expect(t.c.answer('q', 'option0')).toBe(true);
    expect(t.answers[0]).toEqual({ type: 'answerQuestion', requestId: 'q', action: 'accept', values: { store: 'sqlite' } });
  });

  it('shows nothing when turned off, and hides what it showed', () => {
    let on = true;
    const calls: string[] = [];
    const c = new Companion({ run: (cmd) => calls.push(cmd), answer: () => {}, enabled: () => on, state: () => EMPTY_STATE, character: () => ({ character: '' }) });
    const s = state(chat('a', { items: [run('r1', 'ls')] }));
    c.update(s);
    on = false;
    c.update(s);
    expect(calls).toEqual(['_friedliver.companion.show', '_friedliver.companion.hide']);
    expect(setupOff()).toEqual([]);
    function setupOff() {
      const t = setup({ enabled: false });
      t.set(s);
      return t.calls;
    }
  });

  it('skips an agent with no character', () => {
    const t = setup({ character: () => undefined });
    t.set(state(chat('a', { items: [run('r1', 'ls')] })));
    expect(t.calls).toEqual([]);
    expect(t.c.answer('r1', 'allow')).toBe(false);
  });
});

describe('card words', () => {
  const first = (items: Item[]) => {
    const t = setup();
    t.set(state(chat('a', { items })));
    return t.shown()[0];
  };

  it('a command asks "Run a command?" and shows the whole command line in the detail', () => {
    const line = "ELECTRON_RUN_AS_NODE=1 '/Applications/FriedLiver.app/Contents/Frameworks/FriedLiver Helper.app/Contents/MacOS/FriedLiver Helper' --version";
    const item = first([run('r1', line)]);
    expect(item.question).toBe('Run a command?');
    expect(item.detail?.split('\n')[0]).toBe(line);
    const cmd: Item = { kind: 'command', commandId: 'c1', commandLine: line, cwd: '/w', outside: false, state: 'awaiting', output: '', at: 1 };
    expect(first([cmd])).toMatchObject({ question: 'Run a command?' });
    expect(first([cmd]).detail).toContain(line);
  });

  it('edits and reads say how many files, with every path in the detail', () => {
    const edit: Item = { kind: 'permission', requestId: 'e', title: 'Edit', toolKind: 'edit', options: OPTIONS, detail: { files: [{ path: '/w/a.ts' }, { path: '/w/b.ts' }, { path: '/w/c.ts' }] }, at: 1 } as Item;
    expect(first([edit])).toMatchObject({ question: 'Edit 3 files?', detail: '/w/a.ts\n/w/b.ts\n/w/c.ts' });
    const read: Item = { kind: 'permission', requestId: 'r', title: 'Read /Users/me/secrets/.env', toolKind: 'read', options: OPTIONS, detail: { locations: ['/Users/me/secrets/.env'] }, at: 1 } as Item;
    expect(first([read])).toMatchObject({ question: 'Read a file?', detail: '~/secrets/.env' });
    const review: Item = { kind: 'review', reviewId: 'v', path: '/w/x.ts', added: 1, removed: 0, isNew: false, state: 'pending', at: 1 };
    expect(first([review])).toMatchObject({ question: 'Accept this edit?', detail: '/w/x.ts\n+1 −0' });
  });

  it('turning the setting back on shows what waits; a new look runs in again', () => {
    let on = false;
    const calls: string[] = [];
    const s = state(chat('a', { items: [run('r1', 'ls')] }));
    const c = new Companion({ run: (cmd) => calls.push(cmd), answer: () => {}, enabled: () => on, state: () => s, character: () => ({ character: '' }) });
    c.update(s);
    expect(calls).toEqual([]);
    on = true;
    c.update(s);
    c.clear();
    c.update(s);
    expect(calls).toEqual(['_friedliver.companion.show', '_friedliver.companion.hide', '_friedliver.companion.show']);
  });
});

describe('characters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-companion-'));
  const builtinDir = path.join(dir, 'builtin');
  const mine = path.join(dir, 'mine');
  fs.mkdirSync(builtinDir);
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(builtinDir, 'jas.svg'), '<svg/>');
  fs.writeFileSync(path.join(builtinDir, 'jas-run.svg'), '<svg>run</svg>');
  fs.writeFileSync(path.join(mine, 'cat.png'), 'png');
  fs.writeFileSync(path.join(mine, 'claude.webp'), 'webp');
  fs.writeFileSync(path.join(mine, 'notes.txt'), 'text');
  const svg = (s: string) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;

  it('built-in defaults by agent, with the run cycle when there is one; custom agents get skip', () => {
    expect(characterFor('claude', { builtinDir, characters: undefined, folder: undefined })).toEqual({ character: svg('<svg/>'), characterRun: svg('<svg>run</svg>') });
    expect(characterFor('codex', { builtinDir, characters: undefined, folder: undefined })).toEqual({ character: '' });
    fs.writeFileSync(path.join(builtinDir, 'skip.svg'), '<svg>skip</svg>');
    expect(characterFor('my-agent', { builtinDir, characters: undefined, folder: undefined })).toEqual({ character: svg('<svg>skip</svg>') });
    expect(characterFor('constructor', { builtinDir, characters: undefined, folder: undefined })).toEqual({ character: svg('<svg>skip</svg>') });
  });

  it('own pictures by path or { idle, run }; anything that fails falls back to the built-in', () => {
    const o = (characters: Record<string, unknown>) => ({ builtinDir, folder: undefined, characters: characters as never });
    expect(characterFor('claude', o({ claude: path.join(mine, 'cat.png') }))?.character).toMatch(/^data:image\/png;base64,/);
    expect(characterFor('claude', o({ claude: { idle: path.join(mine, 'cat.png'), run: path.join(mine, 'claude.webp') } }))?.characterRun).toMatch(/^data:image\/webp;/);
    expect(characterFor('claude', o({ claude: path.join(mine, 'notes.txt') }))?.character).toBe(svg('<svg/>'));
    expect(characterFor('claude', o({ claude: 'https://evil.test/x.png' }))?.character).toBe(svg('<svg/>'));
    expect(characterFor('claude', o({ claude: '../../etc/x' }))?.character).toBe(svg('<svg/>'));
    expect(characterFor('my-agent', o({ 'my-agent': path.join(mine, 'cat.png') }))?.character).toMatch(/^data:image\/png;/);
  });

  it('the folder comes first', () => {
    expect(characterFor('claude', { builtinDir, characters: undefined, folder: mine })?.character).toMatch(/^data:image\/webp;/);
    expect(characterFor('claude', { builtinDir, characters: undefined, folder: 'relative/dir' })?.character).toBe(svg('<svg/>'));
  });

  it('loads only local image files of at most 5 MB', () => {
    const big = path.join(mine, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(imageData(big)).toBeUndefined();
    expect(imageData(path.join(mine, 'missing.png'))).toBeUndefined();
    expect(imageData('cat.png')).toBeUndefined();
    expect(imageData(mine + '/')).toBeUndefined();
  });
});

describe('video characters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-companion-video-'));
  const builtinDir = path.join(dir, 'builtin');
  fs.mkdirSync(builtinDir);
  fs.writeFileSync(path.join(builtinDir, 'bolt.svg'), '<svg>bolt</svg>');
  fs.writeFileSync(path.join(builtinDir, 'bolt-run.svg'), '<svg>bolt run</svg>');
  const clip = (name: string, bytes = 64) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, Buffer.alloc(bytes, 1));
    return f;
  };
  const svg = (s: string) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;

  it('takes .webm, .mp4, .m4v and .mov only, up to 20 MB', () => {
    expect(videoRef(clip('a.webm'))?.type).toBe('video/webm');
    expect(videoRef(clip('a.mp4'))?.type).toBe('video/mp4');
    expect(videoRef(clip('a.m4v'))?.type).toBe('video/mp4');
    expect(videoRef(clip('a.MOV'))?.type).toBe('video/quicktime');
    for (const name of ['a.avi', 'a.mkv', 'a.html', 'a.exe']) expect(videoRef(clip(name)), name).toBeUndefined();
    expect(videoRef(clip('big.webm', MAX_VIDEO_BYTES + 1))).toBeUndefined();
    expect(videoRef(clip('ok.webm', MAX_IMAGE_BYTES + 1))).toBeDefined(); // videos get 20 MB, pictures 5
    expect(imageData(clip('big.png', MAX_IMAGE_BYTES + 1))).toBeUndefined();
    expect(videoRef('relative.webm')).toBeUndefined();
  });

  it('a changed file is a new key', () => {
    const f = clip('k.webm');
    const before = videoRef(f)!.key;
    fs.writeFileSync(f, Buffer.alloc(99, 2));
    expect(videoRef(f)!.key).not.toBe(before);
  });

  it('a video keeps the built-in pictures as its fallback; one video both runs in and stays', () => {
    const f = clip('codex.webm');
    const look = characterFor('codex', { builtinDir, folder: undefined, characters: { codex: f } })!;
    expect(look).toMatchObject({ character: svg('<svg>bolt</svg>'), characterRun: svg('<svg>bolt run</svg>'), video: { path: f, type: 'video/webm' } });
    expect(look.videoRun).toBeUndefined();
    const folder = characterFor('codex', { builtinDir, folder: dir, characters: undefined })!;
    expect(folder.video?.path).toBe(f);
  });

  it('a video that failed (as the file is now) is passed over for the built-in', () => {
    const f = clip('fail.mp4');
    const key = videoRef(f)!.key;
    const look = characterFor('codex', { builtinDir, folder: undefined, characters: { codex: f }, failed: (k) => k === key })!;
    expect(look).toEqual({ character: svg('<svg>bolt</svg>'), characterRun: svg('<svg>bolt run</svg>') });
  });

  it('sends the bytes once, remembers a failure once per file, and ignores unknown keys', () => {
    const f = clip('codex2.webm', 128);
    const shows: CompanionItem[] = [];
    const failures: string[] = [];
    const c = new Companion({
      run: (command, arg) => command === '_friedliver.companion.show' && shows.push(arg as CompanionItem),
      answer: () => {},
      enabled: () => true,
      state: () => EMPTY_STATE,
      character: (agent, failed) => characterFor(agent, { builtinDir, folder: undefined, characters: { claude: f }, failed }),
      videoFailed: (file) => failures.push(file),
    });
    c.update(state(chat('a', { items: [run('r1', 'ls')] })));
    c.update(state(chat('a', { items: [run('r1', 'ls'), run('r2', 'ls', 2)] })));
    expect(shows[0].video?.bytes?.byteLength).toBe(128);
    expect(shows[1].video).toEqual({ key: shows[0].video!.key, type: 'video/webm' });
    expect(c.videoFailed('not-a-key')).toBe(false);
    expect(c.videoFailed(shows[0].video!.key)).toBe(true);
    expect(c.videoFailed(shows[0].video!.key)).toBe(false);
    expect(failures).toEqual([f]);
    c.update(state(chat('a', { items: [run('r1', 'ls'), run('r2', 'ls', 2), run('r3', 'ls', 3)] })));
    expect(shows[2].video).toBeUndefined();
  });

  it('~ is the home folder', () => {
    expect(expandHome('~/FriedLiverCharacters/codex.webm')).toBe(path.join(os.homedir(), 'FriedLiverCharacters/codex.webm'));
    expect(expandHome('/abs/x.webm')).toBe('/abs/x.webm');
  });
});
