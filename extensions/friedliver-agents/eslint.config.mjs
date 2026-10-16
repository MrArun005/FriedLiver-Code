import root from '../../../eslint.config.mjs';

// ESLint looks up the nearest config per file, so this folder repeats the
// app's rules and skips its own build output.
export default [{ ignores: ['dist/', 'media/dist/', 'node_modules/', '.vscode-test/'] }, ...root];
