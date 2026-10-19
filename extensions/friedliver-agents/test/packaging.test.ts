import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Every runtime bundle esbuild writes to dist/ (tests aside) must be shipped by .vscodeignore,
// or the built app references a file that isn't there (externalStdio.js in 1.142.0-2).
describe('packaging', () => {
  it('ships every dist bundle the extension builds', () => {
    const build = readFileSync('esbuild.mjs', 'utf8');
    const outfiles = [...build.matchAll(/outfile: '(dist\/[^']+)'/g)].map((m) => m[1]);
    const shipped = readFileSync('.vscodeignore', 'utf8').split('\n').filter((l) => l.startsWith('!')).map((l) => l.slice(1));
    expect(outfiles).toContain('dist/externalStdio.js');
    expect(outfiles.filter((f) => !shipped.includes(f))).toEqual([]);
  });
});
