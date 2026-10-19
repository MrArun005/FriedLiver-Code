import { describe, expect, it } from 'vitest';
import { latestTag, nextVersion, prsInRange, releaseNotes } from '../scripts/release.mjs';
import { summary, updateLinks } from '../scripts/update-links.mjs';

describe('release version', () => {
  const tags = ['v1.142.0-1', 'v1.142.0-10', 'v1.142.0-7', 'v1.141.0-3', 'v1.142.0', 'nightly', 'v1.142.0-x'];

  it('bumps the newest build of the pinned upstream version, numerically', () => {
    expect(nextVersion(tags, '1.142.0')).toBe('v1.142.0-11');
    expect(nextVersion(['v1.142.0'], '1.142.0')).toBe('v1.142.0-1');
  });

  it('starts a new upstream version at -1', () => {
    expect(nextVersion(tags, '1.143.0')).toBe('v1.143.0-1');
    expect(nextVersion([], '1.142.0')).toBe('v1.142.0-1');
  });

  it('refuses an upstream tag that is not X.Y.Z', () => {
    expect(() => nextVersion(tags, '1.142')).toThrow();
  });

  it('finds the newest release tag, ignoring other tags', () => {
    expect(latestTag(tags)).toBe('v1.142.0-10');
    expect(latestTag(['v1.141.0-3', 'v1.142.0-1', 'v1.99.0-9'])).toBe('v1.142.0-1');
    expect(latestTag(['nightly'])).toBeNull();
  });
});

describe('release notes', () => {
  it('keeps only pull requests merged in the release range', () => {
    const prs = [
      { number: 12, title: 'b', mergeCommit: { oid: 'bbb' } },
      { number: 9, title: 'a', mergeCommit: { oid: 'aaa' } },
      { number: 3, title: 'old', mergeCommit: { oid: 'old' } },
      { number: 5, title: 'no merge commit', mergeCommit: null },
    ];
    expect(prsInRange(prs, ['aaa', 'bbb', 'ccc']).map((p) => p.number)).toEqual([9, 12]);
  });

  it('groups titles by conventional-commit type, with scope and PR number', () => {
    const notes = releaseNotes({
      version: 'v1.142.0-8',
      previous: 'v1.142.0-7',
      repo: 'o/r',
      items: [
        { title: 'feat(index): Merkle tree', number: 4 },
        { title: 'fix: checkpoint same-second edit', number: 5 },
        { title: 'ui/next: tab logos', number: 6 },
        { title: 'chore(ci)!: release pipeline', number: 7 },
        { title: 'Merge release/v1.142.0-7 into main' },
      ],
    });
    expect(notes).toBe(
      [
        "## What's in 1.142.0-8",
        '',
        '### Features',
        '',
        '- **index:** Merkle tree (#4)',
        '',
        '### Fixes',
        '',
        '- checkpoint same-second edit (#5)',
        '',
        '### Maintenance',
        '',
        '- **ci:** release pipeline (#7)',
        '',
        '### Other',
        '',
        '- ui/next: tab logos (#6)',
        '- Merge release/v1.142.0-7 into main',
        '',
        "The macOS app is signed with FriedLiver's self-signed certificate; check downloads against SHA256SUMS.txt.",
        '',
        '**Full Changelog**: https://github.com/o/r/compare/v1.142.0-7...v1.142.0-8',
        '',
      ].join('\n'),
    );
  });

  it('says so when there is nothing, and has no compare link for a first release', () => {
    const notes = releaseNotes({ version: 'v1.142.0-1', previous: null, repo: 'o/r', items: [] });
    expect(notes).toContain('No changes since the previous release.');
    expect(notes).not.toContain('Full Changelog');
  });
});

describe('LINKS.md update', () => {
  const links = [
    '# links',
    '',
    'Updated 2026-10-01. One place.',
    '',
    '## Releases',
    '| Version | What | Link |',
    '|---|---|---|',
    '| v1.142.0-7 | index | https://x/v1.142.0-7 (live, latest, signed with own cert; 2026-10-18) |',
    '',
    '## Design',
  ].join('\n');
  const release = {
    tagName: 'v1.142.0-8',
    url: 'https://x/v1.142.0-8',
    publishedAt: '2026-10-19T10:00:00Z',
    commit: '0123456789abcdef0123456789abcdef01234567',
    previous: 'v1.142.0-7',
    body: "## What's in 1.142.0-8\n\n### Features\n\n- **index:** Merkle tree (#4)\n- **Mic** — a visualizer\n\n**Full Changelog**: x",
  };

  it('appends the release, moves "live, latest" to it and sets the date', () => {
    const out = updateLinks(links, release, '2026-10-19');
    const lines = out.split('\n');
    expect(lines[2]).toBe('Updated 2026-10-19. One place.');
    expect(lines[7]).toBe('| v1.142.0-7 | index | https://x/v1.142.0-7 (signed with own cert; 2026-10-18) |');
    expect(lines[8]).toBe(
      '| v1.142.0-8 | index: Merkle tree, Mic | https://x/v1.142.0-8 (live, latest, signed with own cert; 2026-10-19; tag v1.142.0-8 on main 0123456 ; compare https://github.com/MrArun005/FriedLiver-Code/compare/v1.142.0-7...v1.142.0-8) |',
    );
    expect(lines[9]).toBe('');
  });

  it('leaves a release that is already listed alone', () => {
    const once = updateLinks(links, release, '2026-10-19');
    expect(updateLinks(once, release, '2026-10-20')).toBe(once);
  });

  it('summarises long notes within the limit', () => {
    expect(summary('- aaaa\n- bbbb\n- cccc', 12)).toBe('aaaa, bbbb, …');
    expect(summary('no bullets')).toBe('see release notes');
  });
});
