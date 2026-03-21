import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const runE2E = process.env.GMK_RUN_E2E === '1';
const e2e = runE2E ? test : test.skip;

async function runCli(home: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(process.execPath, ['--experimental-strip-types', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
    },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

e2e('can add and load a real remote repo', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-e2e-home-'));
  const remote = process.env.GMK_E2E_REMOTE ?? 'https://github.com/lirrensi/tmp-git-clone';

  const added = await runCli(home, ['add', remote]);
  const id = added.stdout.trim();
  assert.ok(id.length > 0);

  const loaded = await runCli(home, ['load', id]);
  assert.match(loaded.stdout.trim(), /^\/|^[A-Za-z]:\\/);
});
