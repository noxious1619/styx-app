import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../../test-support';
import { fuzzyMatch, rankFiles } from './worktree';

const FILES = [
  'README.md',
  'package.json',
  'src/app.ts',
  'src/checkout.ts',
  'src/components/checkout.tsx',
  'src/components/checkout.test.tsx',
  'src/pay.ts',
  'test/checkout.spec.ts',
];

describe('fuzzyMatch', () => {
  it.each([
    ['src/components/checkout.ts', 'srcchk', true],
    ['src/components/checkout.ts', 'checkout', true],
    ['src/components/checkout.ts', 'xyz', false],
    ['abc', '', true],
    ['', 'a', false],
  ])('%s ~ %s → %s', (text, query, expected) => {
    expect(fuzzyMatch(text, query)).toBe(expected);
  });
});

describe('rankFiles (fs.find)', () => {
  it.each([
    ['empty / blank query keeps every path in order', '   ', FILES],
    [
      'exact basename first, then prefix matches, then substrings, then subsequences',
      'checkout.ts',
      [
        'src/checkout.ts',
        'src/components/checkout.tsx',
        // subsequence hits (c-h-e-c-k-o-u-t-.-t-s) keep their ls-files order
        'src/components/checkout.test.tsx',
        'test/checkout.spec.ts',
      ],
    ],
    [
      'a path prefix ranks with basename prefixes, before substrings',
      'src/c',
      ['src/checkout.ts', 'src/components/checkout.tsx', 'src/components/checkout.test.tsx'],
    ],
    ['basename prefix', 'pay', ['src/pay.ts']],
    ['case-insensitive, query trimmed', ' readme.MD ', ['README.md']],
    [
      'substring before subsequence',
      'out',
      [
        'src/checkout.ts',
        'src/components/checkout.tsx',
        'src/components/checkout.test.tsx',
        'test/checkout.spec.ts',
      ],
    ],
    ['no hit → empty', 'zzz', []],
  ])('%s', (_label, query, expected) => {
    expect(rankFiles(FILES, query)).toEqual(expected);
  });
});

describe('worktree.openInIde', () => {
  it('hands the fallback editor launcher and the confined path to app.openInIde: binary and `open -a` launchers', async () => {
    const t = makeTestApp();
    const calls: [string, string][] = [];
    t.app.openInIde = async (launcher, path) => {
      calls.push([launcher, path]);
    };
    const wt = t.app.repos.worktrees.all().find((w) => w.isMain);
    if (!wt) throw new Error('demo fixture has no main worktree');

    // Demo: VS Code is the fallback with the `code` binary launcher; no file → the worktree root.
    expect(await t.app.bus.dispatch(t.sender, 'worktree.openInIde', { worktreeId: wt.id })).toEqual({
      ok: true,
      value: {},
    });
    expect(calls).toEqual([['code', wt.path]]);

    // A JetBrains bundle as the fallback (`open -a` form); a file is resolved inside the worktree.
    const jb = t.app.repos.discovery.ides().find((i) => i.kind === 'jetbrains');
    if (!jb) throw new Error('demo fixture has no JetBrains row');
    t.app.repos.discovery.saveIde({ ...jb, launcher: 'open -a "WebStorm"' });
    t.app.repos.discovery.setFallback('jetbrains');
    const withFile = await t.app.bus.dispatch(t.sender, 'worktree.openInIde', {
      worktreeId: wt.id,
      file: 'src/index.ts',
    });
    expect(withFile.ok).toBe(true);
    expect(calls[1]).toEqual(['open -a "WebStorm"', resolve(wt.path, 'src/index.ts')]);

    // A file outside the worktree is refused before anything launches.
    expect(
      await t.app.bus.dispatch(t.sender, 'worktree.openInIde', {
        worktreeId: wt.id,
        file: '../../etc/passwd',
      }),
    ).toMatchObject({ ok: false, error: { code: 'fs-denied' } });
    expect(calls).toHaveLength(2);

    // No detected editor with a launcher → not-found, nothing launched.
    t.app.repos.discovery.replaceIdes([]);
    expect(await t.app.bus.dispatch(t.sender, 'worktree.openInIde', { worktreeId: wt.id })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    expect(calls).toHaveLength(2);
  });

  it('launches Neovim inside a terminal via terminals.spawnCommand and returns terminalId', async () => {
    const t = makeTestApp();
    const ideCalls: [string, string][] = [];
    t.app.openInIde = async (launcher, path) => {
      ideCalls.push([launcher, path]);
    };
    const terminalSpawns: { file: string; args: string[]; cwd: string }[] = [];
    t.app.terminals.spawnCommand = async (cmd) => {
      terminalSpawns.push({ file: cmd.file, args: cmd.args, cwd: cmd.cwd });
      return 'term:neovim-01';
    };

    const wt = t.app.repos.worktrees.all().find((w) => w.isMain);
    if (!wt) throw new Error('demo fixture has no main worktree');

    t.app.repos.discovery.setFallback('neovim');

    // Root folder launch: no file argument passed
    const rootRes = await t.app.bus.dispatch(t.sender, 'worktree.openInIde', { worktreeId: wt.id });
    expect(rootRes).toEqual({
      ok: true,
      value: { terminalId: 'term:neovim-01' },
    });
    expect(terminalSpawns).toEqual([{ file: 'nvim', args: [], cwd: wt.path }]);
    expect(ideCalls).toHaveLength(0);

    // Specific file launch: confined file path passed in args
    const fileRes = await t.app.bus.dispatch(t.sender, 'worktree.openInIde', {
      worktreeId: wt.id,
      file: 'src/app.ts',
    });
    expect(fileRes).toEqual({
      ok: true,
      value: { terminalId: 'term:neovim-01' },
    });
    expect(terminalSpawns[1]).toEqual({
      file: 'nvim',
      args: [resolve(wt.path, 'src/app.ts')],
      cwd: wt.path,
    });
    expect(ideCalls).toHaveLength(0);

    // Outside path traversal is rejected before spawning
    expect(
      await t.app.bus.dispatch(t.sender, 'worktree.openInIde', {
        worktreeId: wt.id,
        file: '../../etc/passwd',
      }),
    ).toMatchObject({ ok: false, error: { code: 'fs-denied' } });
    expect(terminalSpawns).toHaveLength(2);
  });
});
