import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { newFileFromPatch, writePatchedFile } from './patchedFile';

// The companion's rules (patch 0310): what an item from the Agents extension may hold, and the queue.
const PATCH = '0310-companion.patch';
type Item = { id: string; choices: { id: string; label: string; kind: string }[]; character: string; characterRun?: string; detail?: string };
let m: {
  parseCompanionItem(raw: unknown): Item | undefined;
  CompanionQueue: new () => { current: Item | undefined; more: number; show(i: Item): boolean; hide(id: string): boolean; later(): void; offers(id: string, choice: string): boolean; waiting(limit: number): Item[]; front(id: string): boolean };
  lineupSize(raw: unknown): number;
  MAX_LINEUP: number;
};

beforeAll(async () => {
  m = await import(writePatchedFile(PATCH, 'src/vs/workbench/contrib/friedliverCompanion/common/companion.ts'));
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const raw = (over: Record<string, unknown> = {}) => ({
  id: 'r1', chatId: 'c1', agentLabel: 'Claude', chatTitle: 'Fix tests', question: 'Run npm test',
  choices: [{ id: 'allow', label: 'Allow once', kind: 'primary' }, { id: 'deny', label: 'Deny', kind: 'secondary' }],
  character: PNG, ...over,
});

describe('companion items', () => {
  it('takes a well-formed item', () => {
    expect(m.parseCompanionItem(raw({ detail: 'npm test', characterRun: 'data:image/gif;base64,R0lGOD==' }))).toMatchObject({ id: 'r1', detail: 'npm test', characterRun: 'data:image/gif;base64,R0lGOD==' });
    expect(m.parseCompanionItem(raw({ character: '' }))?.character).toBe('');
  });

  it('loads pictures only inline: no files, addresses or other types', () => {
    for (const character of ['file:///etc/passwd', 'https://x.test/a.png', 'vscode-file://vscode-app/a.svg', 'data:text/html;base64,PGI+', 'data:image/svg+xml,<svg onload=x>', 'javascript:alert(1)']) {
      expect(m.parseCompanionItem(raw({ character })), character).toBeUndefined();
    }
    expect(m.parseCompanionItem(raw({ characterRun: 'https://x.test/run.gif' }))?.characterRun).toBeUndefined();
  });

  it('refuses anything malformed', () => {
    expect(m.parseCompanionItem(null)).toBeUndefined();
    expect(m.parseCompanionItem(raw({ id: '' }))).toBeUndefined();
    expect(m.parseCompanionItem(raw({ question: 7 }))).toBeUndefined();
    expect(m.parseCompanionItem(raw({ choices: [{ id: 'a', label: 'A', kind: 'evil' }] }))).toBeUndefined();
    expect(m.parseCompanionItem(raw({ choices: [{ id: 'a', label: 'A', kind: 'primary' }, { id: 'a', label: 'B', kind: 'secondary' }] }))).toBeUndefined();
    expect(m.parseCompanionItem(raw({ detail: 42 }))).toBeUndefined();
  });
});

describe('the companion queue', () => {
  const item = (id: string) => m.parseCompanionItem(raw({ id }))!;

  it('shows one, counts the rest, and moves on when it is answered or put off', () => {
    const q = new m.CompanionQueue();
    expect(q.current).toBeUndefined();
    q.show(item('a'));
    q.show(item('b'));
    q.show(item('c'));
    expect([q.current?.id, q.more]).toEqual(['a', 2]);
    expect(q.show(item('a'))).toBe(false);
    expect(q.hide('b')).toBe(false);
    expect([q.current?.id, q.more]).toEqual(['a', 1]);
    expect(q.hide('a')).toBe(true);
    expect(q.current?.id).toBe('c');
    q.later();
    expect(q.current).toBeUndefined();
    expect(q.show(item('c'))).toBe(false); // put off: not shown again until answered
  });

  it('a click counts only for the item on screen and a choice it offers', () => {
    const q = new m.CompanionQueue();
    q.show(item('a'));
    q.show(item('b'));
    expect(q.offers('a', 'allow')).toBe(true);
    expect(q.offers('b', 'allow')).toBe(false);
    expect(q.offers('a', 'always')).toBe(false);
    q.hide('a');
    expect(q.offers('a', 'allow')).toBe(false);
  });

  it('the line is the next ones in arrival order, never the one shown, at most the limit', () => {
    const q = new m.CompanionQueue();
    for (const id of ['a', 'b', 'c', 'd']) q.show(item(id));
    expect(q.waiting(7).map((i) => i.id)).toEqual(['b', 'c', 'd']);
    expect(q.waiting(2).map((i) => i.id)).toEqual(['b', 'c']);
    expect(q.waiting(0)).toEqual([]);
    expect(q.waiting(-3)).toEqual([]);
    q.hide('a');
    expect(q.waiting(7).map((i) => i.id)).toEqual(['c', 'd']);
  });

  it('bringing one forward puts it on screen and the one shown right behind it; clicks then count for it', () => {
    const q = new m.CompanionQueue();
    for (const id of ['a', 'b', 'c']) q.show(item(id));
    expect(q.front('c')).toBe(true);
    expect([q.current?.id, ...q.waiting(7).map((i) => i.id)]).toEqual(['c', 'a', 'b']);
    expect(q.offers('c', 'allow')).toBe(true);
    expect(q.offers('a', 'allow')).toBe(false);
    expect(q.front('c')).toBe(false); // already in front
    expect(q.front('zz')).toBe(false); // unknown
    q.later();
    expect(q.front('c')).toBe(false); // put off: gone from the line too
  });

  it('the lineup setting is a whole number from 0 to the most, anything else none', () => {
    expect(m.MAX_LINEUP).toBe(7);
    expect([0, 3, 7, 12, -1].map(m.lineupSize)).toEqual([0, 3, 7, 7, 0]);
    for (const bad of [2.5, '5', null, undefined, NaN, {}]) expect(m.lineupSize(bad), String(bad)).toBe(0);
  });
});

describe('patch 0310', () => {
  const patch = fs.readFileSync(path.resolve(__dirname, '..', 'patches', PATCH), 'utf8');
  it('registers the contribution in the desktop workbench and answers only through the Agents extension', () => {
    expect(patch).toContain("+import './contrib/friedliverCompanion/browser/companion.contribution.js';");
    expect(patch).toContain("'friedliver.agents.companionAnswer', id, choiceId");
    expect(patch).toContain('!this._queue.offers(id, choiceId)');
    expect(patch).not.toContain('innerHTML');
    // Focus moves only on the Focus command, never when an ask arrives (a keystroke must not answer it).
    const enter = patch.slice(patch.indexOf('private _enter('), patch.indexOf('private _leave('));
    expect(enter.length).toBeGreaterThan(100);
    expect(enter).not.toContain('.focus(');
  });
});

describe('how a character sits (frameVerdict, chromaKey)', () => {
  type V = { kind: string; color?: number[] };
  let c: {
    frameVerdict(frames: { data: Uint8ClampedArray; width: number; height: number }[]): V;
    chromaKey(data: Uint8ClampedArray, color: readonly [number, number, number]): void;
    characterSources(item: unknown, phase: 'run' | 'idle', playable: (v: { key: string }) => boolean): unknown[];
    parseCompanionVideo(raw: unknown): unknown;
    MAX_VIDEO_BYTES: number;
  };
  beforeAll(async () => {
    c = await import(writePatchedFile(PATCH, 'src/vs/workbench/contrib/friedliverCompanion/common/companion.ts'));
  });
  const SIZE = 12;
  /** A frame whose border (2 px) is `edge` and whose middle is `centre`, both RGBA; `noise` jitters the border. */
  const frame = (edge: number[], centre: number[], noise = 0, seed = 1) => {
    const data = new Uint8ClampedArray(SIZE * SIZE * 4);
    let r = seed;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const border = x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2;
        const px = border ? edge.map((v, i) => (i < 3 && noise ? v + (((r = (r * 9301 + 49297) % 233280) / 233280) * 2 - 1) * noise : v)) : centre;
        data.set(px, (y * SIZE + x) * 4);
      }
    }
    return { data, width: SIZE, height: SIZE };
  };

  it('transparent edges float as they are (VP9-alpha webm, cut-out GIF/WebP)', () => {
    expect(c.frameVerdict([frame([0, 0, 0, 0], [200, 50, 50, 255])])).toEqual({ kind: 'alpha' });
  });

  it('a flat-coloured border is keyed out, across the first few frames', () => {
    const v = c.frameVerdict([frame([0, 177, 64, 255], [200, 50, 50, 255], 8, 1), frame([0, 177, 64, 255], [190, 60, 40, 255], 8, 2)]);
    expect(v.kind).toBe('key');
    v.color!.forEach((x, i) => expect(Math.abs(x - [0, 177, 64][i])).toBeLessThan(10));
  });

  it('a busy border sits in the frame; so does a border that drifts between frames, and nothing at all', () => {
    expect(c.frameVerdict([frame([120, 120, 120, 255], [0, 0, 0, 255], 120)])).toEqual({ kind: 'frame' });
    expect(c.frameVerdict([frame([0, 177, 64, 255], [0, 0, 0, 255]), frame([200, 30, 30, 255], [0, 0, 0, 255])])).toEqual({ kind: 'frame' });
    expect(c.frameVerdict([])).toEqual({ kind: 'frame' });
  });

  it('chromaKey clears the key colour, keeps the subject, softens the edge and pulls back spill there', () => {
    const px = new Uint8ClampedArray([0, 177, 64, 255, 200, 50, 50, 255, 60, 200, 110, 255]);
    c.chromaKey(px, [0, 177, 64]);
    expect(px[3]).toBe(0); // the screen
    expect(Array.from(px.slice(4, 8))).toEqual([200, 50, 50, 255]); // the subject, untouched
    expect(px[11]).toBeGreaterThan(0); // a fringe pixel: partly see-through
    expect(px[11]).toBeLessThan(255);
    expect(px[9]).toBeLessThanOrEqual(Math.max(px[8], px[10])); // its green pulled back
  });

  it('video sources: run video, then the corner video, then the pictures; failed videos passed over', () => {
    const item = { character: 'data:image/svg+xml;base64,AA==', characterRun: 'data:image/svg+xml;base64,BB==', video: { key: 'v' }, videoRun: { key: 'r' } };
    expect(c.characterSources(item, 'run', () => true)).toEqual([{ video: { key: 'r' } }, { video: { key: 'v' } }, { image: item.characterRun }, { image: item.character }]);
    expect(c.characterSources(item, 'idle', (v) => v.key !== 'v')).toEqual([{ image: item.character }]);
  });

  it('video refs: allowed types only, bytes up to 20 MB, as a Uint8Array or a VSBuffer', () => {
    expect(c.parseCompanionVideo({ key: 'k', type: 'video/webm' })).toEqual({ key: 'k', type: 'video/webm' });
    expect(c.parseCompanionVideo({ key: 'k', type: 'video/mp4', bytes: { buffer: new Uint8Array(3) } })).toMatchObject({ bytes: new Uint8Array(3) });
    expect(c.parseCompanionVideo({ key: 'k', type: 'text/html' })).toBeNull();
    expect(c.parseCompanionVideo({ key: 'k', type: 'video/webm', bytes: new Uint8Array(c.MAX_VIDEO_BYTES + 1) })).toBeNull();
    expect(c.parseCompanionVideo(undefined)).toBeUndefined();
  });

  it('lets the workbench play blob: media and nothing wider', () => {
    const patch = fs.readFileSync(path.resolve(__dirname, '..', 'patches', PATCH), 'utf8');
    expect(patch).toContain("+\t\t\t\t\tblob:\n \t\t\t\t;\n \t\t\t\tframe-src");
    expect(patch).not.toMatch(/^\+.*media-src.*\*/m);
  });
});

describe('where the companion stands (workbench/friedliver.css + patch 0310)', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'workbench', 'friedliver.css'), 'utf8').replace(/\r\n/g, '\n');
  const patch = fs.readFileSync(path.resolve(__dirname, '..', 'patches', PATCH), 'utf8');
  const keyframes = (name: string) => css.slice(css.indexOf(`@keyframes ${name} {`), css.indexOf('\n}\n', css.indexOf(`@keyframes ${name} {`)));

  it('runs in from the right edge to the middle, whole (not cut off), and runs off to the left', () => {
    expect(css).toMatch(/\.fl-companion__character \{[^}]*left: 50%;[^}]*transform: translateX\(-50%\);/);
    expect(keyframes('fl-companion-run')).toMatch(/from \{\s*left: 100%;[\s\S]*to \{\s*left: 50%;\s*transform: translateX\(-50%\);/);
    expect(keyframes('fl-companion-run-off')).toMatch(/to \{\s*left: 0;\s*transform: translateX\(-100%\);/);
    expect(css).not.toContain('translate(-30%, 30%)');
  });

  it('pops the card at 0.92 to 1 and fades; the iPhone-sized width is kept inside the window', () => {
    expect(keyframes('fl-companion-pop')).toMatch(/scale\(0\.92\)[\s\S]*scale\(1\)/);
    expect(css).toContain('width: min(calc(var(--fl-w-menu) + var(--fl-sp-2) + var(--fl-sp-half)), calc(100% - 2 * var(--fl-sp-4)));');
    expect(css).toContain('max-height: 60vh;');
  });

  it("places the card at the character's top-right, flips to its top-left, and clamps 16 px inside", () => {
    expect(patch).toContain('+const CARD_MARGIN = 16;');
    expect(patch).toContain('+		let left = c.right - box.left + CARD_GAP;');
    expect(patch).toContain('+			left = c.left - box.left - CARD_GAP - w;');
    expect(patch).toContain("+		root.style.bottom = `${this._layout.mainContainer.querySelector<HTMLElement>('.part.statusbar')?.offsetHeight ?? 0}px`;");
  });
});

describe('patch 0310 wires itself up', () => {
  const contribution = newFileFromPatch(PATCH, 'src/vs/workbench/contrib/friedliverCompanion/browser/companion.contribution.ts');

  it('registers both commands the Agents extension calls, and declares what they and the class use', () => {
    expect(contribution).toContain("CommandsRegistry.registerCommand('_friedliver.companion.show',");
    expect(contribution).toContain("CommandsRegistry.registerCommand('_friedliver.companion.hide',");
    expect(contribution).toMatch(/^let instance: CompanionContribution \| undefined;$/m);
    expect(contribution).toMatch(/^const early: /m);
    expect(contribution).toMatch(/^const COMPANION_VISIBLE = new RawContextKey<boolean>\('friedliverCompanionVisible'/m);
  });

  it('every module-level name the file uses is declared or imported', () => {
    const code = contribution.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
    const imported = new Set([...code.matchAll(/^import \{([^}]+)\} from/gm)].flatMap((m) => m[1].split(',').map((x) => x.trim())));
    const declared = new Set([...code.matchAll(/^(?:const|let|class|function) (\w+)|static readonly (\w+)/gm)].map((m) => m[1] ?? m[2]));
    // Bare (not a property) capitalised names, and the module-level state the commands share.
    const used = new Set([...code.matchAll(/(?<![.\w$])([A-Z]\w*|instance|early|verdicts|sampleFrame)\b/g)].map((m) => m[1]));
    const dom = ['Map', 'Set', 'HTMLElement', 'HTMLImageElement', 'HTMLVideoElement', 'HTMLCanvasElement', 'HTMLButtonElement', 'KeyboardEvent', 'AnimationEvent', 'Event', 'URL', 'Blob', 'Date', 'Math', 'Infinity', 'ArrayBuffer'];
    expect([...used].filter((n) => !imported.has(n) && !declared.has(n) && !dom.includes(n))).toEqual([]);
  });

  it('Escape puts a card off through a real keybinding, behind the editor and quick input', () => {
    expect(contribution).toContain("id: 'friedliver.companion.later'");
    expect(contribution).toContain('primary: KeyCode.Escape');
    expect(contribution).toContain('weight: KeybindingWeight.WorkbenchContrib');
    for (const key of ['suggestWidgetVisible', 'findWidgetVisible', 'inQuickOpen', 'editorHasSelection', 'notificationCenterVisible']) {
      expect(contribution).toContain(`ContextKeyExpr.not('${key}')`);
    }
  });
});

describe('the companion stacks above notification toasts', () => {
  it('sits between upstream toasts (2545) and the quick input (2550)', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '..', 'workbench', 'friedliver.css'), 'utf8');
    const rule = css.slice(css.indexOf('.monaco-workbench:not(.hc-black):not(.hc-light) .fl-companion {'));
    const z = Number(/z-index: (\d+);/.exec(rule.slice(0, rule.indexOf('}')))?.[1]);
    expect(z).toBeGreaterThan(2545);
    expect(z).toBeLessThan(2550);
  });

  it('keeps the card clear of the head and runs off in its run pose', () => {
    const contribution = newFileFromPatch(PATCH, 'src/vs/workbench/contrib/friedliverCompanion/browser/companion.contribution.ts');
    expect(contribution).toContain('card.style.maxHeight = `${Math.max(0, Math.floor(c.top - box.top - CARD_GAP - CARD_MARGIN))}px`;');
    expect(contribution).toMatch(/const CARD_GAP = (\d+);/);
    expect(Number(/const CARD_GAP = (\d+);/.exec(contribution)![1])).toBeGreaterThanOrEqual(8);
    const leave = contribution.slice(contribution.indexOf('private _leave('), contribution.indexOf('private _count('));
    expect(leave).toContain("this._character?.show('run');");
  });
});
