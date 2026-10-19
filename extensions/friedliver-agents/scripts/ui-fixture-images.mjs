// The Images view's fixture: the design work on FriedLiver's chat as it really
// went, with the images it really read and made (in ~/code/FriedLiver-Code-design,
// served through the host's own thumbnail code by the harness; stand-ins
// elsewhere). A QA sweep that read 104 screenshots, a review that compared
// renders with references, a measuring tool's annotated pairs, two images you
// attached, a tool's image output, a file outside the allowed folders, an SVG,
// and the Claude Code session outside FriedLiver that audited the design.
// Only the UI harness uses it (?fixture=images).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DESIGN = path.join(os.homedir(), 'code/FriedLiver-Code-design');
const ROOT = path.join(os.homedir(), 'code/FriedLiver-Code');
const QA = [
  ...'01-empty-chat-1200 01-empty-chat-640 01-empty-chats-list-300 01-empty-manager-board-1200 01-empty-manager-list-1200 01-empty-manager-map-1200 02-new-chat-claude-1200 02-new-chat-codex-1200 02-new-chat-demo-1200 02-new-chat-demo-640 02-new-chat-gemini-1200 02-new-chat-menu-1200 03-long-message-collapsed-1200 03-long-message-collapsed-640 03-long-message-expanded-1200 03-long-message-expanded-640 03-long-message-sticky-1200 03-long-message-sticky-640 03-sticky-show-more-after-1200 04-composer-5k-paste-1200 04-composer-5k-paste-640 04-composer-attachments-1200 04-composer-attachments-640 04-composer-focus-1200 04-composer-focus-640 04-composer-idle-1200 04-composer-idle-640 04-effort-after-drag-1200 04-effort-after-drag-640 04-model-menu-1200 04-model-menu-640 04-model-menu-keyboard-1200 04-model-menu-keyboard-640 04-model-menu-light-1200 04-modes-menu-1200 04-modes-menu-640 04-modes-menu-light-1200 04-slash-menu-1200 04-slash-menu-640 04-slash-menu-no-match-1200 04-slash-menu-no-match-640 04-typed-slash-1200 04-typed-slash-640 05-mic-fallback-hint 05-mic-hover 05-mic-idle 05-mic-listening-light 05-mic-listening 05-mic-stopping 06-tabs-all-closed-1200 06-tabs-hover-1200 06-tabs-overflow-640 07-decision-card-command-1200 07-decision-card-command-640 07-decision-cards-c1-1200 07-images-pill-1200 07-question-card-1200 07-step-images-1200 07-steps-1200 07-transcript-code-block-hover-1200 07-transcript-reference-1200 07-transcript-reference-640 07-transcript-thinking-and-step-open-1200 08-more-menu-checkpoints-1200 08-rewind-hover-1200 09-rules-chip-1200 09-rules-chip-640 10-agent-map-1200 10-agent-map-14-agents-1200 10-agent-map-640 10-subagents-1200 10-subagents-640 11-consult-card-1200 11-handoff-card-1200 11-handoff-target-card-1200 11-notification-open-archived-1200 11-notification-reveal-decision-1200 11-pipe-card-1200 12-board-card-hover-1200 12-board-card-hover-640 12-board-card-more-menu-1200 12-board-card-more-menu-640 12-compare-1200 12-manager-board-1200 12-manager-board-640 12-manager-board-light-1200 12-manager-list-1200 12-manager-list-640 12-manager-map-1200 12-manager-map-640 12-map-hover-1200 13-all-chats-no-match-1200 13-all-chats-popover-1200 13-chats-list-300 13-chats-list-640 14-500-turns-1200 15-demo-done-1200 15-demo-streaming-1200 15-demo-working-1200 16-light-chat-c1-1200 16-light-list-1200 16-light-reference-1200 16-light-subagents-1200'.split(' '),
];
const COMPARE = ['agent-map', 'composer', 'model-menu', 'modes-menu', 'slash-menu', 'transcript'];

/** The files the harness may read for real; everything else is a stand-in or refused. */
export const IMAGE_ROOTS = [DESIGN];

export function imagesFixture(now = Date.now()) {
  const min = (m) => now - m * 60_000;
  const read = (id, file, at, extra = {}) => ({ kind: 'tool', id, title: `Read ${path.basename(file)}`, toolKind: 'read', status: 'completed', locations: [file], tool: 'Read', startedAt: at, ...extra });
  const chat = (id, agent, label, title, createdAt, items, lastActivity) => ({ id, agent, label, title, cwd: ROOT, createdAt, busy: false, changedFiles: 0, items, depth: 0, files: [], lastActivity, turns: 1 });

  // A QA sweep: every screenshot of the run, read one by one.
  const qa = chat(
    'chat-qa',
    'claude',
    'Claude 1',
    'QA sweep of the chat surface',
    min(190),
    [
      { kind: 'user', text: 'Walk every chat state at 1200 and 640 and read each screenshot; list what looks off.', images: [], at: min(190) },
      ...QA.map((name, n) => read(`qa-${n}`, path.join(DESIGN, 'qa', `${name}.png`), min(188 - n * 1.2))),
      { kind: 'agent', text: 'Read all 104 screenshots. Seven findings, worst first.', at: min(60) },
    ],
    min(60),
  );

  // A review: renders against the reference shots.
  const review = chat(
    'chat-review',
    'claude',
    'Claude 2',
    'Compare the composer with Claude Code',
    min(52),
    [
      { kind: 'user', text: 'Put our menus next to the reference screenshots and measure the gaps.', images: [], at: min(52) },
      ...['5', '6', '7', '8'].map((n, i) => read(`ref-${n}`, path.join(DESIGN, 'references', `${n}.png`), min(50 - i), { about: ['The model menu (reference)', 'The window with the agent map (reference)', 'The modes menu (reference)', 'The slash menu and composer (reference)'][i] })),
      ...COMPARE.flatMap((c, i) => [
        read(`ours-${c}`, path.join(DESIGN, 'review', `ours-${c}-1200.png`), min(44 - i * 2)),
        {
          kind: 'tool',
          id: `shot-${c}`,
          title: 'browser_screenshot',
          tool: 'mcp__friedliver__browser_screenshot',
          toolKind: 'fetch',
          status: 'completed',
          locations: [],
          startedAt: min(43 - i * 2),
          out: [{ t: 'text', text: `Screenshot of http://127.0.0.1:5178/?surface=chat&theme=dark-2026 (“${c.replace('-', ' ')}”)\nSaved to ${path.join(DESIGN, 'review', `compare-${c}-1200.png`)}. Read that file to see it.` }],
        },
      ]),
    ],
    min(30),
  );

  // A measuring tool: it writes annotated pairs (and one picture it sends back as data).
  const measure = chat(
    'chat-measure',
    'codex',
    'Codex 1',
    'Annotate the reference measurements',
    min(30),
    [
      { kind: 'user', text: 'Draw the measured boxes on each reference and pair it with ours.', images: [], at: min(30) },
      ...['agent-map', 'model-menu', 'modes-menu', 'slash-menu'].flatMap((c, i) => [
        { kind: 'tool', id: `write-ref-${c}`, title: `Write ref-${c}-annotated.png`, toolKind: 'edit', status: 'completed', locations: [path.join(DESIGN, 'measurements', `ref-${c}-annotated.png`)], tool: 'Write', startedAt: min(26 - i * 3) },
        { kind: 'tool', id: `write-pair-${c}`, title: `Write pair-${c}.png`, toolKind: 'edit', status: 'completed', locations: [path.join(DESIGN, 'measurements', `pair-${c}.png`)], tool: 'Write', startedAt: min(25 - i * 3) },
      ]),
      { kind: 'tool', id: 'plot-radii', title: 'Plot the fitted corner radii', toolKind: 'execute', status: 'completed', locations: [], startedAt: min(12) },
      read('icon-svg', path.join(ROOT, 'extensions/friedliver-agents/media/agents.svg'), min(11)),
      read('outside-shot', '/Users/someone-else/Desktop/outside-secret.png', min(10)),
    ],
    min(10),
  );

  // Images you attached to a chat.
  const attach = chat(
    'chat-tabs',
    'gemini',
    'Gemini 1',
    'Tabs that work like a browser’s',
    min(8),
    [
      { kind: 'user', text: 'Make the chat tabs behave like these.', images: ['att-tabs', 'att-overflow'], at: min(8) },
      read('tabs-close', path.join(DESIGN, 'review', 'tabs-close.png'), min(6)),
    ],
    min(5),
  );

  // Data URIs: replaced by the harness with real thumbnails of these files (stand-ins when missing).
  const images = [
    { id: 'att-tabs', src: '', title: 'Chrome tab strip.png', from: 'you', chatId: 'chat-tabs', at: min(8), file: path.join(DESIGN, 'qa', '06-tabs-hover-1200.png') },
    { id: 'att-overflow', src: '', title: 'Overflowing tabs.png', from: 'you', chatId: 'chat-tabs', at: min(8), file: path.join(DESIGN, 'qa', '06-tabs-overflow-640.png') },
    { id: 'tool-radii', src: '', title: 'Plot the fitted corner radii', from: 'agent', chatId: 'chat-measure', stepId: 'plot-radii', at: min(12), file: path.join(DESIGN, 'measurements', 'ref-model-menu-annotated.png') },
  ];

  // The Claude Code session outside FriedLiver that wrote DESIGN-SYSTEM.md.
  const outside = [
    {
      id: '0d7ae1a0-8341-40aa-ac53-acaee2df69fb',
      cwd: ROOT,
      title: 'Audit the chat surface against Claude Code',
      images: [
        ...['5', '6', '7', '8'].map((n, i) => ({ path: path.join(DESIGN, 'references', `${n}.png`), title: `${n}`, source: 'read', at: min(400 - i) })),
        ...['agent-map', 'model-menu', 'modes-menu', 'slash-menu'].map((c, i) => ({ path: path.join(DESIGN, 'measurements', `pair-${c}.png`), title: `Pair ${c.replace('-', ' ')}`, source: 'read', at: min(380 - i) })),
        ...['board', 'list', 'map'].map((c, i) => ({ path: path.join(DESIGN, 'review', `polish-compare-${c}.png`), title: `Screenshot of the Manager ${c}`, source: 'screenshot', at: min(240 - i) })),
      ],
    },
  ];

  return { state: { chats: [qa, review, measure, attach], images, links: [] }, outside, ids: { qa: qa.id, review: review.id, tabs: attach.id, measure: measure.id } };
}

export const exists = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};
