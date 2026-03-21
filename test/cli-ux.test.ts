import assert from 'node:assert/strict';
import test from 'node:test';
import { GitMarkError } from '../src/errors.ts';
import { formatRecordLines, resolveAddTarget, resolveEditorCommand } from '../src/cli.ts';
import type { PackageRecord } from '../src/types.ts';

function makeRecord(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: 'alpha',
    remotes: ['https://example.com/org/repo.git'],
    summary: 'Alpha package',
    description: 'Alpha package description',
    resources: [],
    pinned: true,
    kept: true,
    discoverable: true,
    frozen: false,
    commit: '',
    ...overrides,
  };
}

test('resolveAddTarget can choose replace for an interactive duplicate', async () => {
  const existing = makeRecord();
  const target = await resolveAddTarget({
    records: [existing],
    requestedId: 'alpha',
    existingMatch: existing,
    interactive: true,
    prompt: {
      async input(): Promise<string> {
        throw new Error('input should not be called for replace');
      },
      async select<T>(): Promise<T> {
        return 'replace' as T;
      },
    },
  });
  assert.deepEqual(target, { mode: 'replace', id: 'alpha' });
});

test('resolveAddTarget can choose keep both and prompt for a new id', async () => {
  const existing = makeRecord();
  const target = await resolveAddTarget({
    records: [existing],
    requestedId: 'alpha',
    existingMatch: existing,
    interactive: true,
    prompt: {
      async input(_message: string, initial?: string): Promise<string> {
        assert.equal(initial, 'alpha-2');
        return initial ?? 'alpha-2';
      },
      async select<T>(): Promise<T> {
        return 'keep-both' as T;
      },
    },
  });
  assert.deepEqual(target, { mode: 'add', id: 'alpha-2' });
});

test('resolveAddTarget can cancel an interactive duplicate add', async () => {
  const existing = makeRecord();
  await assert.rejects(
    () =>
      resolveAddTarget({
        records: [existing],
        requestedId: 'alpha',
        existingMatch: existing,
        interactive: true,
        prompt: {
          async input(): Promise<string> {
            return '';
          },
          async select<T>(): Promise<T> {
            return 'cancel' as T;
          },
        },
      }),
    (error: unknown) => error instanceof GitMarkError && /Add cancelled for duplicate package alpha\./.test(error.message),
  );
});

test('resolveAddTarget fails clearly for a non-interactive exact duplicate add', async () => {
  const existing = makeRecord({ subpath: 'packages/core' });
  await assert.rejects(
    () =>
      resolveAddTarget({
        records: [existing],
        requestedId: 'alpha',
        existingMatch: existing,
        interactive: false,
      }),
    (error: unknown) => error instanceof GitMarkError && /already matches .*#packages\/core/.test(error.message),
  );
});

test('formatRecordLines shows a human-facing snippet and parenthesized technical state', () => {
  const lines = formatRecordLines(
    makeRecord({
      summary: '  Alpha   package\nfor teams  ',
      kept: false,
      frozen: true,
      commit: 'abc123',
      subpath: 'packages/core',
    }),
    true,
    false,
  );
  assert.equal(lines[0], 'alpha  Alpha package for teams');
  assert.equal(lines[1], '  (pinned, temp, frozen@abc123)');
  assert.equal(lines[2], '  subpath: packages/core');
});

test('formatRecordLines falls back to a truncated description when summary is missing', () => {
  const lines = formatRecordLines(
    makeRecord({
      summary: '',
      description: 'This package provides a deliberately long description that should be compacted into a single readable list snippet for humans browsing the catalog quickly.',
    }),
    true,
    false,
  );
  assert.match(lines[0], /^alpha  This package provides a deliberately long description/);
  assert.match(lines[0], /\.\.\.$/);
  assert.equal(lines[1], '  (pinned, kept, live)');
});

test('resolveEditorCommand prefers VISUAL, then EDITOR, then platform fallback', () => {
  assert.equal(resolveEditorCommand('linux', { VISUAL: 'hx', EDITOR: 'nano' }), 'hx');
  assert.equal(resolveEditorCommand('linux', { EDITOR: 'nano' }), 'nano');
  assert.equal(resolveEditorCommand('win32', {}), 'notepad.exe');
  assert.equal(resolveEditorCommand('linux', {}), 'vi');
});
