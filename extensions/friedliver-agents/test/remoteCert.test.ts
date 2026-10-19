import { X509Certificate, createPublicKey } from 'node:crypto';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { CERT_KEY, fingerprint, loadCert, selfSigned } from '../src/remote/cert';

describe('the self-signed certificate', () => {
  it('is a valid ECDSA server certificate for the given addresses, signed by its own key', () => {
    const { cert, key } = selfSigned(['192.168.1.23', '100.101.102.103'], new Date('2026-10-18T00:00:00Z'));
    const x = new X509Certificate(cert);
    expect(x.verify(createPublicKey(key))).toBe(true);
    expect(x.subject).toContain('CN=FriedLiver Remote');
    expect(x.subjectAltName).toBe('IP Address:192.168.1.23, IP Address:100.101.102.103');
    expect(x.checkIP('192.168.1.23')).toBe('192.168.1.23');
    expect(x.ca).toBe(false);
    expect(x.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    const days = (Date.parse(x.validTo) - Date.parse('2026-10-18T00:00:00Z')) / 86_400_000;
    // Apple's limit for certificates a user trusts by hand.
    expect(days).toBeLessThanOrEqual(398);
    expect(days).toBeGreaterThan(300);
    expect(fingerprint(cert)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(fingerprint(cert)).toBe(x.fingerprint256);
  });

  it('serves TLS that a client pinning it accepts, and one pinning another refuses', async () => {
    const mine = selfSigned(['192.168.1.23']);
    const other = selfSigned(['192.168.1.23']);
    const server = createServer({ cert: mine.cert, key: mine.key }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const handshake = (ca: string) =>
      new Promise<boolean>((resolve) => {
        // Pinned like the phone: only this certificate is trusted, whatever the name.
        const s = connect({ host: '127.0.0.1', port, ca, checkServerIdentity: () => undefined }, () => {
          s.end();
          resolve(true);
        });
        s.on('error', () => resolve(false));
      });
    expect(await handshake(mine.cert)).toBe(true);
    expect(await handshake(other.cert)).toBe(false);
    server.close();
  });

  it('is made once per install and kept in secret storage, until it is close to expiry', async () => {
    const secrets = new Map<string, string>();
    const store = { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => void secrets.set(k, v) };
    const a = await loadCert(store, ['192.168.1.23']);
    const b = await loadCert(store, ['10.0.0.2']);
    expect(b.cert).toBe(a.cert);
    expect(JSON.parse(secrets.get(CERT_KEY)!).key).toContain('PRIVATE KEY');
    const later = await loadCert(store, ['192.168.1.23'], new Date(Date.now() + 380 * 86_400_000));
    expect(later.cert).not.toBe(a.cert);
    secrets.set(CERT_KEY, 'garbage');
    expect((await loadCert(store, ['192.168.1.23'])).cert).toContain('BEGIN CERTIFICATE');
  });
});
