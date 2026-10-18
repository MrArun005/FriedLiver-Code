// Safety rules for the phone's approval UI, kept free of the DOM so they are tested.

/**
 * A row may offer ✓ and swipe-allow only when what would be approved is exactly what the row shows:
 * `full` is the whole text the request approves (a command), `shown` what the row prints, `truncated`
 * whether the row cut it off. Rows without approvable text (an agent request) show their whole title.
 */
export function rowShowsWhole(full: string | undefined, shown: string | undefined, truncated: boolean): boolean {
  if (truncated || shown === undefined || shown === '') return false;
  if (full === undefined) return true;
  return !full.includes('\n') && full === shown;
}

/** Which request an open sheet shows: its own, by id; or none, when it left the list or changed. */
export function sheetTarget(list: { id: string; sig: string }[], open: { id: string; sig: string }): { kind: 'ok'; index: number } | { kind: 'gone' } | { kind: 'changed' } {
  const index = list.findIndex((r) => r.id === open.id);
  if (index < 0) return { kind: 'gone' };
  return list[index].sig === open.sig ? { kind: 'ok', index } : { kind: 'changed' };
}

/** The request to offer after answering `answered`, from the order the list had at that moment. */
export function nextAfter(ids: string[], answered: string): string | undefined {
  const at = ids.indexOf(answered);
  const rest = ids.filter((id) => id !== answered);
  return rest[at] ?? rest[at - 1];
}
