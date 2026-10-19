import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { newFileFromPatch, writePatchedFile } from './patchedFile';
import { TOKENS_SOURCE, definedTokens, workbenchTokens } from '../scripts/workbench-tokens.mjs';

// The rules patch 0300 adds to VS Code's integrated browser: what a downloaded file is called, that
// it never overwrites, which sources may download, which files the list never opens, and the
// state machine every download goes through.
type State = 'awaiting' | 'progressing' | 'completed' | 'cancelled' | 'failed';
type Download = { state: State; waitingFor?: 'agent' | 'large'; receivedBytes: number; totalBytes: number; bytesPerSecond: number; error?: string };
let m: {
  LARGE_DOWNLOAD_BYTES: number;
  sanitizeFilename(raw: string, fallback?: string): string;
  splitExtension(name: string): { stem: string; ext: string };
  uniqueFilename(name: string, taken: (c: string) => boolean): string;
  isAllowedDownloadUrl(url: string): boolean;
  isExecutableName(name: string): boolean;
  expandHome(path: string, home: string): string;
  formatBytes(n: number): string;
  describeDownload(d: Download): string;
  downloadProgress(d: Pick<Download, 'state' | 'receivedBytes' | 'totalBytes'>): number | undefined;
  nextDownloadState(s: State, e: 'approve' | 'cancel' | 'complete' | 'fail'): State | undefined;
  isDownloadFinished(s: State): boolean;
  canRetryDownload(s: State): boolean;
  canCancelDownload(s: State): boolean;
  needsSizeConfirm(total: number): boolean;
  pruneDownloads<T extends { state: State }>(list: T[], max?: number): T[];
};

const PATCH = '0300-browser-downloads.patch';

beforeAll(async () => {
  m = await import(writePatchedFile(PATCH, 'src/vs/platform/browserView/common/browserDownloads.ts'));
});

describe('sanitizeFilename', () => {
  it('keeps an ordinary name', () => {
    expect(m.sanitizeFilename('report-2026.pdf')).toBe('report-2026.pdf');
    expect(m.sanitizeFilename('My File (final).tar.gz')).toBe('My File (final).tar.gz');
    expect(m.sanitizeFilename('résumé 日本.txt')).toBe('résumé 日本.txt');
  });

  it('keeps only the last path segment, so no name walks out of the folder', () => {
    expect(m.sanitizeFilename('../../.ssh/authorized_keys')).toBe('authorized_keys');
    expect(m.sanitizeFilename('..\\..\\Windows\\system32\\evil.dll')).toBe('evil.dll');
    expect(m.sanitizeFilename('/etc/passwd')).toBe('passwd');
    expect(m.sanitizeFilename('a/b/')).toBe('download');
    expect(m.sanitizeFilename('..')).toBe('download');
    expect(m.sanitizeFilename('.')).toBe('download');
  });

  it('never makes a hidden file: leading dots and spaces go', () => {
    expect(m.sanitizeFilename('.bashrc')).toBe('bashrc');
    expect(m.sanitizeFilename('...zshrc')).toBe('zshrc');
    expect(m.sanitizeFilename(' . .profile')).toBe('profile');
  });

  it('drops control, invisible and direction characters', () => {
    expect(m.sanitizeFilename('in\u0000voice\n.pdf')).toBe('invoice.pdf');
    // RIGHT-TO-LEFT OVERRIDE: "photo\u202egpj.exe" would show as "photoexe.jpg".
    expect(m.sanitizeFilename('photo\u202egpj.exe')).toBe('photogpj.exe');
    expect(m.sanitizeFilename('a\u200bb\ufeff.txt')).toBe('ab.txt');
    expect(m.sanitizeFilename('\u0007\u001b')).toBe('download');
  });

  it('replaces characters Windows refuses and trailing dots and spaces', () => {
    expect(m.sanitizeFilename('what? <now>: "x" | y*.txt')).toBe('what_ _now__ _x_ _ y_.txt');
    expect(m.sanitizeFilename('name.txt. . ')).toBe('name.txt');
  });

  it('renames Windows device names', () => {
    expect(m.sanitizeFilename('CON')).toBe('_CON');
    expect(m.sanitizeFilename('nul.txt')).toBe('_nul.txt');
    expect(m.sanitizeFilename('com1.log')).toBe('_com1.log');
    expect(m.sanitizeFilename('console.txt')).toBe('console.txt');
  });

  it('caps the length at 200 and keeps the extension', () => {
    const long = `${'a'.repeat(300)}.tar.gz`;
    const out = m.sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('.tar.gz')).toBe(true);
  });

  it('uses the fallback for an empty name', () => {
    expect(m.sanitizeFilename('')).toBe('download');
    expect(m.sanitizeFilename('   ', 'file')).toBe('file');
  });
});

describe('uniqueFilename', () => {
  const taken = (names: string[]) => (c: string) => names.includes(c);

  it('keeps a free name', () => {
    expect(m.uniqueFilename('a.zip', taken([]))).toBe('a.zip');
  });

  it('counts up before the extension, never overwriting', () => {
    expect(m.uniqueFilename('a.zip', taken(['a.zip']))).toBe('a (1).zip');
    expect(m.uniqueFilename('a.zip', taken(['a.zip', 'a (1).zip', 'a (2).zip']))).toBe('a (3).zip');
  });

  it('keeps a compound extension whole', () => {
    expect(m.uniqueFilename('src.tar.gz', taken(['src.tar.gz']))).toBe('src (1).tar.gz');
    expect(m.splitExtension('README')).toEqual({ stem: 'README', ext: '' });
    expect(m.splitExtension('.tar.gz')).toEqual({ stem: '.tar', ext: '.gz' });
  });

  it('gives a name without an extension a number at the end', () => {
    expect(m.uniqueFilename('Makefile', taken(['Makefile']))).toBe('Makefile (1)');
  });
});

describe('isAllowedDownloadUrl', () => {
  it('allows http, https and a web page\'s blob', () => {
    expect(m.isAllowedDownloadUrl('https://github.com/o/r/releases/download/v1/a.zip')).toBe(true);
    expect(m.isAllowedDownloadUrl('http://localhost:3000/export.csv')).toBe(true);
    expect(m.isAllowedDownloadUrl('blob:https://example.com/2d1c1b3e-0000-4000-8000-000000000000')).toBe(true);
  });

  it('refuses everything else', () => {
    for (const url of ['file:///etc/passwd', 'data:text/plain,hi', 'blob:null/abc', 'blob:file:///x', 'ftp://example.com/a', 'javascript:alert(1)', 'chrome://downloads', 'vscode-file://x', 'not a url', '']) {
      expect(m.isAllowedDownloadUrl(url), url).toBe(false);
    }
  });
});

describe('isExecutableName', () => {
  it('flags apps, installers, scripts and shortcuts', () => {
    for (const n of ['Setup.exe', 'x.MSI', 'run.command', 'a.sh', 'Installer.pkg', 'disk.dmg', 'App.app', 'macro.vbs', 'go.bat', 'link.lnk', 'tool.jar', 'x.AppImage', 'p.ps1', 'w.webloc']) {
      expect(m.isExecutableName(n), n).toBe(true);
    }
  });
  it('leaves documents and archives', () => {
    for (const n of ['a.pdf', 'b.zip', 'c.tar.gz', 'd.png', 'e.csv', 'README', 'notes.txt', 'exe']) {
      expect(m.isExecutableName(n), n).toBe(false);
    }
  });
});

describe('state machine', () => {
  it('goes awaiting → progressing → completed', () => {
    expect(m.nextDownloadState('awaiting', 'approve')).toBe('progressing');
    expect(m.nextDownloadState('progressing', 'complete')).toBe('completed');
  });

  it('cancels from awaiting (a denied OK) or progressing', () => {
    expect(m.nextDownloadState('awaiting', 'cancel')).toBe('cancelled');
    expect(m.nextDownloadState('progressing', 'cancel')).toBe('cancelled');
  });

  it('fails from either active state', () => {
    expect(m.nextDownloadState('awaiting', 'fail')).toBe('failed');
    expect(m.nextDownloadState('progressing', 'fail')).toBe('failed');
  });

  it('keeps a finished download finished', () => {
    for (const s of ['completed', 'cancelled', 'failed'] as State[]) {
      for (const e of ['approve', 'cancel', 'complete', 'fail'] as const) {
        expect(m.nextDownloadState(s, e), `${s} ${e}`).toBeUndefined();
      }
      expect(m.isDownloadFinished(s)).toBe(true);
      expect(m.canCancelDownload(s)).toBe(false);
    }
  });

  it('cannot complete without being allowed first', () => {
    expect(m.nextDownloadState('awaiting', 'complete')).toBeUndefined();
    expect(m.nextDownloadState('progressing', 'approve')).toBeUndefined();
  });

  it('retries only what was cancelled or failed', () => {
    expect(m.canRetryDownload('cancelled')).toBe(true);
    expect(m.canRetryDownload('failed')).toBe(true);
    expect(m.canRetryDownload('completed')).toBe(false);
    expect(m.canRetryDownload('progressing')).toBe(false);
    expect(m.canRetryDownload('awaiting')).toBe(false);
  });

  it('asks above 500 MB, only when the size is known', () => {
    expect(m.needsSizeConfirm(m.LARGE_DOWNLOAD_BYTES)).toBe(false);
    expect(m.needsSizeConfirm(m.LARGE_DOWNLOAD_BYTES + 1)).toBe(true);
    expect(m.needsSizeConfirm(0)).toBe(false);
  });

  it('prunes the oldest finished downloads and never an active one', () => {
    const list = [{ state: 'completed' }, { state: 'progressing' }, { state: 'failed' }, { state: 'awaiting' }, { state: 'completed' }] as { state: State }[];
    expect(m.pruneDownloads(list, 3).map((d) => d.state)).toEqual(['progressing', 'awaiting', 'completed']);
    expect(m.pruneDownloads(list.slice(1, 2), 0).map((d) => d.state)).toEqual(['progressing']);
  });
});

describe('what a row says', () => {
  const d = (over: Partial<Download>): Download => ({ state: 'progressing', receivedBytes: 0, totalBytes: 0, bytesPerSecond: 0, ...over });

  it('formats sizes like a browser', () => {
    expect(m.formatBytes(0)).toBe('0 B');
    expect(m.formatBytes(1023)).toBe('1023 B');
    expect(m.formatBytes(1536)).toBe('1.5 KB');
    expect(m.formatBytes(13_000_000)).toBe('12.4 MB');
    expect(m.formatBytes(1.2 * 1024 ** 3)).toBe('1.20 GB');
  });

  it('shows progress, speed and time left', () => {
    expect(m.describeDownload(d({ receivedBytes: 1024 ** 2, totalBytes: 4 * 1024 ** 2, bytesPerSecond: 1024 ** 2 }))).toBe('1.0 MB of 4.0 MB · 1.0 MB/s · 3 s left');
    expect(m.describeDownload(d({ receivedBytes: 2048 }))).toBe('2.0 KB');
    expect(m.downloadProgress(d({ receivedBytes: 1, totalBytes: 4 }))).toBe(0.25);
    expect(m.downloadProgress(d({ receivedBytes: 1 }))).toBeUndefined();
    expect(m.downloadProgress(d({ state: 'completed' }))).toBe(1);
  });

  it('says why a download waits, with its size', () => {
    expect(m.describeDownload(d({ state: 'awaiting', waitingFor: 'large', totalBytes: 600 * 1024 ** 2 }))).toBe('600 MB · waiting for your OK');
    expect(m.describeDownload(d({ state: 'awaiting', waitingFor: 'agent' }))).toBe('an agent started it · waiting for your OK');
  });

  it('names the end state', () => {
    expect(m.describeDownload(d({ state: 'completed', receivedBytes: 2048 }))).toBe('2.0 KB');
    expect(m.describeDownload(d({ state: 'cancelled' }))).toBe('Cancelled');
    expect(m.describeDownload(d({ state: 'failed', error: 'Network error' }))).toBe('Failed · Network error');
  });

  it('expands ~ in the folder setting', () => {
    expect(m.expandHome('~/Downloads', '/Users/me')).toBe('/Users/me/Downloads');
    expect(m.expandHome('~', '/Users/me')).toBe('/Users/me');
    expect(m.expandHome('/tmp/dl', '/Users/me')).toBe('/tmp/dl');
    expect(m.expandHome('~other/x', '/Users/me')).toBe('~other/x');
  });
});

describe('patch 0300 stylesheet', () => {
  const css = () => newFileFromPatch(PATCH, 'src/vs/workbench/contrib/browserView/electron-browser/media/browserDownloads.css');

  it('uses only design-system tokens and theme colours for values', () => {
    const decls = [...css().replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;{])\s*([\w-]+)\s*:\s*([^;{}]+);/g)].map((x) => ({ prop: x[1], value: x[2].trim() }));
    let strip = (v: string) => v;
    strip = (v) => (/var\([^()]*\)/.test(v) ? strip(v.replace(/var\([^()]*\)/g, 'V')) : v);
    const offenders = decls
      .filter(({ prop }) => !prop.startsWith('--'))
      .filter(({ value }) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\d(?:px|ms|s|em|rem)\b/i.test(strip(value)))
      .map(({ prop, value }) => `${prop}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it('reads only tokens the design system defines', () => {
    const defined = definedTokens(workbenchTokens(fs.readFileSync(TOKENS_SOURCE, 'utf8')));
    const used = new Set([...css().matchAll(/var\((--fl-[\w-]+)/g)].map((x) => x[1]));
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });
});
