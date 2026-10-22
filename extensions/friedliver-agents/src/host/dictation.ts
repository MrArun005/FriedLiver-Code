// The composer's mic on macOS: runs FriedLiver's own speech helper (native/friedliver-dictate.swift,
// bundled at bin/friedliver-dictate) and streams what it hears to the chat's message box.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import type { DictationState, DictationUpdate } from '../shared/dictation';

/** System Settings › Keyboard › Dictation: the old hint's link, kept for builds without the helper. */
export const DICTATION_SETTINGS = 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension';

/** The OS's own dictation settings the mic hint links to: macOS's, Windows's Speech page (Win+H), none elsewhere. */
export function dictationSettings(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === 'darwin' ? DICTATION_SETTINGS : platform === 'win32' ? 'ms-settings:speech' : undefined;
}

/** The privacy pane to open when macOS said no. */
export const PRIVACY_PANES = {
  'mic-denied': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  'speech-denied': 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition',
} as const;
export type DeniedCode = keyof typeof PRIVACY_PANES;

/** Characters one transcription may carry; the helper's words are cut there. */
export const MAX_SPOKEN = 10_000;
/** A longer stdout line than this is dropped unread. */
const MAX_LINE = 64 * 1024;
/** Loudness goes to the webview at most this often (30 a second); levels in between are dropped. */
export const LEVEL_MS = 33;
/** After asking the helper to stop, how long it gets to send its final words before it is killed. */
const STOP_GRACE_MS = 4000;

export type HelperEvent =
  | { kind: 'partial' | 'final'; text: string }
  | { kind: 'level'; level: number }
  | { kind: 'error'; code: DeniedCode | 'unavailable' | 'audio' | 'recognition'; message: string };

// Control characters (newlines and tabs aside) never reach the message box.
// eslint-disable-next-line no-control-regex
const clean = (s: string, max: number) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);

/** One stdout line from the helper, checked: anything else is ignored. */
export function parseHelperLine(line: string): HelperEvent | null {
  if (line.length > MAX_LINE) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.partial === 'string') return { kind: 'partial', text: clean(o.partial, MAX_SPOKEN) };
  if (typeof o.final === 'string') return { kind: 'final', text: clean(o.final, MAX_SPOKEN) };
  if (typeof o.level === 'number') return Number.isFinite(o.level) ? { kind: 'level', level: Math.min(1, Math.max(0, o.level)) } : null;
  if (typeof o.error === 'string') {
    const code = o.code === 'mic-denied' || o.code === 'speech-denied' || o.code === 'unavailable' || o.code === 'audio' ? o.code : 'recognition';
    return { kind: 'error', code, message: clean(o.error, 300) };
  }
  return null;
}

/**
 * The helper inside this extension's folder, which in the app is inside FriedLiver.app: never one
 * from PATH or the workspace. Undefined off macOS, and in builds without it (a dev build), where
 * the mic falls back to the Fn Fn hint.
 */
export function helperPath(extensionPath: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'darwin') return undefined;
  const file = path.join(extensionPath, 'bin', 'friedliver-dictate');
  try {
    if (!statSync(file).isFile()) return undefined;
    accessSync(file, constants.X_OK);
    return file;
  } catch {
    return undefined;
  }
}

const LOCALE = /^(auto|[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?)$/;

/** Arguments from `friedliver.voice.language` and `.silenceSeconds`; bad values become the defaults. */
export function helperArgs(language: unknown, silenceSeconds: unknown): string[] {
  const locale = typeof language === 'string' && LOCALE.test(language) ? language : 'auto';
  const silence = typeof silenceSeconds === 'number' && silenceSeconds >= 0.5 && silenceSeconds <= 10 ? silenceSeconds : 2.5;
  return ['--locale', locale, '--silence', String(silence), '--max', '60'];
}

export interface DictationDeps<S> {
  /** The helper's path, or undefined when there is none (see `helperPath`). */
  helper(): string | undefined;
  args(): string[];
  post(surface: S, chatId: string, update: DictationUpdate): void;
  /** macOS refused the microphone or speech recognition. */
  denied(code: DeniedCode): void;
  /** Dictation stopped for another reason. */
  failed(message: string): void;
  spawn?: typeof nodeSpawn;
  /** The clock levels are throttled by (tests set it). */
  now?: () => number;
}

/** One dictation at a time (there is one microphone): idle → listening → stopping → idle. */
export class Dictation<S> {
  state: DictationState = 'idle';
  private child: ChildProcess | undefined;
  private surface: S | undefined;
  private chatId = '';
  private killTimer: NodeJS.Timeout | undefined;
  private lastLevel = -Infinity;

  constructor(private readonly deps: DictationDeps<S>) {}

  start(surface: S, chatId: string): void {
    this.kill();
    const file = this.deps.helper();
    if (!file) {
      this.deps.post(surface, chatId, { state: 'fallback' });
      return;
    }
    const child = (this.deps.spawn ?? nodeSpawn)(file, this.deps.args(), { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    this.child = child;
    this.surface = surface;
    this.chatId = chatId;
    this.state = 'listening';
    this.lastLevel = -Infinity;
    this.post({ state: 'listening' });
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (this.child !== child) return;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      if (buffer.length > MAX_LINE) buffer = '';
      for (const line of lines) this.event(parseHelperLine(line));
    });
    child.stdin?.on('error', () => {});
    child.on('error', () => {
      // It couldn't run (removed or not executable since the check): the old hint instead.
      if (this.child !== child) return;
      this.finish();
      this.deps.post(surface, chatId, { state: 'fallback' });
    });
    child.on('exit', () => {
      if (this.child === child) this.finish();
    });
  }

  /** The mic clicked again, or Esc: the helper stops listening and sends its final words. */
  stop(chatId?: string): void {
    const child = this.child;
    if (!child || this.state !== 'listening' || (chatId && chatId !== this.chatId)) return;
    this.state = 'stopping';
    this.post({ state: 'stopping' });
    child.stdin?.end();
    child.kill('SIGTERM');
    this.killTimer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    this.killTimer.unref?.();
  }

  /** The chat view closed: stop at once, nothing more to show. */
  closed(surface: S): void {
    if (this.surface === surface) this.kill();
  }

  dispose(): void {
    this.kill();
  }

  private event(e: HelperEvent | null): void {
    if (!e) return;
    if (e.kind === 'level') {
      // Only while listening, for the one chat dictating, and at most every LEVEL_MS.
      const now = (this.deps.now ?? Date.now)();
      if (this.state !== 'listening' || now - this.lastLevel < LEVEL_MS) return;
      this.lastLevel = now;
      this.post({ level: e.level });
      return;
    }
    if (e.kind !== 'error') {
      this.post({ text: e.text, final: e.kind === 'final' });
      return;
    }
    if (e.code === 'mic-denied' || e.code === 'speech-denied') this.deps.denied(e.code);
    else this.deps.failed(e.message);
  }

  private post(update: DictationUpdate): void {
    if (this.surface !== undefined) this.deps.post(this.surface, this.chatId, update);
  }

  /** The helper exited: the mic goes back to idle. */
  private finish(): void {
    clearTimeout(this.killTimer);
    this.post({ state: 'idle' });
    this.child = undefined;
    this.surface = undefined;
    this.state = 'idle';
  }

  private kill(): void {
    const child = this.child;
    if (!child) return;
    this.finish();
    child.stdin?.destroy();
    child.kill('SIGKILL');
  }
}
