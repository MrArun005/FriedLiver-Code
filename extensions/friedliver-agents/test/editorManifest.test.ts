import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The editor commands' contributions: what VS Code reads before any code runs.
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributes = manifest.contributes;
const EDITOR_COMMANDS = ['friedliver.editSelection', 'friedliver.askSelection', 'friedliver.addSelectionToChat', 'friedliver.reviewChanges'];

describe('agents in the editor: contributions', () => {
  it('has the commands under FriedLiver, in Title Case', () => {
    const byId = new Map(contributes.commands.map((c: { command: string }) => [c.command, c]));
    expect(EDITOR_COMMANDS.map((id) => (byId.get(id) as { title: string })?.title)).toEqual(['Edit with Agent', 'Ask About Selection', 'Add Selection to Chat', 'Review My Changes']);
    for (const id of EDITOR_COMMANDS) expect((byId.get(id) as { category: string }).category).toBe('FriedLiver');
  });

  it('binds Ctrl/Cmd+I in a text editor only while no other inline chat claims it', () => {
    const binding = contributes.keybindings.find((k: { command: string }) => k.command === 'friedliver.editSelection');
    expect(binding).toMatchObject({ key: 'ctrl+i', mac: 'cmd+i' });
    expect(binding.when).toContain('editorTextFocus');
    expect(binding.when).toContain('!inlineChatHasProvider');
    expect(binding.when).toContain('!inlineChatHasEditsAgent');
  });

  it('puts the selection commands in the editor menu and the review in Source Control', () => {
    expect(contributes.menus['editor/context'].map((m: { command: string }) => m.command)).toEqual(EDITOR_COMMANDS.slice(0, 3));
    expect(contributes.menus['scm/title']).toEqual([expect.objectContaining({ command: 'friedliver.reviewChanges', when: 'scmProvider == git' })]);
    const own = new Set(contributes.commands.map((c: { command: string }) => c.command));
    for (const items of Object.values(contributes.menus) as { command: string }[][]) for (const m of items) expect(own.has(m.command), m.command).toBe(true);
  });

  it('lets only the user, not a repository, choose which agent gets their code', () => {
    expect(contributes.configuration.properties['friedliver.edit.defaultAgent']).toMatchObject({ scope: 'machine', default: 'claude', enum: ['claude', 'codex', 'gemini', 'demo'] });
  });

  it('names no AI models', () => {
    const files = ['package.json', 'src/host/editor.ts', 'src/host/editorPrompt.ts', 'src/host/gitChanges.ts', 'src/host/editFlow.ts', '../../agent-core/demo/editorRequests.mjs', '../../docs/EDITOR.md'];
    for (const f of files) {
      expect(readFileSync(path.join(root, f), 'utf8'), f).not.toMatch(/\b(opus|sonnet|haiku|gpt-\d|gemini-\d|o\d-mini|claude-\d)/i);
    }
  });
});
