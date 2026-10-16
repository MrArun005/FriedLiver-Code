#!/usr/bin/env node
// A tiny ACP agent for tests. What it does depends on the prompt text:
//   "edit <path>"     asks permission with a diff, then writes <path>
//   "run"             runs a command in a client terminal and reports its output
//   "read-image <p>"  reports a read tool call on an image file
//   "wait"            keeps working until cancelled
//   "tour"            the UI demo: a plan, a file read, an edit, a command and an image
//   anything else     echoes the text back in two chunks
// FAKE_AGENT_AUTH=1 makes session/new require authenticate("fake-login") first.
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const needsAuth = process.env.FAKE_AGENT_AUTH === '1';
const images = process.env.FAKE_AGENT_IMAGES !== '0';
let authenticated = false;
let nextSession = 1;
const cancels = new Map();
const sessionCwd = new Map();

const say = (client, sessionId, text) =>
  client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });

const tool = (client, sessionId, update) =>
  client.notify(acp.methods.client.session.update, { sessionId, update });

async function edit(client, sessionId, path) {
  await tool(client, sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'edit-1',
    title: `Edit ${path}`,
    kind: 'edit',
    status: 'pending',
    locations: [{ path }],
    content: [{ type: 'diff', path, oldText: null, newText: 'edited by fake agent\n' }],
  });
  const answer = await client.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId: 'edit-1', title: `Edit ${path}`, kind: 'edit' },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const allowed = answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'allow';
  if (allowed) {
    await client.request(acp.methods.client.fs.writeTextFile, { sessionId, path, content: 'edited by fake agent\n' });
  }
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: allowed ? 'completed' : 'failed' });
  await say(client, sessionId, allowed ? 'Edited.' : 'Skipped the edit.');
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Stands in for a screenshot the agent took.
const SCREENSHOT = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">
  <rect width="480" height="300" rx="10" fill="#1e1e1e"/>
  <rect width="480" height="28" rx="10" fill="#323233"/>
  <circle cx="18" cy="14" r="5" fill="#f48771"/><circle cx="36" cy="14" r="5" fill="#d7ba7d"/><circle cx="54" cy="14" r="5" fill="#4ec9b0"/>
  <rect x="16" y="48" width="200" height="10" rx="3" fill="#3794ff"/>
  <rect x="16" y="70" width="320" height="8" rx="3" fill="#555"/><rect x="16" y="88" width="280" height="8" rx="3" fill="#555"/>
  <rect x="16" y="106" width="300" height="8" rx="3" fill="#555"/>
  <rect x="16" y="140" width="448" height="140" rx="6" fill="#252526" stroke="#3c3c3c"/>
  <text x="240" y="218" font-family="sans-serif" font-size="18" fill="#d4d4d4" text-anchor="middle">Screenshot from the demo agent</text>
</svg>`,
).toString('base64');

async function tour(client, sessionId) {
  const cwd = sessionCwd.get(sessionId) ?? process.cwd();
  const notes = `${cwd}/NOTES.md`;
  const steps = ['Look around the project', 'Add a NOTES.md file', 'Run a quick check', 'Share a screenshot'];
  const plan = (done) =>
    tool(client, sessionId, {
      sessionUpdate: 'plan',
      entries: steps.map((content, i) => ({
        content,
        priority: 'medium',
        status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
      })),
    });

  await say(client, sessionId, "Hi! I'm the **demo agent**. I run offline, so you can try FriedLiver without signing in.\n\n");
  await plan(0);
  await pause(300);
  await tool(client, sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tour-read',
    title: 'List the project files',
    kind: 'read',
    status: 'completed',
    locations: [{ path: cwd }],
  });
  await plan(1);
  await say(client, sessionId, 'Next I want to add a notes file. You review the diff before anything is written.\n\n');
  const before = await client
    .request(acp.methods.client.fs.readTextFile, { sessionId, path: notes })
    .then((r) => r.content)
    .catch(() => null);
  const after = `${before ?? '# Notes\n'}\n- ${new Date().toISOString().slice(0, 10)}: FriedLiver demo agent was here.\n`;
  try {
    await client.request(acp.methods.client.fs.writeTextFile, { sessionId, path: notes, content: after });
    await say(client, sessionId, '`NOTES.md` saved.\n\n');
  } catch {
    await say(client, sessionId, 'You rejected the edit, so nothing was written.\n\n');
  }
  await plan(2);
  await run(client, sessionId);
  await plan(3);
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/svg+xml', data: SCREENSHOT } },
  });
  await plan(4);
  await say(client, sessionId, '\n\nThat\'s the tour: a plan, a reviewed edit, an approved command, and an image in the panel on the right.');
}

async function run(client, sessionId) {
  let terminalId;
  try {
    ({ terminalId } = await client.request(acp.methods.client.terminal.create, {
      sessionId,
      command: process.execPath,
      args: ['-e', "console.log('hello from terminal')"],
      // Inside FriedLiver this agent runs on Electron's binary; make the command run as Node too.
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    }));
  } catch {
    await say(client, sessionId, 'You denied the command, so I skipped it.');
    return;
  }
  await tool(client, sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'run-1',
    title: 'Run node',
    kind: 'execute',
    status: 'in_progress',
    content: [{ type: 'terminal', terminalId }],
  });
  const exit = await client.request(acp.methods.client.terminal.waitForExit, { sessionId, terminalId });
  const { output } = await client.request(acp.methods.client.terminal.output, { sessionId, terminalId });
  await client.request(acp.methods.client.terminal.release, { sessionId, terminalId });
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'run-1', status: 'completed' });
  await say(client, sessionId, `exit ${exit.exitCode}: ${output.trim()}`);
}

acp
  .agent({ name: 'fake-agent' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: images } },
    authMethods: needsAuth ? [{ id: 'fake-login', name: 'Fake login' }] : [],
    agentInfo: { name: 'fake-agent', version: '0.0.0' },
  }))
  .onRequest(acp.methods.agent.authenticate, ({ params }) => {
    if (params.methodId !== 'fake-login') throw acp.RequestError.invalidParams();
    authenticated = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    if (needsAuth && !authenticated) throw acp.RequestError.authRequired();
    const sessionId = `fake-session-${nextSession++}`;
    sessionCwd.set(sessionId, params.cwd);
    return { sessionId };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    cancels.get(params.sessionId)?.();
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const { sessionId } = params;
    const text = params.prompt
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
    const imageCount = params.prompt.filter((b) => b.type === 'image').length;

    if (text === 'wait') {
      await new Promise((resolve) => cancels.set(sessionId, resolve));
      cancels.delete(sessionId);
      return { stopReason: 'cancelled' };
    }
    if (text === 'tour') await tour(client, sessionId);
    else if (text.startsWith('edit ')) await edit(client, sessionId, text.slice(5));
    else if (text === 'run') await run(client, sessionId);
    else if (text.startsWith('read-image ')) {
      const path = text.slice(11);
      await tool(client, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: `Read ${path}`,
        kind: 'read',
        status: 'completed',
        locations: [{ path }],
      });
    } else {
      await say(client, sessionId, 'You said: ');
      await say(client, sessionId, `${text}${imageCount ? ` (+${imageCount} image)` : ''}`);
    }
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
