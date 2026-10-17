// "Rewind to here": pick what to restore, see what it changes, decide each file
// you changed since, confirm. The editor's own menus and dialogs show it.
import type { RewindPlan } from './checkpoints';
import type { RewindMode } from './core';

export interface RewindHost {
  checkpointList(chatId: string): { turnId: string; text: string; at?: number; files: number }[];
  rewindPlan(chatId: string, turnId: string): Promise<RewindPlan>;
  rewind(chatId: string, turnId: string, mode: RewindMode, useCheckpoint: string[]): Promise<unknown>;
}

export interface RewindUi {
  /** One choice from a menu; undefined when dismissed. */
  pick<T>(title: string, items: { label: string; description?: string; detail?: string; value: T }[]): Promise<T | undefined>;
  /** A modal confirmation; true for `button`. */
  confirm(message: string, detail: string, button: string): Promise<boolean>;
  info(message: string): void;
}

const MODES: { label: string; detail: string; value: RewindMode }[] = [
  { label: 'Restore code and conversation', detail: 'Files go back to before this message, and the chat continues from here.', value: 'both' },
  { label: 'Restore code only', detail: 'Files go back to before this message; the conversation stays.', value: 'code' },
  { label: 'Restore conversation only', detail: 'The chat continues from here; files stay as they are.', value: 'conversation' },
];

export async function runRewind(host: RewindHost, ui: RewindUi, chatId: string, turnId?: string): Promise<boolean> {
  const list = host.checkpointList(chatId);
  if (!turnId) {
    if (!list.length) {
      ui.info('This chat has no checkpoints yet. Each message you send gets one before the agent changes anything.');
      return false;
    }
    turnId = await ui.pick(
      'Rewind chat to before…',
      [...list].reverse().map((c) => ({
        label: c.text.split('\n')[0].slice(0, 80) || '(message)',
        description: `${c.files} file${c.files === 1 ? '' : 's'} changed`,
        detail: c.at ? new Date(c.at).toLocaleString() : undefined,
        value: c.turnId,
      })),
    );
    if (!turnId) return false;
  }
  const mode = await ui.pick('Rewind to here', MODES);
  if (!mode) return false;
  const msg = list.find((c) => c.turnId === turnId);
  const quote = msg ? `“${msg.text.split('\n')[0].slice(0, 60)}”` : 'this message';
  const useCheckpoint: string[] = [];
  let summary = 'Files stay as they are.';
  if (mode !== 'conversation') {
    const plan = await host.rewindPlan(chatId, turnId);
    for (const f of plan.files.filter((f) => f.conflict)) {
      const choice = await ui.pick(`${f.file} changed after the agent's last turn`, [
        { label: 'Keep mine', detail: 'Leave the file as it is now.', value: 'mine' as const },
        { label: 'Use checkpoint', detail: `Put back the version from before ${quote} (+${f.added} −${f.removed}).`, value: 'checkpoint' as const },
      ]);
      if (!choice) return false;
      if (choice === 'checkpoint') useCheckpoint.push(f.file);
    }
    const restoring = plan.files.filter((f) => !f.conflict || useCheckpoint.includes(f.file));
    const added = restoring.reduce((s, f) => s + f.added, 0);
    const removed = restoring.reduce((s, f) => s + f.removed, 0);
    summary = restoring.length
      ? `${restoring.length} file${restoring.length === 1 ? '' : 's'}, +${added} −${removed}:\n${restoring.map((f) => `${f.file}  +${f.added} −${f.removed}`).join('\n')}`
      : 'No files need restoring.';
  }
  const convo = mode === 'code' ? '' : '\n\nEverything from this message on leaves the chat. The agent continues in a new session with a summary of the conversation up to here.';
  if (!(await ui.confirm(`Rewind to before ${quote}?`, summary + convo, 'Rewind'))) return false;
  await host.rewind(chatId, turnId, mode, useCheckpoint);
  return true;
}
