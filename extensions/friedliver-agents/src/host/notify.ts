// Text that reaches VS Code notifications from agents, git or a repository.
import { shortCommand } from '../shared/model';

/**
 * Makes text from an agent, git or a repository safe for a VS Code
 * notification. Notifications turn `[label](command:…)` into a link that runs
 * any editor command (VS Code opens them with commands allowed), so such text
 * must not form a link, nor reword one of FriedLiver's own. Square brackets
 * become their full-width look-alikes, which no link syntax matches.
 */
export function plainText(text: string): string {
  return text.replace(/\[/g, '\uff3b').replace(/\]/g, '\uff3d');
}

/**
 * How a command shows in its notification, and whether Run may be offered
 * there. Only when the notification shows the whole command exactly as it will
 * run: shortened commands (absolute paths cut to the program's name, long lines
 * cut off), multi-line ones and ones with brackets are approved in the chat,
 * where they show in full.
 */
export function commandNotice(commandLine: string): { text: string; runnable: boolean } {
  const short = shortCommand(commandLine);
  return { text: plainText(short), runnable: short === commandLine && !/[[\]\r\n]/.test(commandLine) };
}
