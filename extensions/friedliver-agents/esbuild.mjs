import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(here, '../../agent-core');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// The agent core lives in agent-core/ at the repo root. Packages it shares with
// this extension resolve from the extension's own node_modules, so the bundle
// holds one copy and builds without the app's dependencies installed.
const ownPackages = {
  name: 'own-packages',
  setup(build) {
    build.onResolve({ filter: /^(@agentclientprotocol\/sdk|preact)(\/|$)/ }, (args) => {
      if (args.pluginData?.own) return undefined;
      return build.resolve(args.path, { kind: args.kind, resolveDir: here, pluginData: { own: true } });
    });
  },
};

const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'warning',
  absWorkingDir: here,
  plugins: [ownPackages],
  alias: { '@friedliver/main': path.join(core, 'main') },
};
const node = { ...shared, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] };
const web = { ...shared, platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', jsxImportSource: 'preact' };

const builds = [
  { ...node, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
  // The offline demo agent, started with the editor's own runtime.
  { ...node, entryPoints: [path.join(core, 'demo/fakeAgent.mjs')], outfile: 'dist/demo-agent.js' },
  // The FriedLiver tools: an MCP server each agent session starts, which talks to the editor over a local socket.
  { ...node, entryPoints: ['src/bridge/server.ts'], outfile: 'dist/bridge.js' },
  // The browser tools for Claude Code outside FriedLiver: the stdio server its ~/.claude.json entry starts.
  { ...node, entryPoints: ['src/bridge/externalStdio.ts'], outfile: 'dist/externalStdio.js' },
  // Scales the Images view's thumbnails off the extension host's thread.
  { ...node, entryPoints: ['src/host/thumbWorker.ts'], outfile: 'dist/thumbWorker.js' },
  { ...web, entryPoints: { chat: 'src/webview/chat.tsx', tasks: 'src/webview/tasks.tsx', images: 'src/webview/images.tsx', permissions: 'src/webview/permissions.tsx' }, outdir: 'media/dist' },
  // Integration tests that run inside the editor (see src/test).
  { ...node, entryPoints: { run: 'src/test/run.ts', suite: 'src/test/suite.ts' }, outdir: 'dist/test', external: ['vscode'] },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
