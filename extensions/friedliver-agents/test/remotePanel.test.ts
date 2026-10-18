import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pairingHtml, pairingLink, type PairingView } from '../src/remote/panel';

const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

const view = (over: Partial<PairingView> = {}): PairingView => ({
  nonce: 'n0nce',
  state: { via: 'lan', code: 'Q2Hk3q8xFvYwV1lJc0d2ZA', expires: 120_000 },
  active: true,
  url: 'https://192.168.1.23:50123/',
  pinned: true,
  fingerprint: FP,
  lanUrl: 'https://192.168.1.23:50123/',
  tailscaleAllowed: false,
  tailscaleFound: false,
  devices: [],
  connected: new Set(),
  now: 0,
  ...over,
});

describe('the pairing link', () => {
  it('carries the code and the certificate fingerprint in the fragment, never the path or query', () => {
    const link = pairingLink('https://192.168.1.23:50123/', 'Q2Hk3q8xFvYwV1lJc0d2ZA', FP);
    const url = new URL(link);
    expect(url.pathname).toBe('/');
    expect(url.search).toBe('');
    const p = new URLSearchParams(url.hash.slice(1));
    expect(p.get('c')).toBe('Q2Hk3q8xFvYwV1lJc0d2ZA');
    expect(Buffer.from(p.get('f')!, 'base64url').toString('hex').toUpperCase()).toBe(FP.replace(/:/g, ''));
    expect(pairingLink('https://mac.tail1.ts.net:50123/', 'x', undefined)).toBe('https://mac.tail1.ts.net:50123/#c=x');
  });
});

describe('the pairing panel', () => {
  it('shows the QR only while the code is live, and never the code as text', () => {
    const live = pairingHtml(view());
    expect(live).toContain('aria-label="Pairing QR code"');
    expect(live).not.toContain('Q2Hk3q8xFvYwV1lJc0d2ZA');
    const gone = pairingHtml(view({ active: false }));
    expect(gone).not.toContain('<svg');
    expect(gone).toContain('The code has expired.');
  });

  it('escapes what a phone named itself, and runs only its own nonce script and style', () => {
    const html = pairingHtml(view({ devices: [{ id: '0123456789abcdef', name: '<img src=x onerror=alert(1)>', createdAt: 0, lastSeen: 0 }] }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;');
    expect(html).toContain(`content="default-src 'none'; style-src 'nonce-n0nce'; script-src 'nonce-n0nce'; img-src data:"`);
    expect(html).not.toMatch(/ style="/);
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('lists phones with Revoke, says which are connected, and offers Revoke all', () => {
    const html = pairingHtml(
      view({
        devices: [
          { id: '0123456789abcdef', name: 'iPhone', createdAt: 0, lastSeen: 0 },
          { id: 'fedcba9876543210', name: 'Pixel', createdAt: 0, lastSeen: 0 },
        ],
        connected: new Set(['0123456789abcdef']),
      }),
    );
    expect(html).toContain('data-revoke="0123456789abcdef"');
    expect(html).toContain('Connected now');
    expect(html).toContain('id="revokeAll"');
  });
});

describe('the manifest', () => {
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  it('keeps Remote off by default and out of reach of workspace settings', () => {
    const props = manifest.contributes.configuration.properties;
    for (const key of ['friedliver.remote.enabled', 'friedliver.remote.tailscale']) {
      expect(props[key].default, key).toBe(false);
      expect(props[key].scope, key).toBe('application');
    }
    expect(manifest.contributes.commands.map((c: { command: string }) => c.command)).toEqual(expect.arrayContaining(['friedliver.remote.open', 'friedliver.remote.stop']));
  });

  it('never listens on the wildcard anywhere in the Remote code', () => {
    for (const f of ['server.ts', 'host.ts', 'net.ts']) {
      const src = readFileSync(path.resolve(__dirname, '../src/remote', f), 'utf8');
      expect(src, f).not.toMatch(/listen\([^)]*(0\.0\.0\.0|'::')/);
    }
  });
});
