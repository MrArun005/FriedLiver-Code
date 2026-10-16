import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { AgentCore, type CoreOptions } from '../src/host/core';
import type { AgentToAgent } from '../src/host/bridgeRequests';

export const DEMO_AGENT = path.resolve(__dirname, '../../../agent-core/demo/fakeAgent.mjs');

export async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-conn-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

/** The FriedLiver tools' MCP server, bundled the way esbuild.mjs does it. */
export async function buildBridge(): Promise<string> {
  const out = path.join(await mkdtemp(path.join(os.tmpdir(), 'fl-bridge-')), 'bridge.js');
  await build({
    entryPoints: [path.resolve(__dirname, '../src/bridge/server.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: out,
    logLevel: 'silent',
  });
  return out;
}

const cores = new Set<AgentCore>();

export async function disposeCores(): Promise<void> {
  await Promise.all([...cores].map((c) => c.dispose()));
  cores.clear();
}

/**
 * A core where Claude, Codex and Gemini are all the offline demo agent, and
 * every review and command is approved, so tests never touch a real CLI.
 */
export function makeCore(folder: string, over: Partial<CoreOptions> & { policy?: () => AgentToAgent } = {}): AgentCore {
  const { policy, ui, ...rest } = over;
  const core: AgentCore = new AgentCore({
    folders: () => [folder],
    clientVersion: 'test',
    demoAgentScript: DEMO_AGENT,
    agentCommand: () => ({ command: process.execPath, args: [DEMO_AGENT] }),
    apiKey: () => undefined,
    limits: () => ({ maxRunning: 4, idleStopMinutes: 0 }),
    agentToAgent: policy,
    ui: {
      showReview: (r) => setTimeout(() => core.decideReview(r.reviewId, true), 5),
      closeReview: () => {},
      askCommand: (a) => setTimeout(() => core.decideCommand(a.commandId, true), 5),
      ...ui,
    },
    ...rest,
  });
  cores.add(core);
  return core;
}

export async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
