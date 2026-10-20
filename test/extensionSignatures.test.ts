import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { writePatchedFile } from './patchedFile';

// Patch 0040: Open VSX signatures are checked with the registry key FriedLiver pins (openVsxSignature.ts),
// and extensionSignaturePolicy.ts decides what happens next. Each test signs with a key made here.
const PATCH = '0040-open-vsx-signatures.patch';
type Code = 'Success' | 'SignatureIsNotValid' | 'NotSigned' | 'Untrusted';
type Keys = Readonly<Record<string, string>>;
let sig: {
  OPEN_VSX_PUBLIC_KEYS: Keys;
  openVsxPublicKeyId(uri: string | undefined): string | undefined;
  checkOpenVsxSignature(vsix: Uint8Array, signature: Uint8Array | undefined, publicKeyUri: string | undefined, keys?: Keys): Code;
};
let policy: {
  AllowUnsignedExtensionsConfigKey: string;
  decideSignature(status: string | undefined, required: boolean, allowed: boolean): 'install' | 'ask' | 'refuse';
  isUnsignedAllowed(setting: unknown, extensionId: string): boolean;
};

beforeAll(async () => {
  sig = await import(writePatchedFile(PATCH, 'src/vs/platform/extensionManagement/node/openVsxSignature.ts'));
  policy = await import(writePatchedFile(PATCH, 'src/vs/platform/extensionManagement/common/extensionSignaturePolicy.ts'));
});

const KEY_ID = '0b2a8c3e-1111-4222-8333-444455556666';
const KEY_URI = `https://open-vsx.example/api/-/public-key/${KEY_ID}`;
const OTHER_URI = 'https://other-registry.example/api/-/public-key/9f9f9f9f-0000-4000-8000-000000000000';
const pair = crypto.generateKeyPairSync('ed25519');
const keys: Keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
const vsix = Buffer.from('PK\u0003\u0004 pretend this is an extension package');
const signature = crypto.sign(null, vsix, pair.privateKey);
const tampered = Buffer.from(vsix);
tampered[tampered.length - 1] ^= 1;

/** What the install does: the check's code, then the policy. */
function outcome(code: string | undefined, { required = false, allowed = false } = {}) {
  return policy.decideSignature(code, required, allowed);
}

describe('Open VSX signature check', () => {
  it('valid signature: installs', () => {
    const code = sig.checkOpenVsxSignature(vsix, signature, KEY_URI, keys);
    expect(code).toBe('Success');
    expect(outcome(code)).toBe('install');
    // The signature itself proves it, whichever key the gallery names.
    expect(sig.checkOpenVsxSignature(vsix, signature, undefined, keys)).toBe('Success');
  });

  it('tampered package: refused, even after "Install Anyway"', () => {
    const code = sig.checkOpenVsxSignature(tampered, signature, KEY_URI, keys);
    expect(code).toBe('SignatureIsNotValid');
    expect(outcome(code)).toBe('refuse');
    expect(outcome(code, { allowed: true })).toBe('refuse');
  });

  it('pinned key named but the signature is missing or broken: refused, never a prompt', () => {
    for (const s of [undefined, Buffer.alloc(0), signature.subarray(0, 63), Buffer.concat([signature, Buffer.from([0])]), Buffer.alloc(64)]) {
      const code = sig.checkOpenVsxSignature(vsix, s, KEY_URI, keys);
      expect(code, String(s?.length)).toBe('SignatureIsNotValid');
      expect(outcome(code, { allowed: true })).toBe('refuse');
    }
    // The downloader's call for a gallery entry with no signature asset at all.
    expect(sig.checkOpenVsxSignature(new Uint8Array(0), undefined, `${KEY_URI}/`, keys)).toBe('SignatureIsNotValid');
  });

  it('missing signature, no pinned key named: asks; "Install Anyway" installs', () => {
    for (const uri of [undefined, OTHER_URI]) {
      const code = sig.checkOpenVsxSignature(vsix, undefined, uri, keys);
      expect(code).toBe('NotSigned');
      expect(outcome(code)).toBe('ask');
      expect(outcome(code, { allowed: true })).toBe('install');
    }
  });

  it('signed with a key FriedLiver does not know: asks', () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const code = sig.checkOpenVsxSignature(vsix, crypto.sign(null, vsix, other.privateKey), OTHER_URI, keys);
    expect(code).toBe('Untrusted');
    expect(outcome(code)).toBe('ask');
    expect(outcome(code, { allowed: true })).toBe('install');
  });

  it('verifier failure: the check throws, the install asks', () => {
    expect(() => sig.checkOpenVsxSignature(vsix, signature, KEY_URI, { [KEY_ID]: 'bm90IGEga2V5' })).toThrow();
    // The service reports a check that couldn't run as undefined.
    expect(outcome(undefined)).toBe('ask');
    expect(outcome(undefined, { allowed: true })).toBe('install');
  });

  it('a marketplace that requires signatures: anything but a valid one is refused', () => {
    for (const code of ['NotSigned', 'Untrusted', 'SignatureIsNotValid', undefined]) {
      expect(outcome(code, { required: true }), String(code)).toBe('refuse');
      expect(outcome(code, { required: true, allowed: true }), String(code)).toBe('refuse');
    }
    expect(outcome('Success', { required: true })).toBe('install');
  });

  it('reads the key id only from a public-key URL', () => {
    expect(sig.openVsxPublicKeyId(KEY_URI)).toBe(KEY_ID);
    expect(sig.openVsxPublicKeyId(KEY_URI.toUpperCase())).toBe(KEY_ID);
    expect(sig.openVsxPublicKeyId(`${KEY_URI}?x=1`)).toBeUndefined();
    expect(sig.openVsxPublicKeyId(`https://evil.example/file/${KEY_ID}`)).toBeUndefined();
    expect(sig.openVsxPublicKeyId('')).toBeUndefined();
    expect(sig.openVsxPublicKeyId(undefined)).toBeUndefined();
    // A name like "constructor" isn't a pinned key.
    expect(sig.checkOpenVsxSignature(vsix, undefined, 'https://x/api/-/public-key/constructor', keys)).toBe('NotSigned');
  });
});

describe('pinned Open VSX key', () => {
  it('is open-vsx.org key 14ccb407 as published, an Ed25519 key, and the only one', () => {
    expect(sig.OPEN_VSX_PUBLIC_KEYS).toEqual({ '14ccb407-4e79-41ed-be5a-6d608325c45a': 'MCowBQYDK2VwAyEAje+vAaSS1zHV5WHCJSa5UXvxRo6+yerEU3IEmtuEuF4=' });
    const key = crypto.createPublicKey({ key: Buffer.from(sig.OPEN_VSX_PUBLIC_KEYS['14ccb407-4e79-41ed-be5a-6d608325c45a'], 'base64'), format: 'der', type: 'spki' });
    expect(key.asymmetricKeyType).toBe('ed25519');
  });

  it('is the default, so a signature from another key with the pinned id named is refused', () => {
    expect(sig.checkOpenVsxSignature(vsix, signature, 'https://open-vsx.org/api/-/public-key/14ccb407-4e79-41ed-be5a-6d608325c45a')).toBe('SignatureIsNotValid');
  });
});

describe('allowUnsigned setting', () => {
  it('matches extension ids case-insensitively and ignores anything that is not a list of strings', () => {
    expect(policy.AllowUnsignedExtensionsConfigKey).toBe('extensions.allowUnsigned');
    expect(policy.isUnsignedAllowed(['Publisher.Name'], 'publisher.name')).toBe(true);
    expect(policy.isUnsignedAllowed(['publisher.other', 42], 'publisher.name')).toBe(false);
    expect(policy.isUnsignedAllowed('publisher.name', 'publisher.name')).toBe(false);
    expect(policy.isUnsignedAllowed(undefined, 'publisher.name')).toBe(false);
  });
});

describe('patch 0040', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '..', 'patches', PATCH), 'utf8').replace(/\r\n/g, '\n');
  const added = text.split('\n').filter(l => l.startsWith('+')).join('\n');

  it('keeps signature checks on by default', () => {
    expect(text).not.toMatch(/^\+.*default: false/m);
    expect(text).not.toMatch(/^\+.*isBoolean\(value\) \? value : false/m);
  });

  it('offers no way to skip the check from a failed install', () => {
    expect(added).not.toContain('donotVerifySignature: true');
    expect(text).toMatch(/^-.*label: localize\('install donot verify'/m);
  });

  it('lets only user settings allow unsigned extensions (no workspace setting)', () => {
    const setting = added.slice(added.indexOf('[AllowUnsignedExtensionsConfigKey]: {'));
    expect(setting.slice(0, 600)).toContain('scope: ConfigurationScope.APPLICATION');
  });
});
