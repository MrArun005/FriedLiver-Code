// Code references from the editor: "format.ts:12–18" chips on a message and
// in the composer. A click opens those lines.
import type { CodeRef } from '../shared/model';
import { relativePath } from '../shared/view';
import { Icon, basename, send } from './common';

const line = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1;

/** Well-formed references only: a saved chat is read back as it was written. */
export function refsOf(item: { refs?: unknown }): CodeRef[] {
  if (!Array.isArray(item.refs)) return [];
  return item.refs.filter((r): r is CodeRef => !!r && typeof r.path === 'string' && line(r.startLine) && line(r.endLine) && r.endLine >= r.startLine);
}

export function sameRef(a: CodeRef, b: CodeRef): boolean {
  return a.path === b.path && a.startLine === b.startLine && a.endLine === b.endLine;
}

function lines(r: CodeRef): string {
  return r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}–${r.endLine}`;
}

/** `codeRef`, not `ref`: Preact keeps `ref` for itself. */
export function RefChip({ codeRef, cwd, onRemove }: { codeRef: CodeRef; cwd: string; onRemove?: () => void }) {
  const label = `${basename(codeRef.path)}:${lines(codeRef)}`;
  const where = `${relativePath(cwd, codeRef.path)}, ${codeRef.startLine === codeRef.endLine ? 'line' : 'lines'} ${lines(codeRef)}`;
  return (
    <span class="code-ref">
      <button
        class="ref"
        title={`${where}: open`}
        onClick={() => send({ type: 'openFile', path: codeRef.path, line: codeRef.startLine, endLine: codeRef.endLine })}
      >
        <Icon name="code" />
        {label}
      </button>
      {onRemove && (
        <button type="button" class="fl-pill__x badge-x" aria-label={`Remove ${label}`} title="Remove" onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

export function RefList({ refs, cwd, onRemove }: { refs: CodeRef[]; cwd: string; onRemove?: (r: CodeRef) => void }) {
  if (!refs.length) return null;
  return (
    <div class="refs" aria-label="Code references">
      {refs.map((r) => (
        <RefChip key={`${r.path}:${r.startLine}-${r.endLine}`} codeRef={r} cwd={cwd} onRemove={onRemove && (() => onRemove(r))} />
      ))}
    </div>
  );
}
