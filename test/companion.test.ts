import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { writePatchedFile } from './patchedFile';

// The companion's rules (patch 0310): what an item from the Agents extension may hold, and the queue.
const PATCH = '0310-companion.patch';
type Item = { id: string; choices: { id: string; label: string; kind: string }[]; character: string; characterRun?: string; detail?: string };
let m: {
  parseCompanionItem(raw: unknown): Item | undefined;
  CompanionQueue: new () => { current: Item | undefined; more: number; show(i: Item): boolean; hide(id: string): boolean; later(): void; offers(id: string, choice: string): boolean };
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
