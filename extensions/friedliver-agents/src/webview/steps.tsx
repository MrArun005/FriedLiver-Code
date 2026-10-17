// The timeline of a turn's tool calls. Each step is one line: its state, a
// verb, a short summary, the files and the kind. Opening it shows what it did
// in a form you can use: the whole command as it ran, its folder, exit code and
// time, its output, the file a heredoc wrote, and Copy, Run in terminal and
// Open file.
import { useMemo, useState } from 'preact/hooks';
import { langOf } from '../shared/highlight';
import { formatDuration, type Item } from '../shared/model';
import { heredocOf, inFolder, isShell, stepOutput, stepSummary, typeable, type Approval, type Heredoc } from '../shared/steps';
import type { ToolOut } from '../shared/tools';
import { Code, CopyButton, Dot, Icon, RunButton, basename, memo, send } from './common';
import { DiffView } from './controls';

export type ToolItem = Extract<Item, { kind: 'tool' }>;

const TOOL_STATE: Record<string, string> = { completed: 'done', in_progress: 'working', failed: 'error', pending: 'next' };
/** Output lines shown before "Show all". */
const OUTPUT_LINES = 14;

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
  return (
    <ol class="steps" aria-label="Steps">
      {tools.map((t) => {
        const state = waiting.has(t.id) ? 'needs-you' : (TOOL_STATE[t.status ?? 'pending'] ?? 'next');
        const isOpen = open[t.id] ?? (t.status === 'failed' && !!t.out?.some((o) => o.t === 'text'));
        return <Step key={t.id} tool={t} approval={approvals?.[t.id]} state={state} still={!busy} open={isOpen} onToggle={() => setOpen({ ...open, [t.id]: !isOpen })} chatId={chatId} cwd={cwd} />;
      })}
    </ol>
  );
}

function Step({ tool: t, approval, state, still, open, onToggle, chatId, cwd }: { tool: ToolItem; approval?: Approval; state: string; still: boolean; open: boolean; onToggle(): void; chatId: string; cwd: string }) {
  const s = useMemo(() => stepSummary(t), [t.title, t.toolKind, t.cmd]);
  const more = hasDetails(t);
  const id = `step-${t.id}`;
  const exit = t.exit ?? exitInOutput(t.out);
  const head = (
    <>
      <span class="step-verb">{s.verb}</span>
      <span class={`step-text${s.mono ? ' mono' : ''}`}>{s.text}</span>
      {s.lines && <span class="step-lines">{s.lines} lines</span>}
    </>
  );
  // Hovering shows the whole title or command; the summary is cut to one line.
  const tip = t.about ? `${t.about}\n\n${s.full}` : s.full;
  return (
    <li id={`item-${t.id}`} data-state={state} data-open={open ? '' : undefined}>
      <div class="step-row">
        <Dot state={state} still={still} />
        {more ? (
          <button type="button" class="step-main" title={tip} aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
            {head}
          </button>
        ) : (
          <span class="step-main" title={tip}>
            {head}
          </span>
        )}
        {t.locations.length > 0 && (
          <span class="step-files">
            {t.locations.slice(0, 3).map((l) => (
              <button key={l} class="ref" title={l} onClick={() => send({ type: 'openFile', path: l })}>
                {basename(l)}
              </button>
            ))}
          </span>
        )}
        <span class="step-end">
          {exit !== undefined && exit !== 0 && <span class="tag bad">exit {exit}</span>}
          {approval && <span class={`tag${approval.ok ? ' ok' : ' bad'}`}>{approval.text}</span>}
          {t.toolKind && t.toolKind !== 'other' && <span class="tag">{t.toolKind}</span>}
          {/* The slot stays without details too, so the kinds line up. */}
          <span class="step-chevron" aria-hidden="true" onClick={more ? onToggle : undefined}>
            {more && <Icon name="chevron" />}
          </span>
        </span>
      </div>
      {more && open && <StepDetails id={id} tool={t} chatId={chatId} cwd={cwd} />}
    </li>
  );
}

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
  const [showInput, setShowInput] = useState(false);
  const cmd = t.cmd;
  const doc = useMemo(() => (cmd && isShell(t) ? heredocOf(cmd.line) : undefined), [cmd?.line, t.toolKind]);
  const outs = (t.out ?? []).filter((o): o is Exclude<ToolOut, { t: 'terminal' }> => o.t !== 'terminal');
  const texts = outs.filter((o): o is Extract<ToolOut, { t: 'text' }> => o.t === 'text').map((o) => stepOutput(o.text));
  const exit = t.exit ?? texts.find((o) => o.exit !== undefined)?.exit;
  const dir = cmd?.cwd ?? stepSummary(t).dir;
  const meta = [
    exit !== undefined ? `exit ${exit}` : t.status === 'failed' ? 'failed' : t.status === 'in_progress' ? 'running…' : undefined,
    t.ms !== undefined ? formatDuration(t.ms) : undefined,
  ].filter(Boolean);
  const runnable = cmd && !cmd.cut && isShell(t) && typeable(cmd.line);
  // A command's input is the command: "Show input" only for other tools.
  const input = !cmd && t.input;
  return (
    <div class="step-details" id={id}>
      {t.about && <div class="step-about">{t.about}</div>}
      {/* A heredoc write: the file it writes first, then the command around it. */}
      {doc?.file && <HeredocFile doc={doc} cwd={cwd} />}
      {cmd && (
        <section class="code-block step-command" aria-label="Command">
          <div class="code-head">
            <span class="code-lang">command</span>
            {dir && (
              <span class="hint mono step-dir" title={dir}>
                in {folderLabel(dir, cwd)}
              </span>
            )}
            {meta.length > 0 && <span class={`hint step-meta${exit ? ' bad' : ''}`}>{meta.join(' · ')}</span>}
            <span class="spacer" />
            {runnable && <RunButton chatId={chatId} command={cmd.line} cwd={cmd.cwd} />}
            <CopyButton text={cmd.line} label="Copy command" />
          </div>
          <Code code={cmd.line} lang="sh" class={doc?.file ? 'scroll short' : 'scroll'} />
          {cmd.cut && <div class="hint step-cut">The command is longer than the chat keeps; this is its start.</div>}
        </section>
      )}
      {texts.map((o, n) => (
        <Output key={`t${n}`} text={o.text} lang={o.lang} />
      ))}
      {outs.map((o, n) =>
        o.t === 'diff' ? (
          <div key={`d${n}`} class="file-change">
            <div class="file-line">
              <button class="ref" title={o.path} onClick={() => send({ type: 'openFile', path: o.path })}>
                {basename(o.path)}
              </button>
              <span class="stats">
                <span class="plus">+{o.added}</span> <span class="minus">−{o.removed}</span>
              </span>
            </div>
            {o.lines.length > 0 && <DiffView lines={o.lines} more={o.more} />}
          </div>
        ) : null,
      )}
      {input && (
        <>
          <button class="link sm-link" aria-expanded={showInput} onClick={() => setShowInput(!showInput)}>
            {showInput ? 'Hide input' : 'Show input'}
          </button>
          {showInput && <Code code={input} lang="json" class="scroll step-input" />}
        </>
      )}
    </div>
  );
}

/** The file a heredoc writes, as a code block named after it. */
function HeredocFile({ doc, cwd }: { doc: Heredoc; cwd: string }) {
  const file = doc.file!;
  const inside = inFolder(cwd, file);
  const lines = doc.body ? doc.body.split('\n').length : 0;
  return (
    <section class="code-block step-file" aria-label={`Written to ${basename(file)}`}>
      <div class="code-head">
        <span class="code-lang file-name" title={file}>
          <Icon name="file" /> {basename(file)}
        </span>
        <span class="hint">
          {doc.append ? 'appended' : 'written'} · {lines} line{lines === 1 ? '' : 's'}
          {doc.closed ? '' : ' · not closed'}
        </span>
        <span class="spacer" />
        {inside && (
          <button type="button" class="ghost sm" title={`Open ${inside}`} onClick={() => send({ type: 'openFile', path: inside })}>
            <Icon name="open" /> Open file
          </button>
        )}
        <CopyButton text={doc.body} label="Copy file text" />
      </div>
      <Code code={doc.body} lang={langOf(file)} class="scroll" />
    </section>
  );
}

/** A step's output: monospace, its first lines until you ask for all of it. */
function Output({ text, lang }: { text: string; lang?: string }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n').length, [text]);
  const long = lines > OUTPUT_LINES;
  if (!text.trim()) return null;
  return (
    <section class="code-block step-output" aria-label="Output">
      <div class="code-head">
        <span class="code-lang">output</span>
        <span class="hint">
          {lines} line{lines === 1 ? '' : 's'}
          {text.startsWith('…\n') ? ' · the end of it' : ''}
        </span>
        <span class="spacer" />
        <CopyButton text={text} label="Copy output" />
      </div>
      <Code code={text} lang={lang && lang !== 'console' ? lang : ''} class={`scroll${long && !all ? ' capped' : ''}`} />
      {long && (
        <button class="link sm-link" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${lines} lines`}
        </button>
      )}
    </section>
  );
}
