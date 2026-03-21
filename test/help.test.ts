import assert from 'node:assert/strict';
import test from 'node:test';
import { getCliHelpText, getMcpToolDescription } from '../src/help.ts';
import { runCli } from '../src/cli.ts';

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

test('help text includes the CLI commands and help alias', () => {
  const help = getCliHelpText();
  assert.match(help, /gmk help/);
  assert.match(help, /gmk add/);
  assert.match(help, /gmk updateall/);
  assert.match(help, /gmk pin/);
  assert.match(help, /gmk unpin/);
  assert.match(help, /--yes/);
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

test('MCP tool description includes help guidance and pinned resources', () => {
  const description = getMcpToolDescription('design  pinned | kept');
  assert.match(description, /gmk help/);
  assert.match(description, /Pinned resources:/);
  assert.match(description, /design/);
  assert.match(description, /gmk add/);
  assert.match(description, /gmk pin/);
  assert.match(description, /arrow-key choices/);
});
