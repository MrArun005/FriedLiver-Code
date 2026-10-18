// FriedLiver Remote's own HTTPS certificate: ECDSA P-256, self-signed, made
// once per install and kept in the editor's secret storage (the OS keychain).
// Its SHA-256 fingerprint goes in the pairing QR, so the phone can pin it.
// Node can sign but not build X.509, so the few DER structures are written here.
import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isIPv4 } from 'node:net';

export const CERT_KEY = 'friedliver.remote.cert';
const VALID_DAYS = 397;
const RENEW_DAYS = 30;

// ---- DER ----

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : (() => {
    const bytes: number[] = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  })();
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let v = arc >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const octet = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  // UTCTime through 2049, GeneralizedTime after.
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const NAME = seq(tlv(0x31, seq(oid('2.5.4.3'), utf8('FriedLiver Remote'))));

/** A self-signed server certificate for these addresses (IPs, or one DNS name), with its key, as PEM. */
export function selfSigned(hosts: string[], now = new Date()): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const sans = hosts.map((h) => (isIPv4(h) ? tlv(0x87, Buffer.from(h.split('.').map(Number))) : tlv(0x82, Buffer.from(h, 'ascii'))));
  const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octet(value));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ECDSA_SHA256,
    NAME,
    seq(time(new Date(now.getTime() - 60_000)), time(new Date(now.getTime() + VALID_DAYS * 86_400_000))),
    NAME,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(
      0xa3,
      seq(
        extension('2.5.29.19', true, seq()),
        extension('2.5.29.15', true, bits(Buffer.from([0x80]), 7)),
        extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
        extension('2.5.29.17', false, seq(...sans)),
      ),
    ),
  );
  const der = seq(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, privateKey)));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`;
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** "AB:CD:…", SHA-256 of the certificate's DER. */
export function fingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

interface Secrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

/** This install's certificate: the saved one while it has 30 days left, else a new one for `hosts`. */
export async function loadCert(secrets: Secrets, hosts: string[], now = new Date()): Promise<{ cert: string; key: string }> {
  try {
    const saved = JSON.parse((await secrets.get(CERT_KEY)) ?? 'null') as { cert?: unknown; key?: unknown } | null;
    if (saved && typeof saved.cert === 'string' && typeof saved.key === 'string') {
      const x = new X509Certificate(saved.cert);
      createPrivateKey(saved.key);
      if (Date.parse(x.validTo) - now.getTime() > RENEW_DAYS * 86_400_000) return { cert: saved.cert, key: saved.key };
    }
  } catch {
    // Unreadable: make a new one.
  }
  const fresh = selfSigned(hosts, now);
  await secrets.store(CERT_KEY, JSON.stringify(fresh));
  return fresh;
}
