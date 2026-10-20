// Agents & Accounts as the host would send it: Claude signed in with a
// subscription it reports, Codex waiting for a sign-in, Gemini on an API key
// saved in FriedLiver, and Demo shown. Model names are placeholders. Only the
// UI harness uses it.

const select = (id, name, category, current, choices) => ({ id, name, category, type: 'select', current, choices, via: 'option' });
const choice = (value, name, description, group) => ({ value, name, ...(description ? { description } : {}), ...(group ? { group } : {}) });
const efforts = (values) => values.map((v) => choice(v, v[0].toUpperCase() + v.slice(1)));
const key = (id, name, description, fields, active = false) => ({ id, name, description, fields, active });
const field = (env, label, secret, set = false, value) => ({ env, label, secret, set, ...(value ? { value } : {}) });

const CLI = {
  claude: { signIn: { command: 'claude auth login' }, signOut: { command: 'claude auth logout' }, note: 'Claude Code’s CLI. FriedLiver’s Claude adapter uses the same login.' },
  codex: { signIn: { command: 'codex login' }, signOut: { command: 'codex logout' }, note: 'The Codex CLI (npm install -g @openai/codex). codex-acp uses the same login, in ~/.codex.' },
  gemini: {
    signIn: { command: 'gemini', then: 'Choose Login with Google, or type /auth to pick another way.' },
    signOut: { command: 'gemini', then: 'Type /signout, which clears its cached credentials.' },
    note: 'The Gemini CLI itself: the same program FriedLiver runs in ACP mode.',
  },
};

export function accountsFixture(now = Date.now()) {
  const cards = [
    {
      agent: 'claude',
      name: 'Claude',
      record: {
        status: 'signed-in',
        at: now - 4 * 60_000,
        version: '0.93.0',
        logout: true,
        identity: { kind: 'account', label: 'Subscription plan', email: 'you@example.com' },
        methods: [
          { id: 'claude-ai-login', name: 'Claude Subscription', description: 'Use Claude subscription', kind: 'terminal' },
          { id: 'console-login', name: 'Anthropic Console', description: 'Use Anthropic Console (API usage billing)', kind: 'terminal' },
        ],
      },
      installCommand: 'npm install -g @agentclientprotocol/claude-agent-acp',
      signIn: [
        { id: 'claude-ai-login', name: 'Claude Subscription', description: 'Use Claude subscription', kind: 'terminal' },
        { id: 'console-login', name: 'Anthropic Console', description: 'Use Anthropic Console (API usage billing)', kind: 'terminal' },
      ],
      keys: [key('apiKey', 'Anthropic API key', 'A key from the Anthropic Console, billed per use. Claude prefers it over a subscription login.', [field('ANTHROPIC_API_KEY', 'API key', true)])],
      cli: CLI.claude,
      active: 'Subscription plan · you@example.com',
      model: select('model', 'Model', 'model', 'default', [
        choice('default', 'Default (recommended)', 'The agent’s own pick'),
        choice('large', 'Large', 'For the hardest tasks'),
        choice('small', 'Small', 'Fastest for quick answers'),
      ]),
      effort: select('effort', 'Effort', 'thought_level', 'medium', efforts(['low', 'medium', 'high', 'max'])),
      chosen: { model: 'large', thought_level: 'high' },
    },
    {
      agent: 'codex',
      name: 'Codex',
      record: {
        status: 'needs-sign-in',
        at: now - 2 * 3600_000,
        version: '2.2.2',
        logout: true,
        methods: [
          { id: 'api-key', name: 'API Key', description: 'Use an API key to authenticate', kind: 'key' },
          { id: 'chat-gpt', name: 'ChatGPT', description: 'Use ChatGPT to authenticate', kind: 'browser' },
        ],
      },
      installCommand: 'npm install -g @agentclientprotocol/codex-acp',
      signIn: [{ id: 'chat-gpt', name: 'ChatGPT', description: 'Use ChatGPT to authenticate', kind: 'browser' }],
      keys: [key('apiKey', 'OpenAI API key', 'A key from the OpenAI platform, billed per use.', [field('OPENAI_API_KEY', 'API key', true)])],
      cli: CLI.codex,
      chosen: {},
    },
    {
      agent: 'gemini',
      name: 'Gemini',
      record: {
        status: 'signed-in',
        at: now - 30 * 60_000,
        version: '0.64.0',
        via: 'Gemini API key',
        methods: [
          { id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account', kind: 'browser' },
          { id: 'gemini-api-key', name: 'Gemini API key', description: 'Use an API key with Gemini Developer API', kind: 'key' },
          { id: 'vertex-ai', name: 'Vertex AI', description: 'Use an API key with Vertex AI GenAI API', kind: 'key' },
        ],
      },
      installCommand: 'npm install -g @google/gemini-cli',
      signIn: [{ id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account', kind: 'browser' }],
      keys: [
        key('apiKey', 'Gemini API key', 'A key from Google AI Studio, for the Gemini Developer API.', [field('GEMINI_API_KEY', 'API key', true, true)], true),
        key(
          'vertex',
          'Vertex AI',
          'Your Google Cloud project and location, with gcloud application-default credentials on this machine, or a Vertex AI API key (express mode).',
          [field('GOOGLE_CLOUD_PROJECT', 'Project ID', false), field('GOOGLE_CLOUD_LOCATION', 'Location', false), field('GOOGLE_API_KEY', 'Vertex AI API key (express mode)', true)],
        ),
      ],
      cli: CLI.gemini,
      active: 'Gemini API key, saved in FriedLiver',
      model: select('model', 'Model', 'model', 'auto', [choice('auto', 'Auto (recommended)'), choice('large', 'Large'), choice('fast', 'Fast')]),
      chosen: {},
    },
    {
      agent: 'demo',
      name: 'Demo',
      record: { status: 'signed-in', at: now - 60_000, version: '0.0.0' },
      signIn: [],
      keys: [],
      active: 'No account needed',
      model: select('model', 'Model', 'model', 'demo-smart', [choice('demo-smart', 'Smart', 'Every effort level', 'Thorough'), choice('demo-small', 'Small', 'Low and medium effort only', 'Quick')]),
      effort: select('effort', 'Effort', 'thought_level', 'medium', efforts(['low', 'medium', 'high', 'xhigh', 'max'])),
      chosen: {},
    },
  ];
  const tools = ['system_open', 'system_apps', 'system_focus', 'system_shortcut', 'system_clipboard_read', 'system_clipboard_write', 'system_notify', 'system_volume', 'system_screenshot_window'];
  const system = { supported: true, platform: 'mac', enabled: true, fullAutoAllowed: false, tools: Object.fromEntries(tools.map((t) => [t, t !== 'system_volume'])) };
  return { cards, links: 'builtin', system };
}
