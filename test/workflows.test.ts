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
    expect(workflows.sort()).toEqual(['build.yml', 'ci.yml', 'upstream.yml', 'workbench-shots.yml']);
  });

  for (const file of workflows) {
    describe(file, () => {
      const text = read(file);

      it('default to a read-only token', () => {
        expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
      });

      it('pin every action to a full commit', () => {
        const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
        expect(uses.length).toBeGreaterThan(0);
        for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/);
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
    expect(release).toContain("if: github.ref_type == 'tag'");
    expect(build).toMatch(/tags: \['v\*'\]/);
    expect(build).toMatch(/branches: \[main\]/);
  });
});
