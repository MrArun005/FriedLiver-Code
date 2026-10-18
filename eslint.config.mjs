import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // vscode/ is the fetched upstream source; VSCode-*/ and installers/ are build output.
  { ignores: ['**/dist/', '**/media/dist/', 'node_modules/', 'vscode/', 'VSCode-*/', 'installers/', '.cache/', '**/.vscode-test/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly', Buffer: 'readonly', URL: 'readonly' } },
  },
  {
    // Playwright scripts run some code inside the app window.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly' } },
  },
  {
    // The workbench harness's test-only extension (CommonJS, loaded by the extension host).
    files: ['test/workbench-harness/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', exports: 'writable' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
