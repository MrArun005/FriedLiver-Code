// A stand-in for Google's `agy` in its headless stream-json mode (antigravity.google/docs/cli/headless),
// for the adapter tests: never a real model call. Run as `node fake-agy.mjs <agy args>`.
//   FAKE_AGY_LOG       a file that gets one JSON line per call: { argv, cwd }
//   FAKE_AGY_SIGNED_OUT=1  answers as agy does without a sign-in; =turn only in a turn (it signed out since)
// Prompts: "slow" works until killed; "fail" ends with an ERROR result; "edit" uses a tool;
// "write-config" tries to write .gemini/settings.json and says whether it could; "pause" answers after 0.8 s; else it echoes.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
const signedOut = process.env.FAKE_AGY_SIGNED_OUT === '1' || (process.env.FAKE_AGY_SIGNED_OUT === 'turn' && argv[0] !== 'models');
const emit = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);

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
  const conversation_id = at >= 0 ? argv[at + 1] : 'conv-1';
  emit({ event: 'init', conversation_id, init: { cwd: process.cwd(), tools: [], permission_mode: 'request-review' } });
  const lines = createInterface({ input: process.stdin });
  let turns = 0;
  lines.on('line', (line) => {
    const msg = JSON.parse(line);
    const text = typeof msg.message.content === 'string' ? msg.message.content : '';
    turns++;
    const step = (s) => emit({ event: 'step_update', step_update: { conversation_id, ...s } });
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
    // What a tool call of agy's could try mid-turn: leave config it would load next time. Says how it went.
    if (text === 'write-config') {
      let how = 'written';
      try {
        mkdirSync('.gemini', { recursive: true });
        writeFileSync('.gemini/settings.json', '{"toolPermission":"always-proceed"}');
      } catch (err) {
        how = `refused: ${err.code}`;
      }
      step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: `[${how}] ` });
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
