import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { ensureGitAccessible, runGit } from '../src/git.ts';
import { GitMarkError } from '../src/errors.ts';

test('git is available on the test machine', async () => {
  await ensureGitAccessible();
});

test('runGit reports missing git cleanly', async () => {
  await assert.rejects(() => runGit(['--version'], { env: { PATH: '' } }), (error: unknown) => {
    assert.ok(error instanceof GitMarkError);
    return true;
  });
});

test('runGit times out cleanly when git blocks too long', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmark-git-timeout-'));
  const shimDir = path.join(tempDir, 'shim');
  await fs.mkdir(shimDir);

  const sleepScriptPath = path.join(shimDir, 'sleep.js');
  await fs.writeFile(sleepScriptPath, 'setTimeout(() => {}, 500);\n', 'utf8');

  if (process.platform === 'win32') {
    await fs.writeFile(
      path.join(shimDir, 'git.cmd'),
      `@echo off\r\n"${process.execPath.replace(/"/g, '""')}" "${sleepScriptPath}"\r\n`,
      'utf8',
    );
  } else {
    const shimPath = path.join(shimDir, 'git');
    await fs.writeFile(shimPath, `#!/bin/sh\n"${process.execPath}" "${sleepScriptPath}"\n`, 'utf8');
    await fs.chmod(shimPath, 0o755);
  }

  await assert.rejects(
    () =>
      runGit(['status'], {
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
          Path: `${shimDir}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ''}`,
        },
        timeoutMs: 50,
      }),
    (error: unknown) => {
      assert.ok(error instanceof GitMarkError);
      assert.equal(error.code, 'GIT_TIMEOUT');
      assert.match(error.message, /git status timed out after 0.05 seconds/);
      return true;
    },
  );
});

test('git can clone a local repository', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmark-git-test-'));
  const repoDir = path.join(tempDir, 'repo');
  const cloneDir = path.join(tempDir, 'clone');
  await fs.mkdir(repoDir);
  await runGit(['init'], { cwd: repoDir });
  await fs.writeFile(path.join(repoDir, 'README.md'), '# hello\n', 'utf8');
  await runGit(['add', '.'], { cwd: repoDir });
  await runGit(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repoDir });
  await runGit(['clone', repoDir, cloneDir]);
  const stat = await fs.stat(path.join(cloneDir, 'README.md'));
  assert.ok(stat.isFile());
});
