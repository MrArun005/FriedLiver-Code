// End-to-end check of a packaged FriedLiver build with the offline Demo agent: the chat
// view, an @mention consultation, an agent asking another agent through the FriedLiver
// tools (with the user's Allow), and the Agent Manager board and map. Screenshots go to
// <dir>; keep <dir> short, since the app's sockets live under it.
//   xvfb-run -a node scripts/e2e-demo.mjs VSCode-linux-x64/friedliver /tmp/fle
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(root, 'extensions/friedliver-agents/package.json'));
const { _electron: electron } = require('playwright');

const [exe, dir] = process.argv.slice(2);
if (!exe || !dir) {
  console.error('Usage: node scripts/e2e-demo.mjs <app executable> <short output dir>');
  process.exit(2);
}
rmSync(dir, { recursive: true, force: true });
const ws = `${dir}/ws`;
mkdirSync(`${ws}/src`, { recursive: true });
writeFileSync(`${ws}/package.json`, '{ "name": "prices", "private": true }\n');
writeFileSync(`${ws}/README.md`, '# Prices\n\nFormats prices in cents.\n');
writeFileSync(`${ws}/src/format.ts`, 'export function formatCents(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n');
const app = await electron.launch({
  executablePath: exe,
  args: [ws, '--no-sandbox', `--user-data-dir=${dir}/ud`, `--extensions-dir=${dir}/ext`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu'],
  // The fake Demo agent runs only with this; packaged builds never set it.
  env: { ...process.env, FRIEDLIVER_TEST_AGENTS: '1' },
});
const win = await app.firstWindow();
await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
await win.waitForSelector('.monaco-workbench', { timeout: 60000 });
await win.waitForTimeout(9000);
// The container runs as root, which adds a warning toast; clear it so the shots show the app.
const clearToasts = async () => {
  await win.keyboard.press('Control+Shift+P');
  await win.waitForTimeout(600);
  await win.keyboard.type('Notifications: Clear All Notifications');
  await win.waitForTimeout(600);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(600);
};
await clearToasts();
const shot = async (name) => {
  await win.screenshot({ path: `${dir}/${name}.png` });
  console.log('shot', name);
};

/** The webview frame showing one of the extension's surfaces (chat, tasks, images). */
async function surface(kind, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of win.frames()) {
      const s = await f.evaluate(() => document.body?.dataset.surface).catch(() => null);
      if (s === kind) return f;
    }
    await win.waitForTimeout(300);
  }
  throw new Error(`no ${kind} surface`);
}

await shot('01-first-start');
let chat = await surface('chat');
await chat.getByRole('button', { name: /Demo/ }).first().click();
await win.waitForTimeout(1500);

// 1. @mention: ask a second Demo agent from this chat; its answer comes back here.
const box = () => chat.locator('textarea').first();
await box().fill('@demo Is rounding half-up right for cents?');
await box().press('Enter');
await chat.locator('.link-card[data-role="reply"]').first().waitFor({ timeout: 60000 });
await win.waitForTimeout(800);
await shot('02-consult-reply');

// 2. The agent itself asks another agent through the FriedLiver tools; the user allows it.
await box().fill('ask demo Which file formats the prices?');
await box().press('Enter');
// The request is an approval card (webview/approval.tsx), id item-<request id>: Deny, and "Allow once ⏎" with its scope menu.
const request = chat.locator('.apv[id^="item-bridge"]').first();
await request.waitFor({ timeout: 60000 });
await win.waitForTimeout(800);
await shot('03-agent-asks-agent');
await request.getByRole('button', { name: /^Allow once/ }).click();
await chat.getByText(/says:/).first().waitFor({ timeout: 60000 });
await win.waitForTimeout(800);
await shot('04-answer-after-allow');

// 3. The Agent Manager: board, then the map of how the chats are connected.
// From the command palette: in a narrow side bar the chat header folds its Agent Manager button into All chats.
await win.keyboard.press('Control+Shift+P');
await win.waitForTimeout(600);
await win.keyboard.type('FriedLiver: Agent Manager');
await win.waitForTimeout(800);
await win.keyboard.press('Enter');
const tasks = await surface('tasks');
await win.waitForTimeout(2500);
await shot('05-manager-board');
await tasks.getByRole('tab', { name: /Map/ }).first().click();
await win.waitForTimeout(1500);
await shot('06-manager-map');

const state = await tasks.evaluate(() => document.body.innerText.slice(0, 400));
console.log('manager text:', state.replace(/\s+/g, ' '));
console.log('title:', await win.title());
await app.close();
