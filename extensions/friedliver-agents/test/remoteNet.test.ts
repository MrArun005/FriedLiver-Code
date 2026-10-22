import type os from 'node:os';
import { describe, expect, it } from 'vitest';
import { TAILSCALE_PATHS, checkBindHost, detectTailscale, fixedEnv, isPrivateLan, isTailscaleIp, lanAddresses, splitPem, tailscaleCert } from '../src/remote/net';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null }) as os.NetworkInterfaceInfo;
const v6 = (address: string) => ({ address, family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 0 }) as os.NetworkInterfaceInfo;

describe('addresses FriedLiver Remote binds to', () => {
  it('are the private IPv4 addresses of the LAN interfaces only', () => {
    const ifaces = {
      lo0: [v4('127.0.0.1', true), v6('::1')],
      en0: [v4('192.168.1.23'), v6('fe80::1')],
      en5: [v4('10.0.4.7')],
      utun4: [v4('100.101.102.103')],
      en9: [v4('203.0.113.9')],
      en7: [v4('169.254.10.1')],
    };
    expect(lanAddresses(ifaces)).toEqual(['192.168.1.23', '10.0.4.7']);
  });

  it('leave out VPNs, VM and container bridges, and other virtual interfaces', () => {
    const ifaces = {
      en0: [v4('192.168.1.23')],
      utun3: [v4('10.8.0.2')],
      bridge100: [v4('192.168.64.1')],
      vmnet8: [v4('172.16.10.1')],
      vboxnet0: [v4('192.168.56.1')],
      docker0: [v4('172.17.0.1')],
      'br-1a2b': [v4('172.18.0.1')],
      ppp0: [v4('10.1.1.1')],
      ipsec0: [v4('10.2.2.2')],
    };
    expect(lanAddresses(ifaces)).toEqual(['192.168.1.23']);
  });

  it('never include the wildcard, loopback or public addresses', () => {
    for (const bad of ['0.0.0.0', '::', '', '127.0.0.1', '8.8.8.8', '::1', '192.168.1.1 ', 'localhost', '100.64.0.1x', '0', '172.32.0.1']) {
      expect(() => checkBindHost(bad), bad).toThrow();
    }
    for (const ok of ['192.168.1.23', '10.1.2.3', '172.16.0.4', '172.31.255.1', '100.64.0.1', '100.127.255.254']) expect(() => checkBindHost(ok), ok).not.toThrow();
  });

  it('tells LAN and Tailscale ranges apart', () => {
    expect(isPrivateLan('192.168.0.1')).toBe(true);
    expect(isPrivateLan('100.100.1.1')).toBe(false);
    expect(isTailscaleIp('100.100.1.1')).toBe(true);
    expect(isTailscaleIp('100.128.0.1')).toBe(false);
    expect(isTailscaleIp('100.63.255.255')).toBe(false);
  });
});

const STATUS = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'], DNSName: 'arun-mac.tail1234.ts.net.', Online: true } });
const IFACES = { en0: [v4('192.168.1.23')], utun4: [v4('100.101.102.103')] };

describe('Tailscale detection', () => {
  it('runs only a binary at a fixed path, never one found on PATH or in a workspace', async () => {
    const ran: string[] = [];
    const found = await detectTailscale({
      platform: 'darwin',
      exists: (p) => p === TAILSCALE_PATHS.darwin[1],
      run: async (bin, args) => {
        ran.push(`${bin} ${args.join(' ')}`);
        return STATUS;
      },
      ifaces: () => IFACES,
    });
    expect(found).toEqual({ binary: TAILSCALE_PATHS.darwin[1], ip: '100.101.102.103', dnsName: 'arun-mac.tail1234.ts.net' });
    expect(ran).toEqual([`${TAILSCALE_PATHS.darwin[1]} status --json`]);
    for (const list of Object.values(TAILSCALE_PATHS)) for (const p of list) expect(p.startsWith('/') || /^[A-Z]:\\/.test(p), p).toBe(true);
  });

  it('is off when Tailscale is missing, logged out, or its address is not on this machine', async () => {
    const run = async () => STATUS;
    expect(await detectTailscale({ platform: 'darwin', exists: () => false, run, ifaces: () => IFACES })).toBeUndefined();
    expect(await detectTailscale({ platform: 'darwin', exists: () => true, run: async () => JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }), ifaces: () => IFACES })).toBeUndefined();
    expect(await detectTailscale({ platform: 'darwin', exists: () => true, run, ifaces: () => ({ en0: [v4('192.168.1.23')] }) })).toBeUndefined();
    expect(await detectTailscale({ platform: 'darwin', exists: () => true, run: async () => 'not json', ifaces: () => IFACES })).toBeUndefined();
    expect(await detectTailscale({ platform: 'darwin', exists: () => true, run: async () => { throw new Error('boom'); }, ifaces: () => IFACES })).toBeUndefined();
    const publicIp = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['8.8.8.8'] } });
    expect(await detectTailscale({ platform: 'darwin', exists: () => true, run: async () => publicIp, ifaces: () => ({ en0: [v4('8.8.8.8')] }) })).toBeUndefined();
  });

  it('drops a MagicDNS name that is not a plain host name', async () => {
    const odd = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.101.102.103'], DNSName: 'evil.com/<x>.' } });
    expect((await detectTailscale({ platform: 'darwin', exists: () => true, run: async () => odd, ifaces: () => IFACES }))?.dnsName).toBeUndefined();
  });

  it('gets a certificate for the MagicDNS name on stdout, so its key never lands on disk', async () => {
    let args: string[] = [];
    const pem = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n-----BEGIN EC PRIVATE KEY-----\nKKK\n-----END EC PRIVATE KEY-----\n';
    const got = await tailscaleCert({ binary: '/usr/bin/tailscale', ip: '100.101.102.103', dnsName: 'arun-mac.tail1234.ts.net' }, async (_bin, a) => ((args = a), pem));
    expect(args).toEqual(['cert', '--cert-file', '-', '--key-file', '-', 'arun-mac.tail1234.ts.net']);
    expect(got?.cert).toContain('AAA');
    expect(got?.cert).toContain('BBB');
    expect(got?.key).toContain('KKK');
    expect(splitPem('junk')).toEqual({ cert: '', key: '' });
    expect(await tailscaleCert({ binary: '/usr/bin/tailscale', ip: '100.101.102.103' }, async () => pem)).toBeUndefined();
    expect(await tailscaleCert({ binary: '/usr/bin/tailscale', ip: '1', dnsName: 'a.ts.net' }, async () => 'nope')).toBeUndefined();
  });
});

describe('runFixed’s environment', () => {
  it('gives Windows programs SystemRoot and WINDIR (Tailscale fails to start without them), and System32 as PATH', () => {
    expect(fixedEnv('win32', { SystemRoot: 'D:\\Win' })).toMatchObject({ SystemRoot: 'D:\\Win', WINDIR: 'D:\\Win', PATH: 'D:\\Win\\System32' });
    expect(fixedEnv('win32', {})).toMatchObject({ SystemRoot: 'C:\\Windows' });
    expect(fixedEnv('darwin', { SystemRoot: 'x' })).toMatchObject({ PATH: '/usr/bin:/bin' });
    expect(fixedEnv('darwin', {})).not.toHaveProperty('SystemRoot');
  });
});
