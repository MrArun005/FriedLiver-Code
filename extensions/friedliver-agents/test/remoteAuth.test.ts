import { describe, expect, it } from 'vitest';
import { DEVICES_KEY, Devices, Lockout, MAX_BAD_CODES, PAIRING_TTL_MS, Pairing, deviceName, hashToken } from '../src/remote/auth';
import { memoryStore } from './helpers';

describe('pairing codes', () => {
  it('are 128 random bits, valid for 2 minutes and good once', () => {
    let now = 1_000;
    const store = memoryStore();
    const pairing = new Pairing(new Devices(store), () => now);
    const { code, expires } = pairing.start();
    expect(Buffer.from(code, 'base64url')).toHaveLength(16);
    expect(expires - now).toBe(PAIRING_TTL_MS);
    expect(pairing.start().code).not.toBe(code);
    const fresh = pairing.start().code;
    const paired = pairing.redeem(fresh, 'Phone');
    expect(paired?.token).toBeTruthy();
    // Single use.
    expect(pairing.redeem(fresh, 'Phone')).toBeUndefined();
    // Expiry.
    const late = pairing.start().code;
    now += PAIRING_TTL_MS + 1;
    expect(pairing.redeem(late, 'Phone')).toBeUndefined();
    expect(pairing.active()).toBe(false);
  });

  it('refuses the old code once a new one is shown, and anything that is not the code', () => {
    const pairing = new Pairing(new Devices(memoryStore()), () => 0);
    const old = pairing.start().code;
    const code = pairing.start().code;
    expect(pairing.redeem(old, 'x')).toBeUndefined();
    for (const bad of ['', code.slice(1), `${code}x`, code.toUpperCase() === code ? code.toLowerCase() : code.toUpperCase()]) expect(pairing.redeem(bad, 'x')).toBeUndefined();
    expect(pairing.redeem(code, 'x')).toBeDefined();
  });

  it('burns the code after too many wrong guesses, wherever they come from', () => {
    const pairing = new Pairing(new Devices(memoryStore()), () => 0);
    const code = pairing.start().code;
    for (let i = 0; i < MAX_BAD_CODES; i++) pairing.redeem(`wrong-${i}`, 'x');
    expect(pairing.active()).toBe(false);
    expect(pairing.redeem(code, 'x')).toBeUndefined();
  });

  it('can be cancelled', () => {
    const pairing = new Pairing(new Devices(memoryStore()), () => 0);
    const code = pairing.start().code;
    pairing.cancel();
    expect(pairing.redeem(code, 'x')).toBeUndefined();
  });
});

describe('device tokens', () => {
  it('are stored only as hashes', () => {
    const store = memoryStore();
    const devices = new Devices(store, () => 5);
    const { token, device } = devices.add('Arun’s iPhone');
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const saved = JSON.stringify(store.data[DEVICES_KEY]);
    expect(saved).not.toContain(token);
    expect(saved).toContain(hashToken(token));
    expect(devices.list()).toEqual([{ id: device.id, name: 'Arun’s iPhone', createdAt: 5, lastSeen: 5 }]);
  });

  it('authenticate the device they were issued to, and nothing else', () => {
    const devices = new Devices(memoryStore());
    const a = devices.add('A');
    const b = devices.add('B');
    expect(devices.authenticate(a.token)?.id).toBe(a.device.id);
    expect(devices.authenticate(b.token)?.id).toBe(b.device.id);
    for (const bad of ['', 'x', a.token.slice(0, -1), hashToken(a.token), undefined as unknown as string]) expect(devices.authenticate(bad)).toBeUndefined();
  });

  it('stop working when revoked, one at a time or all at once, and stay revoked after a restart', () => {
    const store = memoryStore();
    const devices = new Devices(store);
    const a = devices.add('A');
    const b = devices.add('B');
    const c = devices.add('C');
    devices.revoke(a.device.id);
    expect(devices.authenticate(a.token)).toBeUndefined();
    expect(devices.authenticate(b.token)).toBeDefined();
    const again = new Devices(store);
    expect(again.authenticate(a.token)).toBeUndefined();
    expect(again.authenticate(c.token)).toBeDefined();
    again.revokeAll();
    expect(again.authenticate(b.token)).toBeUndefined();
    expect(new Devices(store).list()).toEqual([]);
  });

  it('say when a device was last seen', () => {
    let now = 0;
    const devices = new Devices(memoryStore(), () => now);
    const { token } = devices.add('A');
    now = 120_000;
    devices.authenticate(token);
    expect(devices.list()[0].lastSeen).toBe(120_000);
  });

  it('keep a sane name', () => {
    expect(deviceName('  iPhone\u0000\n<b>x</b>  ')).toBe('iPhone <b>x</b>');
    expect(deviceName('')).toBe('Phone');
    expect(deviceName(42)).toBe('Phone');
    expect(deviceName('a'.repeat(200))).toHaveLength(40);
  });
});

describe('lockout', () => {
  it('locks an address out after repeated failures, for a while', () => {
    let now = 0;
    const lock = new Lockout(() => now);
    for (let i = 0; i < 4; i++) lock.fail('10.0.0.9');
    expect(lock.blocked('10.0.0.9')).toBe(false);
    lock.fail('10.0.0.9');
    expect(lock.blocked('10.0.0.9')).toBe(true);
    expect(lock.blocked('10.0.0.8')).toBe(false);
    now += 4 * 60_000;
    expect(lock.blocked('10.0.0.9')).toBe(true);
    now += 2 * 60_000;
    expect(lock.blocked('10.0.0.9')).toBe(false);
  });

  it('forgets failures outside the window', () => {
    let now = 0;
    const lock = new Lockout(() => now);
    for (let i = 0; i < 4; i++) lock.fail('a');
    now += 61_000;
    lock.fail('a');
    expect(lock.blocked('a')).toBe(false);
  });

  it('keeps a bounded memory however many addresses fail', () => {
    const lock = new Lockout(() => 0);
    for (let i = 0; i < 5000; i++) lock.fail(`10.0.${i >> 8}.${i & 255}`);
    expect(lock.size).toBeLessThanOrEqual(1000);
  });
});
