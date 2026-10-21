// Models as the agents report them (ids and display names), for the /discuss mention tests.
import type { ModelCatalog } from '../../src/shared/discussMentions';

export const CATALOG: ModelCatalog = {
  claude: [
    { value: 'default', name: 'Default (recommended)' },
    { value: 'claude-opus-4-1', name: 'Opus 4.1' },
    { value: 'claude-opus-4-5', name: 'Opus 4.5' },
    { value: 'claude-sonnet-4-5', name: 'Sonnet 4.5' },
    { value: 'claude-haiku-4-5', name: 'Haiku 4.5' },
  ],
  codex: [
    { value: 'gpt-5.6-terra', name: 'gpt-5.6-terra' },
    { value: 'gpt-5.6-luna', name: 'gpt-5.6-luna' },
    { value: 'gpt-5-pro', name: 'GPT-5 Pro' },
  ],
  gemini: [
    { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
    { value: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { value: 'gemini-3.1-flash', name: 'Gemini 3.1 Flash' },
    { value: 'argon', name: 'Argon' },
  ],
  antigravity: [
    { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { value: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  ],
};
