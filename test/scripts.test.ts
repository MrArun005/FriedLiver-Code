import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newestVersion, prBody, tagCommit, updateBuildDoc, updateReadme } from '../scripts/check-upstream.mjs';
import { checkRun, parseRef } from '../scripts/fetch-build.mjs';
import { diffStyles, summarize } from '../scripts/workbench-shots.mjs';
import { codesignArgs, friedliverStamp, friedliverVersion, gitReleaseState, keepChromiumLocale, newestReleaseTag, matchesIntegrity, pinnedSha256, sha256File, shasumFor, vscodeSysrootAsset } from '../scripts/lib.mjs';

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
    expect(build.indexOf('checkSha256(tgz, sysroot.sha256')).toBeGreaterThan(-1);
    expect(build.indexOf('checkSha256(tgz, sysroot.sha256')).toBeLessThan(build.indexOf("run('tar', ['-xzf', tgz"));
  });

  // Lines from VS Code 1.142.0's build/linux/debian/install-sysroot.ts and build/checksums/vscode-sysroot.txt.
  const installSysroot = [
    "\tconst version = '20260212-405735';",
    "\tconst releaseUrl = `https://api.github.com/repos/Microsoft/vscode-linux-build-agent/releases/tags/v${version}`;",
    "\tconst prefix = process.env['VSCODE_SYSROOT_PREFIX'] ?? '-glibc-2.28-gcc-10.5.0';",
  ].join('\n');
  const sysrootSums = [
    '38fa5acc4e4f17cb7e3f599b5226a511b22cbdceeb38277d224b45f7280f518f  aarch64-linux-gnu-glibc-2.28-gcc-10.5.0.tar.gz',
    'ac4b6b14b4cec027a22a51bbbb049b3504958a78106c8a8d5cec144206b767d1  x86_64-linux-gnu-glibc-2.28-gcc-10.5.0.tar.gz',
    '1ebb6ef1fe2983269fd0855a88f9c9a37f9b515d16524a9146198e4cabdf34f7  x86_64-linux-gnu-glibc-2.28-gcc-8.5.0.tar.gz',
  ].join('\n');

  it('fetches the .deb sysroot from the release-download URL, not api.github.com', () => {
    expect(vscodeSysrootAsset(installSysroot, sysrootSums, 'amd64')).toEqual({
      asset: 'x86_64-linux-gnu-glibc-2.28-gcc-10.5.0.tar.gz',
      sha256: 'ac4b6b14b4cec027a22a51bbbb049b3504958a78106c8a8d5cec144206b767d1',
      url: 'https://github.com/Microsoft/vscode-linux-build-agent/releases/download/v20260212-405735/x86_64-linux-gnu-glibc-2.28-gcc-10.5.0.tar.gz',
    });
    expect(vscodeSysrootAsset(installSysroot, sysrootSums, 'arm64')?.asset).toBe('aarch64-linux-gnu-glibc-2.28-gcc-10.5.0.tar.gz');
    expect(vscodeSysrootAsset(installSysroot, sysrootSums, 'amd64', '-glibc-2.28-gcc-8.5.0')?.sha256).toBe('1ebb6ef1fe2983269fd0855a88f9c9a37f9b515d16524a9146198e4cabdf34f7');
  });

  it('leaves the sysroot to upstream when it cannot tell what upstream would fetch', () => {
    expect(vscodeSysrootAsset(installSysroot, sysrootSums, 'armhf')).toBeNull(); // no checksum
    expect(vscodeSysrootAsset(installSysroot, sysrootSums, 'ia32')).toBeNull();
    expect(vscodeSysrootAsset(installSysroot, sysrootSums, 'amd64', '; rm -rf /')).toBeNull();
    expect(vscodeSysrootAsset(installSysroot.replace("const version = '20260212-405735';", 'const version = getVersion();'), sysrootSums, 'amd64')).toBeNull();
    expect(vscodeSysrootAsset('', sysrootSums, 'amd64')).toBeNull();
  });

  it('build.mjs seeds the sysroot for both .deb steps', () => {
    const build = fs.readFileSync(path.join(root, 'scripts', 'build.mjs'), 'utf8');
    const seed = build.indexOf('const debEnv = seedVSCodeSysroot(arch);');
    expect(seed).toBeGreaterThan(-1);
    expect(seed).toBeLessThan(build.indexOf('-prepare-deb`], { env: debEnv }'));
    expect(seed).toBeLessThan(build.indexOf('-build-deb`], { env: debEnv }'));
  });

  it('the macOS app asks for the mic and speech with FriedLiver\'s words, and its dictation helper is signed before the app', () => {
    const build = fs.readFileSync(path.join(root, 'scripts', 'build.mjs'), 'utf8');
    expect(build).toContain("'NSMicrophoneUsageDescription'");
    expect(build).toContain("'NSSpeechRecognitionUsageDescription'");
    const finish = build.indexOf('finishMacApp(path.join(appDir, app), signing);');
    expect(finish).toBeGreaterThan(-1);
    expect(finish).toBeLessThan(build.indexOf("run('codesign', codesignArgs(path.join(appDir, app), { ...signing, deep: true })"));
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8');
    expect(workflow.indexOf('extensions/friedliver-agents/native/build.sh')).toBeGreaterThan(-1);
    expect(workflow.indexOf('extensions/friedliver-agents/native/build.sh')).toBeLessThan(workflow.indexOf('node scripts/prepare.mjs'));
  });

  it('signs with the certificate when there is one, ad-hoc otherwise, and never with the hardened runtime', () => {
    expect(codesignArgs('/x/FriedLiver.app', { deep: true })).toEqual(['--force', '--deep', '--sign', '-', '/x/FriedLiver.app']);
    expect(codesignArgs('/x/FriedLiver.app', { identity: '  ', keychain: '/k', deep: true })).toEqual(['--force', '--deep', '--sign', '-', '/x/FriedLiver.app']);
    expect(codesignArgs('/x/FriedLiver.app', { identity: 'FriedLiver Self-Signed Code Signing', keychain: '/tmp/k.keychain-db', deep: true })).toEqual([
      '--force', '--deep', '--sign', 'FriedLiver Self-Signed Code Signing', '--timestamp=none', '--keychain', '/tmp/k.keychain-db', '/x/FriedLiver.app',
    ]);
    const helper = codesignArgs('/x/friedliver-dictate', { identity: 'FriedLiver Self-Signed Code Signing', identifier: 'com.friedliver.dictate' });
    expect(helper).toEqual(['--force', '--sign', 'FriedLiver Self-Signed Code Signing', '--timestamp=none', '--identifier', 'com.friedliver.dictate', '/x/friedliver-dictate']);
    for (const a of [helper, codesignArgs('/a', { identity: 'x', deep: true })]) expect(a.join(' ')).not.toMatch(/runtime/);
  });

  it('build.yml signs macOS from a throwaway keychain, checks the requirement, and always removes the keychain', () => {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8').replace(/\r\n/g, '\n');
    const setup = workflow.indexOf('- name: Signing keychain (macOS)');
    const build = workflow.indexOf('- run: node scripts/build.mjs --package --installer');
    const check = workflow.indexOf('- name: Check the signature (macOS)');
    const cleanup = workflow.indexOf('- name: Remove the signing keychain (macOS)');
    expect(setup).toBeGreaterThan(-1);
    expect(setup).toBeLessThan(build);
    expect(build).toBeLessThan(check);
    expect(check).toBeLessThan(cleanup);
    const step = workflow.slice(setup, build);
    // Forks without the secrets fall back to ad-hoc; secrets reach the script only through env.
    expect(step).toContain('if [ -z "$MACOS_SIGN_P12" ] || [ -z "$MACOS_SIGN_IDENTITY" ]; then');
    expect(step).toContain('MACOS_SIGN_P12: ${{ secrets.MACOS_SIGN_P12 }}');
    expect(step).toContain('-T /usr/bin/codesign');
    expect(step).toContain('set-key-partition-list');
    expect(step).toContain('::add-mask::');
    expect(step).not.toMatch(/echo "?\$MACOS_SIGN_P12(_PASSWORD)?"?\s*$/m);
    expect(workflow.slice(check, cleanup)).toContain("grep -q 'certificate root = H\"'");
    expect(workflow.slice(check, cleanup)).toContain('codesign --verify --deep --strict');
    expect(workflow.slice(cleanup, cleanup + 200)).toContain("if: always() && runner.os == 'macOS'");
  });

  it('stamps a release version only in the release tag form', () => {
    const noGit = () => { throw new Error('a tag build must not look at git'); };
    expect(friedliverVersion({ FRIEDLIVER_VERSION: 'v1.142.0-2' }, noGit)).toBe('1.142.0-2');
    expect(friedliverVersion({ FRIEDLIVER_VERSION: '1.142.1' }, noGit)).toBe('1.142.1');
    expect(friedliverStamp({ FRIEDLIVER_VERSION: 'v1.142.0-7' }, noGit)).toEqual({ version: '1.142.0-7', build: '1.142.0-7' });
  });

  it('stamps a build of main with the newest release it contains, so that release is not offered as an update', () => {
    const state = { tag: 'v1.142.0-7', ahead: 3, sha: 'd0cca9f1ae' };
    expect(friedliverStamp({}, () => state)).toEqual({ version: '1.142.0-7', build: '1.142.0-7+3.gd0cca9f1ae' });
    expect(friedliverStamp({ FRIEDLIVER_VERSION: ' ' }, () => ({ ...state, ahead: 0 }))).toEqual({ version: '1.142.0-7', build: '1.142.0-7' });
    // No tags (a shallow clone or an archive): the pinned upstream version, as before.
    const pinned = JSON.parse(fs.readFileSync(path.join(root, 'upstream.json'), 'utf8')).tag;
    expect(friedliverStamp({}, () => null)).toEqual({ version: pinned, build: pinned });
    expect(friedliverVersion({}, () => null)).toBe(pinned);
  });

  it('picks the newest release tag by version, not by name', () => {
    expect(newestReleaseTag(['v1.142.0', 'v1.142.0-10', 'v1.142.0-9', 'v1.141.3-12'])).toBe('v1.142.0-10');
    expect(newestReleaseTag(['v1.142.0-7', 'v1.142.1'])).toBe('v1.142.1');
    expect(newestReleaseTag(['v1.142.0', 'v1.142.0-1'])).toBe('v1.142.0-1');
    expect(newestReleaseTag(['', 'nightly', 'v1.143.0-rc1', '1.150.0', 'v1.142.0-2; rm -rf /', 'v1.142.0-2'])).toBe('v1.142.0-2');
    expect(newestReleaseTag([])).toBeNull();
  });

  it('reads the newest contained release tag and the commits since it from git', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-tags-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    expect(gitReleaseState(dir)).toBeNull(); // no commits
    git('commit', '-q', '--allow-empty', '-m', 'one');
    expect(gitReleaseState(dir)).toBeNull(); // no tags
    git('tag', 'v1.142.0-9');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    git('tag', 'v1.142.0-10');
    git('tag', 'not-a-release');
    git('commit', '-q', '--allow-empty', '-m', 'three');
    git('commit', '-q', '--allow-empty', '-m', 'four');
    // A newer release that HEAD doesn't contain (another branch) isn't this build's version.
    git('checkout', '-q', '-b', 'release', 'v1.142.0-10');
    git('commit', '-q', '--allow-empty', '-m', 'release');
    git('tag', 'v1.142.0-11');
    git('checkout', '-q', '-');
    const sha = git('rev-parse', '--short=10', 'HEAD');
    expect(gitReleaseState(dir)).toEqual({ tag: 'v1.142.0-10', ahead: 2, sha });
    expect(friedliverStamp({}, () => gitReleaseState(dir))).toEqual({ version: '1.142.0-10', build: `1.142.0-10+2.g${sha}` });
    fs.rmSync(dir, { recursive: true, force: true });
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

describe('Chromium locale packs in the packaged app', () => {
  it('keeps English (always) and the keep-list, drops the rest, ignores everything else', () => {
    for (const keep of ['en.lproj', 'en_GB.lproj', 'en-US.pak', 'en-GB.pak', 'Info.plist', 'resources.pak', 'chrome_100_percent.pak', 'Base.lproj', 'MainMenu.nib', 'icudtl.dat']) {
      expect(keepChromiumLocale(keep, 'en,en-GB'), keep).toBe(true);
    }
    for (const drop of ['de.lproj', 'zh_CN.lproj', 'pt_BR.lproj', 'hi.pak', 'fr.pak', 'en-AU.pak']) {
      expect(keepChromiumLocale(drop, 'en,en-GB'), drop).toBe(false);
    }
  });

  it('reads the keep-list in either spelling, and "all" keeps every pack', () => {
    expect(keepChromiumLocale('hi.pak', 'en, hi')).toBe(true);
    expect(keepChromiumLocale('pt_BR.lproj', 'pt-br')).toBe(true);
    expect(keepChromiumLocale('en-US.pak', '')).toBe(true);
    expect(keepChromiumLocale('de.lproj', 'all')).toBe(true);
  });

  it('runs on the packaged app before the installer is made and signed', () => {
    const build = fs.readFileSync(path.join(root, 'scripts', 'build.mjs'), 'utf8');
    expect(build).toContain('keepChromiumLocale(n)');
    expect(build.indexOf('trimPackagedApp(out);')).toBeLessThan(build.indexOf('buildInstaller(arch, out);'));
  });
});

describe('workbench harness', () => {
  const good = {
    repository: { full_name: 'MrArun005/FriedLiver-Code' },
    head_repository: { full_name: 'MrArun005/FriedLiver-Code' },
    path: '.github/workflows/build.yml',
    conclusion: 'success',
    event: 'workflow_dispatch',
    head_branch: 'ui/workbench-modern',
  };

  it('takes only "latest", v* tags and run ids as the build', () => {
    expect(parseRef('latest')).toEqual({ kind: 'release', ref: null });
    expect(parseRef('v1.142.0-5')).toEqual({ kind: 'release', ref: 'v1.142.0-5' });
    expect(parseRef('39085377230')).toEqual({ kind: 'run', ref: '39085377230' });
    for (const bad of ['', '--repo=x', 'v1; rm -rf /', '123/other-artifact', 'main']) expect(() => parseRef(bad)).toThrow();
  });

  it('runs builds only from trusted runs of build.yml', () => {
    expect(() => checkRun(good)).not.toThrow();
    expect(() => checkRun({ ...good, head_branch: 'main', event: 'push' })).not.toThrow();
    expect(() => checkRun({ ...good, head_branch: 'design/v2-workbench' })).not.toThrow();
    expect(() => checkRun({ ...good, head_repository: { full_name: 'evil/FriedLiver-Code' } })).toThrow(/fork/);
    expect(() => checkRun({ ...good, event: 'pull_request' })).toThrow(/event/);
    expect(() => checkRun({ ...good, path: '.github/workflows/ci.yml' })).toThrow(/build.yml/);
    expect(() => checkRun({ ...good, head_branch: 'feat/x' })).toThrow(/branch/);
    expect(() => checkRun({ ...good, head_branch: 'ui/../main' })).toThrow(/branch/);
    expect(() => checkRun({ ...good, conclusion: 'failure' })).toThrow(/conclusion/);
  });

  it('sums the design gates over every shot of a run', () => {
    const s = summarize('mac/fl-dark/1440x900', {
      a: { textFails: 2, ui: [{}], accentGroups: 1, off2Count: 5, off2Styled: 1, offscreen: [] },
      b: { textFails: 1, ui: [], accentGroups: 3, off2Count: 0, off2Styled: 0, offscreen: ['x'] },
      c: { error: 'page closed' },
    });
    expect(s).toMatchObject({ text: 3, ui: 1, accentMax: 3, off2: 5, off2Styled: 1, offscreen: 1 });
    expect(s.line).toContain('2 shots');
  });

  it('reports every composer style that changed', () => {
    const base = { '.composer': { color: 'red', 'border-radius': '8px' }, '.send-btn': { color: 'blue' } };
    expect(diffStyles(base, structuredClone(base))).toEqual([]);
    expect(diffStyles(base, { '.composer': { color: 'red', 'border-radius': '6px' }, '.send-btn': null })).toEqual([
      '.composer border-radius: "8px" -> "6px"',
      '.send-btn: present -> absent',
    ]);
  });
});
