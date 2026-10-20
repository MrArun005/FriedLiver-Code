// Guards for the GitHub workflows, without a YAML parser: plain checks on the text.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '..', '.github', 'workflows');
const workflows = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
// Windows checkouts may turn LF into CRLF; the checks are about content.
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');

/** The script text of every `run:` step (single line or block). */
function runScripts(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] && m[2] !== '|' && m[2] !== '>') {
      out.push(m[2]);
      continue;
    }
    const indent = m[1].length;
    const block: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > indent + 2)) block.push(lines[++i]);
    out.push(block.join('\n'));
  }
  return out;
}

describe('GitHub workflows', () => {
  it('exist', () => {
    expect(workflows.sort()).toEqual(['build.yml', 'ci.yml', 'index-bench.yml', 'release.yml', 'update-prs.yml', 'upstream.yml', 'workbench-shots.yml']);
  });

  for (const file of workflows) {
    describe(file, () => {
      const text = read(file);

      it('default to a read-only token', () => {
        expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
      });

      it('pin every action to a full commit', () => {
        const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
        // update-prs.yml only calls the API; it checks nothing out.
        if (file !== 'update-prs.yml') expect(uses.length).toBeGreaterThan(0);
        // A workflow of this repository (release.yml calls build.yml) is pinned by being here.
        for (const u of uses) expect(u, u).toMatch(/^([\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}|\.\/\.github\/workflows\/[\w.-]+\.yml)$/);
      });

      it('keep untrusted ${{ }} values out of scripts', () => {
        for (const script of runScripts(text)) {
          expect(script, script).not.toMatch(/\$\{\{/);
        }
      });

      it('leave no credentials on disk unless the job pushes', () => {
        const checkouts = text.split('uses: actions/checkout@').slice(1);
        for (const c of checkouts) {
          const setting = /persist-credentials:\s*(true|false)/.exec(c.slice(0, 300))?.[1];
          expect(setting, file).toBe(file === 'upstream.yml' ? 'true' : 'false');
        }
      });

      it('never fetch a package outside a lockfile (npx -y) in a job that gets secrets', () => {
        const jobs = text.slice(text.indexOf('\njobs:\n')).split(/\n(?= {2}[\w-]+:\n)/).slice(1);
        expect(jobs.length).toBeGreaterThan(0);
        for (const job of jobs) {
          if (/\bsecrets\./.test(job)) expect(job, job.split('\n')[0]).not.toMatch(/\bnpx\s+(-y|--yes)\b/);
        }
      });

      it('never runs pull requests from forks with write access', () => {
        const code = text.replace(/(^|\s)#.*$/gm, '');
        expect(code).not.toMatch(/pull_request_target|workflow_run/);
      });
    });
  }

  it('lets only the release job write, and only contents', () => {
    const build = read('build.yml');
    const writes = [...build.matchAll(/^\s+contents: write$/gm)];
    expect(writes).toHaveLength(1);
    const release = build.slice(build.indexOf('\n  release:'));
    expect(release).toMatch(/permissions:\n\s+contents: write/);
    expect(release).toContain("if: inputs.version || github.ref_type == 'tag'");
    expect(build).toMatch(/tags: \['v\*'\]/);
    expect(build).toMatch(/branches: \[main\]/);
    expect(build).toMatch(/^ {2}workflow_call:$/m);
  });

  it('installs an Open VSX extension into the Linux build and requires a successful signature check', () => {
    const build = read('build.yml');
    const step = build.slice(build.indexOf('- name: Install an extension from Open VSX'), build.indexOf('- name: Remove the signing keychain'));
    expect(step).toContain("if: runner.os == 'Linux'");
    expect(step).toContain('shell: bash');
    expect(step).toContain('--install-extension redhat.vscode-yaml');
    expect(step).toContain(': Success\\.');
  });

  it('releases only from main after CI passed, then checks the published Mac app', () => {
    const release = read('release.yml');
    expect(release).toMatch(/^on:\n {2}workflow_dispatch:\n\n/m);
    expect(release).toContain('refs/heads/main');
    expect(release).toContain('completed/success');
    expect(release).toContain('uses: ./.github/workflows/build.yml');
    const verify = release.slice(release.indexOf('\n  verify:'));
    expect(verify).toContain('runs-on: macos-latest');
    expect(verify).toContain('shasum -a 256 -c');
    expect(verify).toContain('codesign --verify --deep --strict');
    expect(verify).toContain('codesign -d -r-');
    expect(verify).toContain('CERT_ROOT: b96aa277e482e0496e8a4c1cda1b881748597643');
  });

  it('keeps pull requests up to date by merging main, never rebasing', () => {
    const update = read('update-prs.yml');
    expect(update).toContain('/update-branch');
    expect(update).not.toMatch(/rebase"|update_method|--force/);
    expect(update).toContain('gh workflow run ci.yml');
    expect(read('ci.yml')).toMatch(/^ {2}workflow_dispatch:$/m);
  });
});
