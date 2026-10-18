// A turn's tool calls on the transcript's timeline: each step is one line, a
// dot for its state, the tool in bold and its target. Opening it shows an
// IN/OUT body: the command as it ran (or the tool's input), its output, the
// file a heredoc wrote and the diffs, each clipped to a few lines until asked,
// with Copy, Run in terminal and Open file on hover.
import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { langOf } from '../shared/highlight';
import { formatDuration, type Item } from '../shared/model';
import { shortDuration, stepsHeading } from '../shared/view';
import { heredocOf, inFolder, isShell, stepOutput, stepSummary, typeable, type Approval, type Heredoc } from '../shared/steps';
import type { ToolOut } from '../shared/tools';
import { Code, CopyButton, Icon, ImageThumb, RunButton, basename, memo, send } from './common';
import { stepImage } from '../shared/stepImages';
import { DiffView } from './controls';
import { Button, IconButton } from './ui';

export type ToolItem = Extract<Item, { kind: 'tool' }>;

const TOOL_STATE: Record<string, string> = { completed: 'done', in_progress: 'working', failed: 'error', pending: 'next' };
/** A run of at least this many steps gets a heading that folds it. */
const FOLD_AT = 6;

/** Whether a step has anything to open. */
export const hasDetails = (t: ToolItem) => !!t.input || !!t.cmd || !!t.about || !!t.out?.some((o) => o.t !== 'terminal');

/**
 * `busy`: the chat's turn is running; a step left in progress after it ends doesn't pulse.
 * `chatId` and `cwd`: the chat, for Run in terminal and for opening files in its folder.
 */
export type StepsProps = { tools: ToolItem[]; approvals?: Record<string, Approval>; waiting: Set<string>; waitingKey: string; busy: boolean; chatId: string; cwd: string };

/** A run of tool calls; drawn again when one of them or the questions about them change. */
export const Steps = memo(
  StepsView,
  (a: StepsProps, b: StepsProps) =>
    a.waitingKey === b.waitingKey &&
    a.busy === b.busy &&
    a.chatId === b.chatId &&
    a.cwd === b.cwd &&
    a.tools.length === b.tools.length &&
    a.tools.every((t, n) => t === b.tools[n] && a.approvals?.[t.id]?.text === b.approvals?.[t.id]?.text),
);

function StepsView({ tools, approvals, waiting, busy, chatId, cwd }: StepsProps) {
  // Failed steps show their output; the others open on request.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // A long run of steps can fold to its heading.
  const [folded, setFolded] = useState(false);
  const foldable = tools.length >= FOLD_AT;
  return (
    <>
      {foldable && (
        <div class="tl tl-group" data-state="done">
          <button type="button" class="tl-group-btn" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
            <Icon name="chevron" />
            <span class="tl-group-label">{stepsHeading(tools)}</span>
          </button>
        </div>
      )}
      {!(foldable && folded) &&
        tools.map((t) => {
          const state = waiting.has(t.id) ? 'needs-you' : (TOOL_STATE[t.status ?? 'pending'] ?? 'next');
          const isOpen = open[t.id] ?? (t.status === 'failed' && !!t.out?.some((o) => o.t === 'text'));
          return <Step key={t.id} tool={t} approval={approvals?.[t.id]} state={state} still={!busy} open={isOpen} onToggle={() => setOpen({ ...open, [t.id]: !isOpen })} chatId={chatId} cwd={cwd} />;
        })}
    </>
  );
}

function Step({ tool: t, approval, state, still, open, onToggle, chatId, cwd }: { tool: ToolItem; approval?: Approval; state: string; still: boolean; open: boolean; onToggle(): void; chatId: string; cwd: string }) {
  const s = useMemo(() => stepSummary(t), [t.title, t.toolKind, t.cmd, t.input]);
  const more = hasDetails(t);
  const id = `step-${t.id}`;
  const exit = t.exit ?? exitInOutput(t.out);
  const file = t.locations[0];
  const image = useMemo(() => stepImage(t), [t.locations, t.out, t.about]);
  const denied = !!approval && !approval.ok;
  const head = (
    <>
      <span class="step-verb">{s.verb}</span>
      <span
        class={`step-text${s.mono ? ' mono' : ''}${file ? ' step-target' : ''}`}
        title={file}
        onClick={
          file
            ? (e) => {
                // The path is the link: it opens the file (an edit's diff shows in the review), the row's other parts expand.
                e.stopPropagation();
                send({ type: 'openFile', path: file });
              }
            : undefined
        }
      >
        {s.text}
      </span>
      {s.lines && <span class="step-lines">{s.lines} lines</span>}
    </>
  );
  // Hovering shows the whole title or command; the summary is cut to one line.
  const tip = t.about ? `${t.about}\n\n${s.full}` : s.full;
  const dot = denied ? 'denied' : state === 'working' && still ? 'stalled' : exit ? 'error' : state;
  return (
    <div class="tl tl-step" id={`item-${t.id}`} data-state={dot} data-open={open ? '' : undefined} role="group" aria-label={`${s.verb} ${s.text}: ${DOT_WORDS[dot] ?? dot}`}>
      <div class="step-row">
        {more ? (
          <button type="button" class="step-main" title={tip} aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
            {head}
          </button>
        ) : (
          <span class="step-main" title={tip}>
            {head}
          </span>
        )}
        <span class="step-end">
          {exit !== undefined && exit !== 0 && <span class="tag bad">exit {exit}</span>}
          {denied && <span class="step-denied">denied</span>}
          {t.ms !== undefined && <span class="step-time">{shortDuration(t.ms)}</span>}
        </span>
      </div>
      {image && (
        <div class="step-image">
          <ImageThumb path={image.path} title={image.title} />
        </div>
      )}
      {more && open && <StepDetails id={id} tool={t} chatId={chatId} cwd={cwd} />}
    </div>
  );
}

const DOT_WORDS: Record<string, string> = { done: 'done', error: 'failed', denied: 'denied', working: 'running', stalled: 'stopped', 'needs-you': 'needs you', next: 'next' };

function exitInOutput(out: ToolOut[] | undefined): number | undefined {
  const text = out?.find((o): o is Extract<ToolOut, { t: 'text' }> => o.t === 'text');
  return text ? stepOutput(text.text).exit : undefined;
}

/** A folder for display: under the chat's folder relative to it, otherwise as it is. */
function folderLabel(dir: string, cwd: string): string {
  if (dir === cwd) return basename(cwd);
  return dir.startsWith(`${cwd}/`) || dir.startsWith(`${cwd}\\`) ? dir.slice(cwd.length + 1) : dir;
}

function StepDetails({ id, tool: t, chatId, cwd }: { id: string; tool: ToolItem; chatId: string; cwd: string }) {
  const cmd = t.cmd;
  const doc = useMemo(() => (cmd && isShell(t) ? heredocOf(cmd.line) : undefined), [cmd?.line, t.toolKind]);
  const outs = (t.out ?? []).filter((o): o is Exclude<ToolOut, { t: 'terminal' }> => o.t !== 'terminal');
  const texts = outs.filter((o): o is Extract<ToolOut, { t: 'text' }> => o.t === 'text').map((o) => stepOutput(o.text));
  const exit = t.exit ?? texts.find((o) => o.exit !== undefined)?.exit;
  const dir = cmd?.cwd ?? stepSummary(t).dir;
  const meta = [
    dir ? `in ${folderLabel(dir, cwd)}` : undefined,
    exit !== undefined ? `exit ${exit}` : t.status === 'failed' ? 'failed' : t.status === 'in_progress' ? 'running…' : undefined,
    t.ms !== undefined ? formatDuration(t.ms) : undefined,
  ].filter(Boolean);
  const runnable = cmd && !cmd.cut && isShell(t) && typeable(cmd.line);
  // A command's input is the command; other tools show their raw input.
  const input = !cmd && t.input;
  return (
    <div class="tool-body-wrap" id={id}>
      {t.about && <div class="step-about">{t.about}</div>}
      <div class="tool-body">
        {/* A heredoc write: the file it writes first, then the command around it. */}
        {doc?.file && <HeredocFile doc={doc} cwd={cwd} />}
        {cmd && (
          <ToolRow label="IN" class="step-command" aria-label="Command" text={cmd.line} lang="sh" tools={
            <>
              {meta.length > 0 && <span class={`tool-meta${exit ? ' bad' : ''}`}>{meta.join(' · ')}</span>}
              {runnable && <RunButton chatId={chatId} command={cmd.line} cwd={cmd.cwd} />}
              <CopyButton text={cmd.line} label="Copy command" />
            </>
          }>
            {cmd.cut && <div class="hint step-cut">The command is longer than the chat keeps; this is its start.</div>}
          </ToolRow>
        )}
        {input && <ToolRow label="IN" class="step-input" aria-label="Input" text={input} lang="json" />}
        {texts.map((o, n) => (o.text.trim() ? <ToolRow key={`t${n}`} label="OUT" class="step-output" aria-label="Output" text={o.text} lang={o.lang && o.lang !== 'console' ? o.lang : ''} out tools={<CopyButton text={o.text} label="Copy output" />} /> : null))}
        {outs.map((o, n) =>
          o.t === 'diff' ? (
            <div key={`d${n}`} class="tool-row file-change">
              <span class="tool-label">DIFF</span>
              <div class="tool-cell">
                <div class="file-line">
                  <button class="ref" title={o.path} onClick={() => send({ type: 'openFile', path: o.path })}>
                    {basename(o.path)}
                  </button>
                  <span class="stats">
                    <span class="plus">+{o.added}</span>
                    <span class="minus">−{o.removed}</span>
                  </span>
                </div>
                {o.lines.length > 0 && <DiffView lines={o.lines} more={o.more} />}
              </div>
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

/** Rows over this many lines start clipped to the first few, with Show all. */
const CLAMP_LINES = 3;

/** One IN/OUT row: its label, its text (clipped past three lines), and copy/run on hover. */
/** One IN/OUT/FILE row: its text wraps (QA: long lines don't run off), opens in an editor tab, and has its own tools. */
function ToolRow({ label, class: className, text, lang, out, tools, children, ...rest }: { label: string; class: string; text: string; lang: string; out?: boolean; tools?: ComponentChildren; children?: ComponentChildren; 'aria-label': string }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n').length, [text]);
  const long = lines > CLAMP_LINES;
  return (
    <section class={`tool-row ${className}${out ? ' out' : ''}`} aria-label={rest['aria-label']}>
      <span class="tool-label">{label}</span>
      <div class="tool-cell">
        <Code code={text} lang={lang} class={long && !all ? 'capped' : ''} />
        {long && (
          <Button variant="link" size="sm" class="sm-link" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? 'Show less' : `Show all ${lines} lines`}
          </Button>
        )}
        {children}
        <span class="tool-tools">
          {tools}
          <IconButton icon="open" label="Open in editor" title="Open in an editor tab (long lines wrap)" size="sm" variant="secondary" muted onClick={() => send({ type: 'openText', text })} />
        </span>
      </div>
    </section>
  );
}

/** The file a heredoc writes, as a code block named after it. */
function HeredocFile({ doc, cwd }: { doc: Heredoc; cwd: string }) {
  const file = doc.file!;
  const inside = inFolder(cwd, file);
  const lines = doc.body ? doc.body.split('\n').length : 0;
  return (
    <ToolRow label="FILE" class="step-file" aria-label={`Written to ${basename(file)}`} text={doc.body} lang={langOf(file)} tools={
      <>
        {inside && (
          <Button variant="secondary" size="sm" title={`Open ${inside}`} onClick={() => send({ type: 'openFile', path: inside })}>
            Open file
          </Button>
        )}
        <CopyButton text={doc.body} label="Copy file text" />
      </>
    }>
      <div class="tool-file">
        <span class="file-name" title={file}>
          {basename(file)}
        </span>{' '}
        {doc.append ? 'appended' : 'written'} · {lines} line{lines === 1 ? '' : 's'}
        {doc.closed ? '' : ' · not closed'}
      </div>
    </ToolRow>
  );
}
