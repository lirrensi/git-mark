import assert from 'node:assert/strict';
import test from 'node:test';
import { getCliHelpText, getMcpToolDescription } from '../src/help.ts';
import { runCli } from '../src/cli.ts';
import type { PackageRecord } from '../src/types.ts';

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ output: string; value: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    const value = await fn();
    return { output: lines.join('\n'), value };
  } finally {
    console.log = originalLog;
  }
}

function makePinnedRecord(index: number, overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: `pkg-${String(index).padStart(2, '0')}`,
    remotes: [`https://example.com/pkg-${index}.git`],
    summary: `summary ${index}`,
    description: `description ${index}`,
    pinned: true,
    ...overrides,
  };
}

test('help text includes the CLI commands and help alias', () => {
  const help = getCliHelpText();
  assert.match(help, /gmk help/);
  assert.match(help, /gmk add/);
  assert.match(help, /gmk remove <id>/);
  assert.match(help, /gmk rm <id>/);
  assert.match(help, /gmk doctor/);
  assert.match(help, /gmk cleanup/);
  assert.match(help, /gmk sync/);
  assert.match(help, /gmk edit/);
  assert.match(help, /gmk updateall/);
  assert.match(help, /gmk pin/);
  assert.match(help, /gmk unpin/);
  assert.match(help, /--yes/);
  assert.match(help, /list-all \[--limit <n>\] \[--offset <n>\]/);
  assert.match(help, /search <query> \[--limit <n>\] \[--offset <n>\]/);
  assert.match(help, /defaults to `--limit 15 --offset 0`/);
  assert.match(help, /arrow-key choices/);
});

test('runCli accepts the help aliases', async () => {
  const aliases = ['--help', '-h', '-help', 'help'];
  for (const alias of aliases) {
    const { output } = await captureStdout(() => runCli([alias]));
    assert.match(output, /git-mark \/ gmk/);
    assert.match(output, /gmk help/);
  }
});

test('MCP tool description explains the command payload and includes quick-help sections', () => {
  const description = getMcpToolDescription([makePinnedRecord(1, { id: 'design' })]);

  assert.match(description, /CLI-style wrapper/);
  assert.match(description, /send one `command` string with what would follow `gmk`/);
  assert.match(description, /Most used:/);
  assert.match(description, /\{ "command": "list" \}/);
  assert.match(description, /\{ "command": "search design" \}/);
  assert.match(description, /\{ "command": "load design" \}/);
  assert.match(description, /What to expect:/);
  assert.match(description, /Available resources:/);
  assert.doesNotMatch(description, /Pinned resources:/);
  assert.match(description, /design \|/);
});

test('MCP tool description renders compact pinned package lines without technical flags', () => {
  const description = getMcpToolDescription([
    makePinnedRecord(1, {
      id: 'design',
      summary: '  Design   templates   for   product teams  ',
      description: 'fallback text',
      kept: true,
      frozen: true,
    }),
  ]);

  assert.match(description, /design \| Design templates for pr/);
  assert.doesNotMatch(description, /kept|frozen|live|pinned/);
});

test('MCP tool description limits pinned package surfacing to 15 entries', () => {
  const description = getMcpToolDescription(Array.from({ length: 15 }, (_, index) => makePinnedRecord(index + 1)));

  const pinnedLines = description
    .split('\n')
    .filter((line) => line.startsWith('pkg-'));

  assert.equal(pinnedLines.length, 15);
});

test('MCP tool description reports the exact overflow count and includes gmk list', () => {
  const description = getMcpToolDescription(Array.from({ length: 18 }, (_, index) => makePinnedRecord(index + 1)));

  const pinnedLines = description
    .split('\n')
    .filter((line) => line.startsWith('pkg-'));

  assert.equal(pinnedLines.length, 15);
  assert.match(description, /3 more available resources\./);
  assert.match(description, /`gmk list`/);
  assert.doesNotMatch(description, /pkg-16/);
});

test('MCP tool description renders a concise zero-pinned fallback', () => {
  const description = getMcpToolDescription([]);

  assert.match(description, /Available resources: none yet\./);
});
