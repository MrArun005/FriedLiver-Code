import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newestVersion, prBody, tagCommit, updateBuildDoc, updateReadme } from '../scripts/check-upstream.mjs';
import { friedliverVersion, matchesIntegrity, pinnedSha256, sha256File, shasumFor } from '../scripts/lib.mjs';

const root = path.resolve(__dirname, '..');

function tempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-sums-'));
  const file = path.join(dir, 'download.bin');
  fs.writeFileSync(file, content);
  return file;
}

describe('download integrity helpers', () => {
  it('finds a file in a SHASUMS256.txt and nothing else', () => {
    const sums = [
      '4477b9f78efb77744cf5eb57a0e9594dba66466b38b4e93fa9f35cb907a095a6  node-v24.18.0-darwin-arm64.tar.xz',
      '55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742  node-v24.18.0-linux-x64.tar.xz',
      '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821 *node-v24.18.0-win-x64.zip',
    ].join('\n');
    expect(shasumFor(sums, 'node-v24.18.0-linux-x64.tar.xz')).toBe('55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742');
    expect(shasumFor(sums, 'node-v24.18.0-win-x64.zip')).toBe('0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821');
    expect(shasumFor(sums, 'node-v24.18.0-linux-x64.tar')).toBeNull();
    expect(shasumFor('', 'x')).toBeNull();
  });

  it('checks npm lockfile integrity (SRI) and SHA-256', () => {
    const file = tempFile('ripgrep');
    const sri = `sha512-${crypto.createHash('sha512').update('ripgrep').digest('base64')}`;
    expect(matchesIntegrity(file, sri)).toBe(true);
    expect(matchesIntegrity(file, `sha1-abc ${sri}`)).toBe(true);
    expect(matchesIntegrity(file, `sha512-${crypto.createHash('sha512').update('tampered').digest('base64')}`)).toBe(false);
    expect(matchesIntegrity(file, undefined)).toBe(false);
    expect(sha256File(file)).toBe(crypto.createHash('sha256').update('ripgrep').digest('hex'));
  });

  it('has a pin for every ripgrep binary the build can download', () => {
    const targets = ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'x86_64-apple-darwin', 'aarch64-apple-darwin'];
    for (const t of targets) expect(pinnedSha256(`ripgrep-v15.0.1-${t}.tar.gz`), t).toMatch(/^[0-9a-f]{64}$/);
    for (const t of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) expect(pinnedSha256(`ripgrep-v15.0.1-${t}.zip`), t).toMatch(/^[0-9a-f]{64}$/);
    expect(pinnedSha256('ripgrep-v99-unknown.tar.gz')).toBeNull();
  });

  it('build.mjs verifies before it unpacks or seeds anything', () => {
    const build = fs.readFileSync(path.join(root, 'scripts', 'build.mjs'), 'utf8');
    expect(build.indexOf('matchesIntegrity(tgz')).toBeGreaterThan(-1);
    expect(build.indexOf('matchesIntegrity(tgz')).toBeLessThan(build.indexOf("run('tar', ['-xzf', 'rg.tgz']"));
    const lib = fs.readFileSync(path.join(root, 'scripts', 'lib.mjs'), 'utf8');
    expect(lib.indexOf('checkSha256(archive')).toBeGreaterThan(-1);
    expect(lib.indexOf('checkSha256(archive')).toBeLessThan(lib.indexOf("run('tar', ['-xf', archive"));
  });

  it('stamps a release version only in the release tag form', () => {
    expect(friedliverVersion({ FRIEDLIVER_VERSION: 'v1.142.0-2' })).toBe('1.142.0-2');
    expect(friedliverVersion({ FRIEDLIVER_VERSION: '1.142.1' })).toBe('1.142.1');
    expect(friedliverVersion({})).toBe(JSON.parse(fs.readFileSync(path.join(root, 'upstream.json'), 'utf8')).tag);
  });
});

describe('upstream check', () => {
  it('picks the newest plain version, whatever order the service lists them in', () => {
    expect(newestVersion(['1.141.2', '1.143.0', '1.142.0'])).toBe('1.143.0');
    expect(newestVersion(['1.142.10', '1.142.9'])).toBe('1.142.10');
    expect(newestVersion(['1.143.0; rm -rf /', '$(id)', 42, '1.142.0'])).toBe('1.142.0');
    expect(newestVersion({})).toBeNull();
  });

  it('reads the tag commit from ls-remote, preferring the peeled commit', () => {
    const sha = 'd956e8a6ac5d904486557eea07e1d6bd62a4d36f';
    const other = 'a'.repeat(40);
    expect(tagCommit(`${sha}\trefs/tags/1.142.0\n`, '1.142.0')).toBe(sha);
    expect(tagCommit(`${other}\trefs/tags/1.142.0\n${sha}\trefs/tags/1.142.0^{}\n`, '1.142.0')).toBe(sha);
    expect(tagCommit(`${sha}\trefs/tags/1.142.01\n`, '1.142.0')).toBeNull();
    expect(tagCommit('not-a-sha\trefs/tags/1.142.0\n', '1.142.0')).toBeNull();
  });

  it('moves the pinned version in the docs it owns', () => {
    const build = fs.readFileSync(path.join(root, 'docs', 'BUILD.md'), 'utf8').replace(/\r\n/g, '\n');
    const commit = 'b'.repeat(40);
    const next = updateBuildDoc(build, { tag: '1.143.0', commit, date: '2026-10-19' });
    expect(next).toContain(`Pinned upstream: **1.143.0** (\`${commit}\`). On\n2026-10-19 this was the newest version`);
    expect(next!.split('\n').length).toBe(build.split('\n').length);
    expect(updateBuildDoc('no such paragraph', { tag: '1.143.0', commit, date: '2026-10-19' })).toBeNull();
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(updateReadme(readme, '1.143.0')).toContain('built on VS Code 1.143 (Code - OSS)');
  });

  it('asks for new ripgrep pins when the upstream ripgrep package changes', () => {
    const body = prBody({ from: '1.142.0', to: '1.143.0', commit: 'c'.repeat(40), node: '24.19.0', previousNode: '24.18.0', ripgrep: '1.18.0', previousRipgrep: '1.17.1' });
    expect(body).toContain('scripts/checksums.json');
    expect(body).toContain('was 24.18.0');
    expect(prBody({ from: '1.142.0', to: '1.142.1', commit: 'c'.repeat(40), node: '24.18.0', previousNode: '24.18.0', ripgrep: '1.17.1', previousRipgrep: '1.17.1' })).not.toContain('checksums.json');
  });
});
