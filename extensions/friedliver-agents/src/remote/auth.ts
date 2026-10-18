// Who may use FriedLiver Remote: phones paired with a one-time code from the
// QR, each holding its own random token. Only SHA-256 hashes of tokens are
// stored (a token is 256 random bits, so a fast hash is enough); every compare
// is constant-time. Failures lock the address out for a while.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Store } from '../host/permissions';

export const PAIRING_TTL_MS = 2 * 60_000;
/** Wrong codes, from anywhere, before the code on screen stops working. */
export const MAX_BAD_CODES = 10;
export const MAX_DEVICES = 10;
export const DEVICES_KEY = 'friedliver.remote.devices';

const LOCK_FAILS = 5;
const LOCK_WINDOW_MS = 60_000;
const LOCK_MS = 5 * 60_000;
const LOCK_KEYS = 1000;
/** lastSeen is written to storage at most this often per device. */
const SEEN_WRITE_MS = 60_000;

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
}
type Saved = Device & { hash: string };

const shown = (d: Saved): Device => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen });

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Equal secrets, in time that doesn't depend on where they differ. */
export function sameSecret(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** A device's name as the phone gave it: one line of printable text, 40 characters at most. */
export function deviceName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim() : '';
  return name || 'Phone';
}

/** Paired devices, by token hash, in the user's own storage (globalState). */
export class Devices {
  private saved: Saved[];
  private written = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    const raw = store.get<Saved[]>(DEVICES_KEY);
    this.saved = Array.isArray(raw) ? raw.filter((d) => d && typeof d.hash === 'string' && /^[0-9a-f]{64}$/.test(d.hash) && typeof d.id === 'string') : [];
  }

  list(): Device[] {
    return this.saved.map(shown);
  }

  /** A new device and its token; the token is shown to the phone once and never kept. The oldest goes past MAX_DEVICES. */
  add(name: string): { token: string; device: Device } {
    const token = randomBytes(32).toString('base64url');
    const at = this.now();
    const device: Saved = { id: randomBytes(8).toString('hex'), name: deviceName(name), createdAt: at, lastSeen: at, hash: hashToken(token) };
    this.saved = [...this.saved, device].slice(-MAX_DEVICES);
    this.save();
    return { token, device: shown(device) };
  }

  /** The device this token belongs to. Every stored hash is compared, each in constant time. */
  authenticate(token: string): Device | undefined {
    if (typeof token !== 'string' || !token || token.length > 256) return undefined;
    const hash = Buffer.from(hashToken(token), 'hex');
    let found: Saved | undefined;
    for (const d of this.saved) if (timingSafeEqual(hash, Buffer.from(d.hash, 'hex'))) found = d;
    if (!found) return undefined;
    const at = this.now();
    found.lastSeen = at;
    if (at - (this.written.get(found.id) ?? -Infinity) >= SEEN_WRITE_MS) {
      this.written.set(found.id, at);
      this.save();
    }
    return shown(found);
  }

  has(id: string): boolean {
    return this.saved.some((d) => d.id === id);
  }

  revoke(id: string): void {
    this.saved = this.saved.filter((d) => d.id !== id);
    this.save();
  }

  revokeAll(): void {
    this.saved = [];
    this.save();
  }

  private save(): void {
    void Promise.resolve(this.store.update(DEVICES_KEY, this.saved)).catch(() => {});
  }
}

/** The code the QR carries: one at a time, 128 random bits, 2 minutes, good once. */
export class Pairing {
  private current?: { code: string; expires: number; bad: number };

  constructor(
    private readonly devices: Devices,
    private readonly now: () => number = Date.now,
  ) {}

  start(): { code: string; expires: number } {
    const code = randomBytes(16).toString('base64url');
    this.current = { code, expires: this.now() + PAIRING_TTL_MS, bad: 0 };
    return { code, expires: this.current.expires };
  }

  active(): boolean {
    return !!this.current && this.now() < this.current.expires;
  }

  cancel(): void {
    this.current = undefined;
  }

  /** A new device for the right code, in time; the code is gone either way once it worked. */
  redeem(code: string, name: string): { token: string; device: Device } | undefined {
    const c = this.current;
    if (!c || this.now() >= c.expires) {
      this.current = undefined;
      return undefined;
    }
    if (!sameSecret(code, c.code)) {
      if (++c.bad >= MAX_BAD_CODES) this.current = undefined;
      return undefined;
    }
    this.current = undefined;
    return this.devices.add(name);
  }
}

/** Five failures in a minute from one address lock it out for five minutes. */
export class Lockout {
  private readonly fails = new Map<string, { at: number[]; until?: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.fails.size;
  }

  blocked(key: string): boolean {
    const until = this.fails.get(key)?.until;
    return until !== undefined && this.now() < until;
  }

  fail(key: string): void {
    const at = this.now();
    const entry = this.fails.get(key) ?? { at: [] };
    this.fails.delete(key);
    entry.at = [...entry.at.filter((t) => at - t < LOCK_WINDOW_MS), at];
    if (entry.at.length >= LOCK_FAILS) entry.until = at + LOCK_MS;
    // ponytail: oldest-first eviction caps memory; an attacker cycling >1000 addresses only resets their own counters.
    this.fails.set(key, entry);
    if (this.fails.size > LOCK_KEYS) this.fails.delete(this.fails.keys().next().value!);
  }
}
