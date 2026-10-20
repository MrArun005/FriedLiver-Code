// A stand-in for Google's `agy` in its headless stream-json mode (antigravity.google/docs/cli/headless),
// for the adapter tests: never a real model call. Run as `node fake-agy.mjs <agy args>`.
//   FAKE_AGY_LOG       a file that gets one JSON line per call: { argv, cwd }
//   FAKE_AGY_SIGNED_OUT=1  answers as agy does without a sign-in; =turn only in a turn (it signed out since)
// Prompts (in talk only, the part after FriedLiver's "## Message"): "slow" works until killed; "fail" ends
// with an ERROR result; "edit" uses a tool; "write-config" tries to write .gemini/settings.json and says
// whether it could; "pause" answers after 0.8 s; "probe:<file>" tries to read <file>, write next to it,
// write in its own folder and run a shell, and says how each went; "ask-need" asks FriedLiver to read
// (once), "always-need" every time, "big-need" for five big files; else it echoes.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
try {
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
} catch {
  // A sandbox that doesn't let it log.
}
const signedOut = process.env.FAKE_AGY_SIGNED_OUT === '1' || (process.env.FAKE_AGY_SIGNED_OUT === 'turn' && argv[0] !== 'models');
const emit = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const need = (items) => `\n~~~need\n${JSON.stringify({ need: items })}\n~~~`;
const how = (fn) => {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return err.code ?? String(err.message ?? err);
  }
};

if (argv[0] === '--version') {
  console.log('1.4.3');
} else if (argv[0] === 'models') {
  console.log('Fetching available models...');
  if (signedOut) {
    console.error('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.');
    process.exit(1);
  }
  console.log('Gemini 3.8 Flash (Medium)');
  console.log('Gemini 3.1 Pro (High)');
  console.log('Claude Sonnet 5.5 (Thinking)');
} else if (signedOut) {
  // Real agy waits up to 60 s here for a code typed on stdin.
  console.error('Authentication required. Please visit the URL to log in:');
  console.error('  https://accounts.google.com/o/oauth2/auth?client_id=x');
  console.error('Or, paste the authorization code here and press Enter:');
  setTimeout(() => process.exit(1), 60_000);
} else {
  const at = argv.indexOf('--conversation');
  let conversation_id = at >= 0 ? argv[at + 1] : 'conv-1';
  emit({ event: 'init', conversation_id, init: { cwd: process.cwd(), tools: [], permission_mode: 'request-review' } });
  const lines = createInterface({ input: process.stdin });
  let turns = 0;
  lines.on('line', (line) => {
    const msg = JSON.parse(line);
    const content = typeof msg.message.content === 'string' ? msg.message.content : '';
    const marker = content.lastIndexOf('## Message\n\n');
    const text = marker >= 0 ? content.slice(marker + '## Message\n\n'.length) : content;
    turns++;
    const step = (s) => emit({ event: 'step_update', step_update: { conversation_id, ...s } });
    const say = (t) => {
      step({ step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: t });
      emit({ event: 'result', result: { conversation_id, status: 'SUCCESS', response: t, num_turns: turns } });
    };
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
    // FriedLiver's answers to what it asked: the conversation says which ask it was.
    if (content.startsWith("## FriedLiver's answers")) {
      if (conversation_id === 'conv-always') return say(`Again.${need([{ read: 'src/a.ts', lines: '1-2' }])}`);
      return say(`Got answers:\n${content}`);
    }
    if (text === 'ask-need') {
      conversation_id = 'conv-ask';
      return say(`Let me look.${need([{ read: 'src/a.ts', lines: '1-2' }, { search: 'jsonb' }, { read: '../../etc/passwd' }, { read: 'config/.env' }, { outline: '/etc/hosts' }])}`);
    }
    if (text === 'always-need') {
      conversation_id = 'conv-always';
      return say(`Looking.${need([{ read: 'src/a.ts', lines: '1-2' }])}`);
    }
    if (text === 'big-need') {
      conversation_id = 'conv-big';
      return say(`Big.${need([1, 2, 3, 4, 5].map((n) => ({ read: `big/${n}.ts` })))}`);
    }
    if (text.startsWith('probe:')) {
      const file = text.slice('probe:'.length).trim();
      const results = {
        readProject: how(() => readFileSync(file, 'utf8')),
        writeProject: how(() => writeFileSync(`${file}.x`, 'x')),
        writeOwnFolder: how(() => writeFileSync('ok.txt', 'x')),
        configOwnFolder: how(() => mkdirSync('.gemini')),
        configOwnFolderUnicode: how(() => mkdirSync('.agentſ')),
        shell: (() => {
          const r = spawnSync('/bin/sh', ['-c', 'echo hi'], { encoding: 'utf8' });
          return r.error ? (r.error.code ?? 'error') : r.status === 0 && r.stdout.trim() === 'hi' ? 'ok' : `exit ${r.status}`;
        })(),
      };
      return say(JSON.stringify(results));
    }
    // What a tool call of agy's could try mid-turn: leave config it would load next time. Says how it went.
    if (text === 'write-config') {
      let result = 'written';
      try {
        mkdirSync('.gemini', { recursive: true });
        writeFileSync('.gemini/settings.json', '{"toolPermission":"always-proceed"}');
      } catch (err) {
        result = `refused: ${err.code}`;
      }
      step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: `[${result}] ` });
    }
    if (text === 'slow') return;
    if (text === 'pause') {
      setTimeout(() => emit({ event: 'result', result: { conversation_id, status: 'SUCCESS', response: 'paused', num_turns: turns } }), 800);
      return;
    }
    if (text === 'fail') {
      emit({ event: 'result', result: { conversation_id, status: 'ERROR', response: '', error: 'boom: the model refused' } });
      return;
    }
    if (text === 'edit') {
      step({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: 'notes.md', CodeContent: 'hi' } } });
      step({ step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: 'notes.md' }, output: 'Created notes.md' } });
    }
    step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'You said: ' });
    step({ step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: text });
    emit({ event: 'result', result: { conversation_id, status: 'SUCCESS', response: `You said: ${text}`, num_turns: turns } });
  });
  lines.on('close', () => process.exit(0));
}
