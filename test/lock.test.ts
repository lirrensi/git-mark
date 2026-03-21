import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitMarkError } from '../src/errors.ts';
import { withWriterLock } from '../src/lock.ts';
import type { CommandContext } from '../src/types.ts';

function makeContext(root: string): CommandContext {
  return {
    paths: {
      home: root,
      indexPath: path.join(root, '.gitmarks.toml'),
      configPath: path.join(root, '.gitmark', 'config.toml'),
      logPath: path.join(root, 'runtime', 'history.log'),
      statePath: path.join(root, 'runtime', 'state.json'),
      storageRoot: path.join(root, 'runtime'),
      reposRoot: path.join(root, 'runtime', 'repos'),
      tempRoot: path.join(root, 'runtime', 'tmp'),
    },
    config: {
      storage: {
        root: path.join(root, 'runtime'),
        temp_root: path.join(root, 'runtime', 'tmp'),
        max_temp_size_mb: 64,
      },
      network: {
        git_timeout_sec: 120,
        allow_lfs: false,
      },
      hooks: {
        module: '',
      },
    },
  };
}

test('second writer waits and then times out while the first writer holds the lock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-lock-timeout-'));
  const context = makeContext(root);
  await fs.mkdir(context.paths.storageRoot, { recursive: true });

  let releaseFirstLock: (() => void) | undefined;
  const firstLockReady = new Promise<void>((resolve) => {
    releaseFirstLock = resolve;
  });
  let firstLockEntered: () => void = () => {};
  const firstLockStarted = new Promise<void>((resolve) => {
    firstLockEntered = resolve;
  });

  const firstWriter = withWriterLock(
    context,
    'add',
    async () => {
      firstLockEntered();
      await firstLockReady;
    },
    {
      acquisitionTimeoutMs: 500,
      staleHeartbeatMs: 1000,
      heartbeatIntervalMs: 50,
      retryIntervalMs: 10,
      retryJitterMs: 0,
    },
  );

  await firstLockStarted;

  await assert.rejects(
    withWriterLock(
      context,
      'update',
      async () => {},
      {
        acquisitionTimeoutMs: 120,
        staleHeartbeatMs: 1000,
        heartbeatIntervalMs: 50,
        retryIntervalMs: 10,
        retryJitterMs: 0,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof GitMarkError);
      assert.equal(error.code, 'WRITER_LOCK_TIMEOUT');
      assert.match(error.message, /Timed out waiting for another writer/);
      return true;
    },
  );

  releaseFirstLock?.();
  await firstWriter;
});

test('stale writer lock is reaped and can be acquired again', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-lock-stale-'));
  const context = makeContext(root);
  const lockDirectory = path.join(context.paths.storageRoot, '.write.lock');
  const ownerPath = path.join(lockDirectory, 'owner.json');
  const heartbeatPath = path.join(lockDirectory, 'heartbeat');
  await fs.mkdir(lockDirectory, { recursive: true });
  await fs.writeFile(ownerPath, '{"pid":123,"startedAt":"2026-03-21T00:00:00.000Z","command":"add"}\n', 'utf8');
  await fs.writeFile(heartbeatPath, '', 'utf8');
  const staleTime = new Date(Date.now() - 5000);
  await fs.utimes(heartbeatPath, staleTime, staleTime);

  let ran = false;
  await withWriterLock(
    context,
    'update',
    async () => {
      ran = true;
    },
    {
      acquisitionTimeoutMs: 300,
      staleHeartbeatMs: 50,
      heartbeatIntervalMs: 25,
      retryIntervalMs: 5,
      retryJitterMs: 0,
    },
  );

  assert.equal(ran, true);
  await assert.rejects(fs.stat(lockDirectory));
});
