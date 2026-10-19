// Where FriedLiver Remote listens: the LAN's private IPv4 addresses, and the
// machine's Tailscale address when the user allows it. Never the wildcard
// (0.0.0.0 / ::), never loopback, never a public address. Tailscale is found
// at fixed install paths only; a binary on PATH or in a workspace is never run.
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import os from 'node:os';

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

const octets = (ip: string) => ip.split('.').map(Number);

export function isPrivateLan(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a, b] = octets(ip);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Tailscale hands out addresses in the CGNAT range, 100.64.0.0/10. */
export function isTailscaleIp(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a, b] = octets(ip);
  return a === 100 && b >= 64 && b <= 127;
}

/** Throws unless `host` is one address FriedLiver Remote may listen on. */
export function checkBindHost(host: string): void {
  if (!isPrivateLan(host) && !isTailscaleIp(host)) throw new Error(`FriedLiver Remote listens only on a private LAN or Tailscale address, not "${host}".`);
}

/** VPN tunnels, VM and container bridges, Apple's peer-to-peer links: not the Wi-Fi or Ethernet the phone is on. */
const VIRTUAL = /^(utun|ipsec|ppp|tun|tap|bridge|vmnet|vboxnet|docker|br-|veth|awdl|llw|gif|stf|anpi|ap\d|vnic|virbr|zt|wg|tailscale)/i;

/** The private IPv4 addresses of this machine's Wi-Fi and Ethernet interfaces (not loopback, VPNs, VM bridges or Tailscale). */
export function lanAddresses(ifaces: Ifaces = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal && isPrivateLan(i.address) && !out.includes(i.address)) out.push(i.address);
  }
  return out;
}

/** Where Tailscale installs its CLI. Only these are run. */
export const TAILSCALE_PATHS: Record<string, string[]> = {
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'],
  linux: ['/usr/bin/tailscale', '/usr/sbin/tailscale'],
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
};

export interface Tailscale {
  binary: string;
  /** This machine's Tailscale IPv4 address. */
  ip: string;
  /** Its MagicDNS name, without the trailing dot, when it has one. */
  dnsName?: string;
}

type Run = (binary: string, args: string[]) => Promise<string>;

export interface DetectDeps {
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  run?: Run;
  ifaces?: () => Ifaces;
}

const isFile = (file: string) => {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Runs a program by absolute path with a small environment, a timeout and bounded output. */
export const runFixed: Run = (binary, args) =>
  new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 15_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() }, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });

const HOST_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Tailscale, when installed at a fixed path, logged in and running, with its address on one of this machine's interfaces. */
export async function detectTailscale(deps: DetectDeps = {}): Promise<Tailscale | undefined> {
  const { platform = process.platform, exists = isFile, run = runFixed, ifaces = os.networkInterfaces } = deps;
  const binary = (TAILSCALE_PATHS[platform] ?? []).find((p) => exists(p));
  if (!binary) return undefined;
  let status: { BackendState?: unknown; Self?: { TailscaleIPs?: unknown; DNSName?: unknown } };
  try {
    status = JSON.parse(await run(binary, ['status', '--json']));
  } catch {
    return undefined;
  }
  if (status?.BackendState !== 'Running' || !Array.isArray(status.Self?.TailscaleIPs)) return undefined;
  const local = new Set(Object.values(ifaces()).flatMap((l) => (l ?? []).map((i) => i.address)));
  const ip = status.Self.TailscaleIPs.find((a): a is string => typeof a === 'string' && isTailscaleIp(a) && local.has(a));
  if (!ip) return undefined;
  const name = typeof status.Self.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '').toLowerCase() : '';
  return { binary, ip, ...(HOST_NAME.test(name) ? { dnsName: name } : {}) };
}

/** The certificate chain and key blocks of a PEM bundle. */
export function splitPem(pem: string): { cert: string; key: string } {
  const blocks = pem.match(/-----BEGIN ([A-Z ]+)-----[\s\S]+?-----END \1-----/g) ?? [];
  return {
    cert: blocks.filter((b) => b.startsWith('-----BEGIN CERTIFICATE-----')).join('\n'),
    key: blocks.find((b) => /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(b)) ?? '',
  };
}

/**
 * A real HTTPS certificate for the MagicDNS name (`tailscale cert`, Let's Encrypt), both parts on
 * stdout so the key never lands on disk. Undefined without a name, or when the tailnet has HTTPS
 * certificates off: the caller keeps its pinned self-signed certificate.
 */
export async function tailscaleCert(ts: Tailscale, run: Run = runFixed): Promise<{ cert: string; key: string } | undefined> {
  if (!ts.dnsName) return undefined;
  try {
    const { cert, key } = splitPem(await run(ts.binary, ['cert', '--cert-file', '-', '--key-file', '-', ts.dnsName]));
    return cert && key ? { cert, key } : undefined;
  } catch {
    return undefined;
  }
}
