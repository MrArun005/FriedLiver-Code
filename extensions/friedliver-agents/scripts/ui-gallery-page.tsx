// The living gallery (scripts/ui-gallery.mjs bundles this; it never ships): every component in
// src/webview/ui × variant × size × state, drawn by the real components and components.css.
// Hover, active and focus are forced on elements marked data-force by the script (CDP).
import { render, type ComponentChildren } from 'preact';
import { Icon } from '../src/webview/common';
import {
  ChipButton,
  ChoiceRow,
  FileRef,
  Tab,
  AgentMark,
  Avatar,
  Banner,
  Button,
  Card,
  CardFoot,
  CardHead,
  Checkbox,
  Count,
  Countdown,
  Divider,
  Empty,
  Field,
  FilterPill,
  HoldButton,
  IconButton,
  Input,
  Kbd,
  MenuItem,
  MenuSep,
  MenuTitle,
  Pill,
  Progress,
  RadioRow,
  Row,
  Search,
  Segmented,
  Spinner,
  Tabs,
  Textarea,
  Toast,
  Toggle,
  selectTrigger,
  type Size,
  type Variant,
} from '../src/webview/ui';

const noop = () => {};
const STATES = ['rest', 'hover', 'active', 'focus', 'pressed', 'disabled', 'loading'] as const;
type State = (typeof STATES)[number];
const force = (s: State) => (s === 'hover' || s === 'active' ? { 'data-force': s } : s === 'focus' ? { 'data-force': 'focus-visible' } : {});

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ComponentChildren }) {
  return (
    <section class="g-section" id={id}>
      <h2 class="g-h">
        {title} {note && <span class="g-note">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

/** A grid: labelled rows, one column per state. */
function Matrix({ cols, rows }: { cols: string[]; rows: [string, ComponentChildren[]][] }) {
  return (
    <div class="g-matrix" style={{ gridTemplateColumns: `140px repeat(${cols.length}, minmax(0, 1fr))` }}>
      <span />
      {cols.map((c) => (
        <span key={c} class="g-col">
          {c}
        </span>
      ))}
      {rows.map(([label, cells]) => [
        <span key={label} class="g-row">
          {label}
        </span>,
        ...cells.map((c, i) => (
          <div key={`${label}${i}`} class="g-cell">
            {c}
          </div>
        )),
      ])}
    </div>
  );
}

const VARIANTS: Variant[] = ['primary', 'secondary', 'quiet', 'danger', 'quiet-danger', 'brand', 'link', 'text'];
const SIZES: Size[] = ['sm', 'md', 'lg', 'touch'];

function buttonState(v: Variant, s: State, size: Size = 'md') {
  // Pressed is a toggle's "on": only quiet and secondary buttons toggle.
  if (s === 'pressed' && v !== 'secondary' && v !== 'quiet') return <span class="g-note">n/a</span>;
  const label = v === 'danger' || v === 'quiet-danger' ? 'Delete' : v === 'link' ? 'Open diff' : v === 'text' ? 'Fix formatCents' : v === 'brand' ? 'Send' : v === 'primary' ? 'Allow once' : 'Deny';
  return (
    <Button variant={v} size={size} {...force(s)} aria-pressed={s === 'pressed' ? 'true' : undefined} disabled={s === 'disabled'} loading={s === 'loading'}>
      {label}
    </Button>
  );
}

function Gallery() {
  return (
    <main class="g">
      <header class="g-top">
        <h1>FriedLiver components</h1>
        <span class="g-note">COMPONENTS.md · tokens.css · components.css · src/webview/ui — theme: {document.body.dataset.themeName}</span>
      </header>

      <Section id="button" title="Button" note="md 26 · r5 · one primary per surface">
        <Matrix cols={[...STATES]} rows={VARIANTS.map((v) => [v, STATES.map((s) => buttonState(v, s))])} />
        <Matrix
          cols={SIZES.map((s) => `${s} ${{ sm: 22, md: 26, lg: 32, touch: 44 }[s]}`)}
          rows={[
            ['primary', SIZES.map((z) => buttonState('primary', 'rest', z))],
            [
              'secondary + icon',
              SIZES.map((z) => (
                <Button size={z} icon="undo">
                  Undo this turn
                </Button>
              )),
            ],
            [
              'quiet + kbd',
              SIZES.map((z) => (
                <Button size={z} variant="quiet" kbd="Esc">
                  Deny
                </Button>
              )),
            ],
            [
              'primary + kbd',
              SIZES.map((z) => (
                <Button size={z} variant="primary" kbd="⏎">
                  Allow once
                </Button>
              )),
            ],
            ['icon (quiet)', SIZES.map((z) => <IconButton size={z} icon="more" label="More" />)],
            ['icon (muted)', SIZES.map((z) => <IconButton size={z} icon="copy" label="Copy" muted />)],
            ['icon (secondary)', SIZES.map((z) => <IconButton size={z} variant="secondary" icon="plus" label="Add" />)],
            ['icon (brand: send)', SIZES.map((z) => <IconButton size={z} variant="brand" icon="up" label="Send" />)],
            ['icon round (pagers, phone)', SIZES.map((z) => <IconButton size={z} round variant="secondary" icon="forward" label="Next" />)],
          ]}
        />
        <Matrix
          cols={['rest', 'hover', 'menu open', 'disabled']}
          rows={[
            ['split', [<SplitDemo />, <SplitDemo force="hover" />, <SplitDemo open />, <SplitDemo disabled />]],
            [
              'hold to confirm',
              [
                <HoldButton onConfirm={noop}>Force push</HoldButton>,
                <HoldButton onConfirm={noop} data-force="hover">
                  Force push
                </HoldButton>,
                <button type="button" class="fl-btn fl-btn--danger fl-btn--hold g-mid" data-holding="">
                  Holding…
                </button>,
                <HoldButton onConfirm={noop} disabled>
                  Force push
                </HoldButton>,
              ],
            ],
            [
              'icon states',
              [
                <IconButton icon="more" label="More" />,
                <IconButton icon="more" label="More" data-force="hover" />,
                <IconButton icon="more" label="More" aria-expanded="true" />,
                <IconButton icon="more" label="More" disabled />,
              ],
            ],
          ]}
        />
      </Section>

      <Section id="pill" title="Pill · Chip · Tag" note="18 · pill radius · tone on a 14% tint">
        <Matrix
          cols={['neutral', 'working', 'done', 'failed', 'waiting', 'warn', 'muted']}
          rows={[
            ['status', (['', 'working', 'done', 'failed', 'waiting', 'warn', 'muted'] as const).map((t) => <Pill tone={t || undefined}>{t || 'merged'}</Pill>)],
            [
              'with icon',
              (['', 'working', 'done', 'failed', 'waiting', 'warn', 'muted'] as const).map((t) => (
                <Pill tone={t || undefined} icon="branch">
                  claude/search
                </Pill>
              )),
            ],
            [
              'risk (dot)',
              [
                <Pill dot>Inside the repo</Pill>,
                <span />,
                <span />,
                <Pill tone="careful" dot>
                  Rewrites history
                </Pill>,
                <span />,
                <Pill tone="review" dot>
                  Submits a form
                </Pill>,
                <Pill tone="routine" dot>
                  Runs tests
                </Pill>,
              ],
            ],
          ]}
        />
        <Matrix
          cols={['rest', 'hover', 'focus', 'pressed', 'with sub', 'md 22', 'touch 32']}
          rows={[
            [
              'filter / picker',
              [
                <FilterPill onPress={noop}>Claude</FilterPill>,
                <span data-force="hover" data-force-target="button">
                  <FilterPill onPress={noop}>Claude</FilterPill>
                </span>,
                <span data-force="focus-visible" data-force-target="button">
                  <FilterPill onPress={noop}>Claude</FilterPill>
                </span>,
                <FilterPill onPress={noop} pressed>
                  Claude
                </FilterPill>,
                <Pill sub="Low">Opus 5.5</Pill>,
                <FilterPill onPress={noop} size="md" icon="grid">
                  Images
                </FilterPill>,
                <FilterPill onPress={noop} size="touch">
                  All chats
                </FilterPill>,
              ],
            ],
          ]}
        />
        <div class="g-line">
          Counts: <Count n={3} /> <Count n={12} /> <Count n="99+" /> <Count n={4} loud label="4 waiting" />
          <span class="g-note">File refs:</span>
          <FileRef path="src/webview/format.ts" onOpen={noop} />
          <FileRef path="test/format.test.ts" onOpen={noop} />
          <span class="g-note">Chips with ×:</span>
          <ChipButton icon="pipe" onPress={noop} onRemove={noop} removeLabel="Stop the pipe">
            pipes to Review each search change
          </ChipButton>
          <ChipButton lead={<Avatar agent="codex" size="sm" />} onPress={noop}>
            Codex 3
          </ChipButton>
        </div>
      </Section>

      <Section id="seg" title="Segmented control · Toggle · Checkbox · Radio row" note="track r6 / segment r4 · toggle 32×18">
        <div class="g-line">
          <Segmented
            label="View"
            value="board"
            onChange={noop}
            options={[
              { value: 'board', label: 'Board', icon: 'tasks' },
              { value: 'list', label: 'List', icon: 'list' },
              { value: 'map', label: 'Map', icon: 'map' },
            ]}
          />
          <Segmented
            label="Scope"
            value="chat"
            onChange={noop}
            options={[
              { value: 'once', label: 'Once' },
              { value: 'chat', label: 'This chat' },
              { value: 'always', label: 'Always', disabled: true },
            ]}
          />
          <span data-force="hover" data-force-target=".fl-seg__item:not([aria-checked='true'])">
            <Segmented
              label="Mode"
              value="manual"
              onChange={noop}
              options={[
                { value: 'manual', label: 'Manual' },
                { value: 'edits', label: 'Edit automatically' },
                { value: 'auto', label: 'Auto', icon: 'bolt' },
              ]}
            />
          </span>
          <Segmented
            label="Touch"
            size="touch"
            value="a"
            onChange={noop}
            options={[
              { value: 'a', label: 'Chats' },
              { value: 'b', label: 'Inbox' },
            ]}
          />
        </div>
        <Matrix
          cols={['off', 'on', 'hover', 'focus', 'disabled', 'touch off', 'touch on']}
          rows={[
            [
              'toggle',
              [
                <Toggle checked={false} onChange={noop} label="Ultracode" />,
                <Toggle checked onChange={noop} label="Ultracode" />,
                <span data-force="hover" data-force-target=".fl-toggle">
                  <Toggle checked={false} onChange={noop} label="Ultracode" />
                </span>,
                <span data-force="focus-visible" data-force-target=".fl-toggle">
                  <Toggle checked onChange={noop} label="Ultracode" />
                </span>,
                <Toggle checked disabled onChange={noop} label="Ultracode" />,
                <Toggle checked={false} size="touch" onChange={noop} label="Fast" />,
                <Toggle checked size="touch" onChange={noop} label="Fast" />,
              ],
            ],
            [
              'checkbox',
              [
                <Checkbox checked={false} onChange={noop}>
                  Own worktree
                </Checkbox>,
                <Checkbox checked onChange={noop}>
                  Own worktree
                </Checkbox>,
                <Checkbox checked={false} indeterminate onChange={noop}>
                  Some
                </Checkbox>,
                <span data-force="focus-visible" data-force-target=".fl-check__box">
                  <Checkbox checked onChange={noop}>
                    Focused
                  </Checkbox>
                </span>,
                <Checkbox checked disabled onChange={noop}>
                  Disabled
                </Checkbox>,
                <span />,
                <span />,
              ],
            ],
          ]}
        />
        <div class="g-radios">
          <ChoiceRow selected label="Redis" desc="Shared across instances" kbd="1" onPick={noop} />
          <ChoiceRow selected={false} label="SQLite" desc="One file" kbd="2" onPick={noop} />
          <ChoiceRow multi selected label="Lint" kbd="3" onPick={noop} />
          <ChoiceRow multi selected={false} label="Type-check" kbd="4" onPick={noop} />
        </div>
        <div class="g-radios">
          <RadioRow name="g" checked onChange={noop} label="Redis" desc="Shared across instances" />
          <span data-force="hover" data-force-target=".fl-radio">
            <RadioRow name="g" checked={false} onChange={noop} label="SQLite" desc="One file" />
          </span>
          <RadioRow name="g" checked={false} onChange={noop} label="Memory" desc="Tests only" />
          <RadioRow name="g" checked={false} disabled onChange={noop} label="Postgres" desc="Not set up" />
        </div>
      </Section>

      <Section id="input" title="Input · Textarea · Search · Select" note="26 · r5 · focus: ring + 3px halo">
        <Matrix
          cols={['rest', 'hover', 'focus', 'invalid', 'disabled', 'sm 22', 'touch 44']}
          rows={[
            [
              'input',
              [
                <Input placeholder="Branch name" />,
                <Input placeholder="Branch name" data-force="hover" />,
                <Input value="feat/composer" data-force="focus" />,
                <Input value="feat composer" aria-invalid="true" />,
                <Input value="main" disabled />,
                <Input size="sm" placeholder="Filter" />,
                <Input size="touch" placeholder="Message…" />,
              ],
            ],
            [
              'select',
              [
                <button type="button" class="fl-select">
                  {selectTrigger('Opus 5.5')}
                </button>,
                <button type="button" class="fl-select" data-force="hover">
                  {selectTrigger('Opus 5.5')}
                </button>,
                <button type="button" class="fl-select" aria-expanded="true">
                  {selectTrigger('Opus 5.5')}
                </button>,
                <button type="button" class="fl-select">
                  {selectTrigger('')}
                </button>,
                <button type="button" class="fl-select" disabled>
                  {selectTrigger('High')}
                </button>,
                <button type="button" class="fl-select fl-select--sm">
                  {selectTrigger('Default')}
                </button>,
                <span />,
              ],
            ],
          ]}
        />
        <div class="g-cols3">
          <Search label="Search" value="" onInput={noop} placeholder="Search tasks, agents, branches" />
          <Search label="Search" value="formatCents" onInput={noop} />
          <Field label="Branch" help="Created from main">
            <Input value="claude/format-cents" />
          </Field>
          <Field label="Rule" error="A rule needs a command">
            <Input value="" aria-invalid="true" placeholder="npm test *" />
          </Field>
          <Textarea placeholder="Describe a task for an agent…" />
          <Textarea value={'Then run the format tests.\nAnd the e2e ones.'} data-force="focus" />
        </div>
      </Section>

      <Section id="menu" title="Menu · Popover · Tooltip" note="glass r8 · elevation 3 · rows inset 4, r4">
        <div class="g-line g-top-align">
          <div class="fl-menu g-static" role="menu" aria-label="More">
            <MenuItem icon="open" label="Open chat" onSelect={noop} />
            <MenuItem icon="diff" label="View changes" kbd="⌘D" onSelect={noop} />
            <div data-force="hover" data-force-target=".fl-menu__item" class="g-contents">
              <MenuItem icon="ask" label="Ask another agent…" onSelect={noop} />
            </div>
            <MenuItem icon="merge" label="Merge" disabled onSelect={noop} />
            <MenuSep />
            <MenuTitle>Hand off to</MenuTitle>
            <MenuItem icon="handoff" label="Codex" onSelect={noop} />
            <MenuSep />
            <MenuItem icon="trash" label="Delete chat" tone="error" onSelect={noop} />
          </div>
          <div class="fl-menu g-static" role="menu" aria-label="Scope">
            <MenuTitle end={<Kbd>Tab</Kbd>}>Allow</MenuTitle>
            <MenuItem label="Once" desc="Just this run" checked onSelect={noop} kbd="1" />
            <MenuItem label="For this chat" desc="npm test until the chat ends" checked={false} kbd="2" onSelect={noop} />
            <MenuItem label="Always" desc="npm test * in shop, every chat" checked={false} kbd="3" onSelect={noop} />
            <MenuSep />
            <MenuItem label="Manage permissions…" onSelect={noop} />
          </div>
          <div class="fl-menu g-static" role="menu" aria-label="Slash">
            <input class="fl-menu__filter" placeholder="Filter commands…" />
            <MenuTitle>Context</MenuTitle>
            <MenuItem icon="attach" label="Attach file" onSelect={noop} />
            <MenuItem icon="model" label="Switch model" end="Opus 5.5" onSelect={noop} />
            <div class="fl-menu__empty">No other commands</div>
          </div>
          <div class="g-stack">
            <span class="fl-tip g-static">Copy reply</span>
            <span class="fl-tip g-static">
              Send <Kbd>⏎</Kbd>
            </span>
            <span class="fl-tip g-static">Waiting for you: a command and an edit in Fix formatCents</span>
          </div>
        </div>
      </Section>

      <Section id="toast" title="Toast · Banner" note="toast: glass r8, elevation 3 · banner: inline r8, tone 8%">
        <div class="g-line g-top-align">
          <div class="g-stack">
            <Toast tone="success" title="Merged claude/format-cents" text="2 files into main" onClose={noop} />
            <Toast tone="info" title="Codex finished" text="Add CSV export to the reports page" action={{ label: 'Open', run: noop }} onClose={noop} />
            <div class="g-paused">
              <Toast tone="error" title="Claude's sign-in expired" text="Sign in again to keep working" action={{ label: 'Sign in', run: noop }} seconds={8} onClose={noop} />
            </div>
          </div>
          <div class="g-stack g-grow">
            <Banner>Ultracode is on for this chat.</Banner>
            <Banner tone="info" actions={<Button size="sm">Open map</Button>}>
              3 subagents are running.
            </Banner>
            <Banner tone="warn" actions={<Button size="sm">Review</Button>} onDismiss={noop}>
              Two chats changed src/format.ts; they clash when merged.
            </Banner>
            <Banner
              tone="error"
              actions={
                <Button size="sm" variant="primary">
                  Retry
                </Button>
              }
              onDismiss={noop}
            >
              The agent stopped: rate limited.
            </Banner>
            <Banner tone="success">All 5 tests passed.</Banner>
          </div>
        </div>
      </Section>

      <Section id="card" title="Card" note="r8 · 12 padding · inline / flat / raised · focus ring in the decision colour">
        <div class="g-cols3">
          {(
            [
              ['inline', {}],
              ['flat', { variant: 'flat' }],
              ['raised', { variant: 'raised' }],
              ['focused (the keys act on it)', { focus: true }],
              ['needs you', { tone: 'waiting' }],
              ['failed', { tone: 'error' }],
              ['ghost (a routine sentence row)', { variant: 'ghost' }],
              ['careful', { tone: 'careful' }],
              ['focused + careful', { focus: true, tone: 'careful' }],
            ] as const
          ).map(([name, p]) => (
            <Card {...p}>
              <CardHead icon="diff" title={`Changed 2 files · ${name}`} meta="3m" />
              <div class="fl-card__body">
                <Pill icon="file">format.ts</Pill> <Pill icon="file">format.test.ts</Pill>
              </div>
              <CardFoot>
                <Button size="sm" variant="quiet" kbd="Esc">
                  Deny
                </Button>
                <Button size="sm" variant="primary" kbd="⏎">
                  Allow once
                </Button>
              </CardFoot>
            </Card>
          ))}
        </div>
      </Section>

      <Section id="dialog" title="Dialog · Sheet" note="glass, elevation 4, over the 75% overlay · sheet r12 top">
        <div class="g-overlay">
          <div class="fl-dialog g-static" role="dialog" aria-label="Discard changes">
            <div class="fl-dialog__head">
              <div>
                <h2 class="fl-dialog__title">Discard this chat's changes?</h2>
                <div class="fl-dialog__sub">2 files go back to how they were before the turn.</div>
              </div>
              <IconButton icon="close" label="Close" size="sm" muted />
            </div>
            <div>Your own edits since then stay.</div>
            <div class="fl-dialog__foot">
              <Button variant="quiet" data-force="focus-visible">
                Cancel
              </Button>
              <Button variant="danger">Discard</Button>
            </div>
          </div>
          <div class="fl-sheet g-static g-sheet" role="dialog" aria-label="Details">
            <span class="fl-sheet__handle" />
            <CardHead icon="terminal" title="Run npm test" meta="waiting 7m" />
            <div class="fl-code">$ npm test</div>
            <div class="g-line">
              <Button variant="primary" size="touch" kbd="⏎">
                Allow once
              </Button>
              <Button variant="quiet" size="touch">
                Deny
              </Button>
            </div>
          </div>
        </div>
      </Section>

      <Section id="tabs" title="Tabs · List row · Tree row · Table" note="tabs r5 26 · rows r4 26">
        <div class="fl-tabs" role="tablist" aria-label="Chats">
          <Tab selected onSelect={noop} onClose={noop}>
            <AgentMark agent="claude" />
            <span class="fl-tab__label">Fix formatCents for negative amounts</span>
            <span class="fl-dot" data-state="needs-you" />
          </Tab>
          <Tab selected={false} onSelect={noop} onClose={noop}>
            <AgentMark agent="codex" />
            <span class="fl-tab__label">Add CSV export</span>
            <span class="fl-dot" data-state="working" data-still="" />
          </Tab>
          <span data-force="hover" data-force-target=".fl-tab" class="g-contents">
            <Tab selected={false} onSelect={noop} onClose={noop}>
              <AgentMark agent="gemini" />
              <span class="fl-tab__label">Speed up the search query (hover)</span>
            </Tab>
          </span>
        </div>
        <Tabs
          label="Images"
          value="all"
          onChange={noop}
          tabs={[
            { value: 'all', label: 'All', icon: 'grid', count: 24 },
            { value: 'a', label: 'Fix formatCents for negative amounts', count: 3 },
            { value: 'b', label: 'Add CSV export' },
            { value: 'c', label: 'Speed up the search query' },
          ]}
        />
        <div class="g-cols3">
          <div class="g-stack">
            <Row icon="file" meta="4m" onPress={noop}>
              Edit src/format.ts
            </Row>
            <span data-force="hover" data-force-target=".fl-row">
              <Row icon="terminal" meta="7m" onPress={noop}>
                Run npm test
              </Row>
            </span>
            <Row icon="terminal" meta="6m" selected onPress={noop}>
              Run npm test (selected)
            </Row>
            <span data-force="focus-visible" data-force-target=".fl-row">
              <Row icon="ask" meta="2m" onPress={noop}>
                Ask Gemini (focus)
              </Row>
            </span>
          </div>
          <div class="g-stack">
            <Row expanded onPress={noop} icon="list" level={1}>
              src
            </Row>
            <Row expanded onPress={noop} icon="list" level={2}>
              webview
            </Row>
            <Row onPress={noop} icon="file" level={3} meta="+3 −1">
              chat.tsx
            </Row>
            <Row onPress={noop} icon="file" level={3} selected>
              common.tsx
            </Row>
            <Row expanded={false} onPress={noop} icon="list" level={2}>
              host
            </Row>
          </div>
          <div class="fl-table-frame">
            <table class="fl-table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Where</th>
                  <th data-num>Uses</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>npm test *</code>
                  </td>
                  <td>shop</td>
                  <td data-num>12</td>
                </tr>
                <tr aria-selected="true">
                  <td>
                    <code>git status</code>
                  </td>
                  <td>every project</td>
                  <td data-num>48</td>
                </tr>
                <tr>
                  <td>Read ~/.ssh</td>
                  <td>never</td>
                  <td data-num>0</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <Section id="code" title="Code block · IN/OUT · Diff" note="code tone, r4, no border · tool body .5px r5">
        <div class="g-cols3">
          <pre class="fl-code">
            {"export const MODE_NAMES = { ask: 'Manual', plan: 'Plan' };\nconsole.log(MODE_NAMES.ask);"}
            <div class="fl-code__tools g-show">
              <IconButton icon="copy" label="Copy" size="sm" muted />
            </div>
          </pre>
          <div class="fl-io">
            <span class="fl-io__label">IN</span>
            <span class="fl-io__body">{'python3 - << EOF\nprint("hello")\nEOF'}</span>
            <span class="fl-io__label">OUT</span>
            <span class="fl-io__body" data-out="">
              Tests 5 passed (5)
            </span>
          </div>
          <div>
            <div class="fl-diff-stat">
              src/format.ts <span data-kind="add">+3</span>
              <span data-kind="del">−1</span>
            </div>
            <div class="fl-diff">
              {(
                [
                  ['12', ' ', 'export function formatCents(cents: number) {'],
                  ['13', '−', '  return `$${(cents / 100).toFixed(2)}`;', 'del'],
                  ['13', '+', "  const sign = cents < 0 ? '−' : '';", 'add'],
                  ['14', '+', '  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;', 'add'],
                  ['15', ' ', '}'],
                ] as const
              ).map(([n, sign, text, kind]) => (
                <div class="fl-diff__line" data-kind={kind}>
                  <span class="fl-diff__no">{n}</span>
                  <span class="fl-diff__sign">{sign}</span>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section id="small" title="Avatar · Agent mark · Status dot · Progress · Spinner · Countdown · Kbd · Divider" note="avatar radius = size ÷ 4">
        <div class="g-line">
          {(['claude', 'codex', 'gemini', 'demo'] as const).map((a) => (
            <>
              <Avatar agent={a} size="sm" />
              <Avatar agent={a} />
              <Avatar agent={a} size="lg" />
              <AgentMark agent={a} />
            </>
          ))}
          <AgentMark agent="other" />
          <Divider vertical />
          {['idle', 'working', 'needs-you', 'done', 'error'].map((s) => (
            <span class="g-chip">
              <span class="fl-dot" data-state={s} data-still="" /> {s}
            </span>
          ))}
          <span class="g-chip">
            <span class="fl-dot fl-dot--sm" data-state="working" data-still="" /> sm
          </span>
          <span class="g-chip">
            <span class="fl-dot" data-ring="" /> elsewhere
          </span>
        </div>
        <div class="g-cols3">
          <div class="g-stack">
            <Progress value={2} max={5} label="Plan" />
            <Progress label="Loading" />
            <div class="g-paused">
              <Countdown seconds={6} label="Auto-allows in 6s" />
            </div>
          </div>
          <div class="g-line">
            <Spinner size="sm" /> <Spinner /> <Spinner size="lg" />
            <Divider vertical />
            <Kbd>⌘</Kbd>
            <Kbd>⇧</Kbd>
            <Kbd>Tab</Kbd>
            <Kbd>Esc</Kbd>
            <span>
              Allow <Kbd inline>⏎</Kbd>
            </span>
          </div>
          <div>
            <div>Above the divider</div>
            <Divider />
            <div>Below the divider</div>
          </div>
        </div>
      </Section>

      <Section id="empty" title="Empty state">
        <div class="g-cols3">
          <Empty icon="tasks" title="No chats yet" actions={<Button variant="primary">New chat</Button>}>
            Start one per agent, or describe a task above.
          </Empty>
          <Empty icon="search" title="Nothing matches “formatCens”" actions={<Button variant="quiet">Clear the filter</Button>} />
          <Empty icon="grid" title="No images in this chat" />
        </div>
      </Section>

      <Section id="composer" title="Composer (frozen reference)" note="owner-approved: the + / icon buttons, pills, mode button, send and mic define the system">
        <div class="g-cols2">
          <ComposerReplica />
          <div data-force="focus-within" data-force-target=".composer">
            <ComposerReplica focused />
          </div>
        </div>
      </Section>
    </main>
  );
}

function SplitDemo({ force: f, open, disabled }: { force?: string; open?: boolean; disabled?: boolean }) {
  return (
    <span class="fl-split">
      <button type="button" class="fl-btn fl-btn--primary" data-force={f} disabled={disabled}>
        Allow once <kbd class="fl-kbd fl-kbd--inline">⏎</kbd>
      </button>
      <button type="button" class="fl-btn fl-btn--primary fl-btn--icon" aria-expanded={open ? 'true' : undefined} disabled={disabled} aria-label="Scope">
        <Icon name="chevronDown" />
      </button>
    </span>
  );
}

/** The composer's markup as chat.tsx draws it (cc-* classes), idle and focused. */
function ComposerReplica({ focused }: { focused?: boolean }) {
  return (
    <div class="composer" data-mode="ask">
      <div class="cc-chips">
        {['1356×958', '3420×2224'].map((m) => (
          <span class="cc-chip">
            <span class="cc-chip-name">image.png</span>
            <span class="cc-chip-meta">{m}</span>
            <button type="button" class="cc-chip-remove" aria-label="Remove">
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
      </div>
      <div class="cc-input">
        <textarea rows={1} placeholder="Message…" value={focused ? 'Make the gallery cover every state.' : ''} data-force={focused ? 'focus' : undefined} />
        <button type="button" class="cc-mic" aria-label="Dictate">
          <Icon name="mic" />
        </button>
      </div>
      <div class="composer-bar">
        <button type="button" class="cc-icon-btn" aria-label="Attach">
          <Icon name="plus" size={20} />
        </button>
        <button type="button" class="cc-icon-btn" aria-label="Commands">
          <Icon name="slash" size={20} />
        </button>
        <button type="button" class="cc-pill cc-agents">
          <span class="fl-dot" data-state="working" data-still="" /> 14 agents
        </button>
        <button type="button" class="cc-pill cc-model">
          <span class="cc-pill-text">Opus 5.5</span>
          <span class="cc-pill-sub">Low</span>
        </button>
        <span class="spacer" />
        <button type="button" class="cc-mode">
          <span class="cc-icon-box">
            <Icon name="hand" />
          </span>
          Manual
        </button>
        <button type="button" class="primary send-btn" aria-label="Send">
          <Icon name="up" size={20} />
        </button>
      </div>
    </div>
  );
}

render(<Gallery />, document.getElementById('root')!);
