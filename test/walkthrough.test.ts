import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The first-run walkthrough contributed by extensions/friedliver-agents.
const EXT = path.join(__dirname, '..', 'extensions', 'friedliver-agents');

interface Step {
  id: string;
  title: string;
  description: string;
  media: { svg?: string; markdown?: string; image?: string; altText?: string };
  completionEvents?: string[];
}
const manifest = JSON.parse(readFileSync(path.join(EXT, 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string }[]; walkthroughs: { id: string; title: string; steps: Step[] }[] };
};
const [walkthrough] = manifest.contributes.walkthroughs;
const steps = walkthrough.steps;

/** `[Label](command:id?args)` links; on a line of their own they render as buttons. */
function commandLinks(description: string): { id: string; args: unknown[] }[] {
  return [...description.matchAll(/\]\(command:([\w.]+)(?:\?([^)]*))?\)/g)].map(([, id, query]) => ({
    id,
    args: query ? (JSON.parse(decodeURIComponent(query)) as unknown[]) : [],
  }));
}

it('contributes one walkthrough with the five first-run steps', () => {
  expect(manifest.contributes.walkthroughs).toHaveLength(1);
  expect(steps.map((s) => s.id)).toEqual(['openFolder', 'signIn', 'agentManager', 'mention', 'editInPlace']);
});

describe.each(steps)('step $id', (step) => {
  it('has self-contained svg media that follows the theme', () => {
    expect(step.media.svg, 'svg media').toBeDefined();
    expect(step.media.altText, 'alt text').toBeTruthy();
    const file = path.join(EXT, step.media.svg!);
    expect(existsSync(file)).toBe(true);
    const svg = readFileSync(file, 'utf8');
    // No external images, scripts or links: the walkthrough webview allows none of them.
    expect(svg).not.toMatch(/<image|<script|<style|href=|url\(http/i);
    expect(svg).toMatch(/var\(--vscode-/);
  });

  it('has a button for a command that exists', () => {
    const links = commandLinks(step.description);
    expect(links.length).toBeGreaterThan(0);
    const own = new Set(manifest.contributes.commands.map((c) => c.command));
    for (const { id } of links) expect(own.has(id) || id.startsWith('workbench.'), id).toBe(true);
  });
});

it('starts the accounts check and the Agent Manager from their steps', () => {
  const byId = Object.fromEntries(steps.map((s) => [s.id, commandLinks(s.description)]));
  expect(byId.signIn[0].id).toBe('friedliver.accounts');
  expect(byId.agentManager[0].id).toBe('friedliver.openTasks');
  expect(steps.find((s) => s.id === 'mention')?.title).toContain('@gemini');
  expect(byId.editInPlace).toEqual([{ id: 'friedliver.editSelection', args: [] }]);
});

it('startup and Help → Get Started open the FriedLiver Welcome page; built-in walkthroughs and Copilot onboarding stay off (patch 0140)', () => {
  const patch = readFileSync(path.join(__dirname, '..', 'patches', '0140-welcome-says-friedliver.patch'), 'utf8').replace(/\r\n/g, '\n');
  expect(patch).toContain("+export const friedliverWelcomeCommand = 'friedliver.welcome';");
  expect(manifest.contributes.commands.map((c) => c.command)).toContain('friedliver.welcome');
  // Both the startup page and the Help menu's action run it, with the stock page only as the fallback.
  expect(patch.match(/executeCommand\(friedliverWelcomeCommand\)/g)).toHaveLength(2);
  expect(patch).toContain("+			title: localize2('miGetStarted', 'Get Started'),");
  // Upstream's built-in walkthroughs (Setup's "Use AI features with Copilot" step) never register; extensions' still do.
  expect(patch).toContain('+		const builtIn: typeof walkthroughs = [];');
  expect(patch).not.toContain('gettingStartedContent.ts');
  expect(patch).toMatch(/'workbench\.welcomePage\.experimentalOnboarding': \{[^}]*\n\+\t\t\tdefault: false,/);
  // Its first step completes when a folder is already open: the service completes a step whose context already holds.
  expect(steps[0].completionEvents).toContain('onContext:workspaceFolderCount > 0');
  expect(patch).toContain('+			this.progressStep(step.id);');
});
