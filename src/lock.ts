import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GitMarkError } from './errors.ts';
import { ensureDir } from './fs.ts';
import type { CommandContext } from './types.ts';

const LOCK_DIRECTORY_NAME = '.write.lock';

export interface WriterLockOptions {
  acquisitionTimeoutMs: number;
  staleHeartbeatMs: number;
  heartbeatIntervalMs: number;
  retryIntervalMs: number;
  retryJitterMs: number;
}

export const DEFAULT_WRITER_LOCK_OPTIONS: WriterLockOptions = {
  acquisitionTimeoutMs: 60000,
  staleHeartbeatMs: 20000,
  heartbeatIntervalMs: 5000,
  retryIntervalMs: 250,
  retryJitterMs: 100,
};

interface LockPaths {
  directoryPath: string;
  ownerPath: string;
  heartbeatPath: string;
}

interface AcquiredWriterLock {
  release: () => Promise<void>;
}

export interface WriterLockInspection {
  exists: boolean;
  stale: boolean;
  heartbeatAgeMs: number | null;
  status: 'absent' | 'active' | 'stale';
  ownerSummary: string;
}

function resolveWriterLockOptions(options?: Partial<WriterLockOptions>): WriterLockOptions {
  return {
    acquisitionTimeoutMs: options?.acquisitionTimeoutMs ?? DEFAULT_WRITER_LOCK_OPTIONS.acquisitionTimeoutMs,
    staleHeartbeatMs: options?.staleHeartbeatMs ?? DEFAULT_WRITER_LOCK_OPTIONS.staleHeartbeatMs,
    heartbeatIntervalMs: options?.heartbeatIntervalMs ?? DEFAULT_WRITER_LOCK_OPTIONS.heartbeatIntervalMs,
    retryIntervalMs: options?.retryIntervalMs ?? DEFAULT_WRITER_LOCK_OPTIONS.retryIntervalMs,
    retryJitterMs: options?.retryJitterMs ?? DEFAULT_WRITER_LOCK_OPTIONS.retryJitterMs,
  };
}

function getLockPaths(context: CommandContext): LockPaths {
  const directoryPath = path.join(context.paths.storageRoot, LOCK_DIRECTORY_NAME);
  return {
    directoryPath,
    ownerPath: path.join(directoryPath, 'owner.json'),
    heartbeatPath: path.join(directoryPath, 'heartbeat'),
  };
}

async function writeLockMetadata(paths: LockPaths, commandName: string): Promise<void> {
  const timestamp = new Date();
  await fs.writeFile(paths.heartbeatPath, '', 'utf8');
  await fs.utimes(paths.heartbeatPath, timestamp, timestamp);
  await fs.writeFile(
    paths.ownerPath,
    `${JSON.stringify({ pid: process.pid, startedAt: timestamp.toISOString(), command: commandName }, null, 2)}\n`,
    'utf8',
  );
}

async function readOwnerSummary(paths: LockPaths): Promise<string> {
  try {
    const text = await fs.readFile(paths.ownerPath, 'utf8');
    const parsed = JSON.parse(text) as Partial<{ pid: number; command: string; startedAt: string }>;
    const parts = [
      typeof parsed.command === 'string' && parsed.command.length > 0 ? `command=${parsed.command}` : '',
      typeof parsed.pid === 'number' ? `pid=${parsed.pid}` : '',
      typeof parsed.startedAt === 'string' && parsed.startedAt.length > 0 ? `startedAt=${parsed.startedAt}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  } catch {
    return '';
  }
}

async function readHeartbeatAgeMs(paths: LockPaths): Promise<number> {
  try {
    const heartbeat = await fs.stat(paths.heartbeatPath);
    const ageMs = Date.now() - heartbeat.mtimeMs;
    if (!Number.isFinite(ageMs)) {
      throw new GitMarkError(
        'WRITER_LOCK_METADATA_UNREADABLE',
        'Writer lock metadata is unreadable; stale lock recovery cannot proceed safely.',
      );
    }
    return ageMs;
  } catch (error) {
    if (error instanceof GitMarkError) {
      throw error;
    }
    throw new GitMarkError(
      'WRITER_LOCK_METADATA_UNREADABLE',
      'Writer lock metadata is unreadable; stale lock recovery cannot proceed safely.',
      1,
      error,
    );
  }
}

async function reapStaleLock(paths: LockPaths): Promise<void> {
  try {
    await fs.rm(paths.directoryPath, { recursive: true, force: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    throw new GitMarkError('WRITER_LOCK_RELEASE_FAILED', 'Writer lock release failed during stale lock recovery.', 1, error);
  }
}

async function acquireWriterLock(
  context: CommandContext,
  commandName: string,
  options: WriterLockOptions,
): Promise<AcquiredWriterLock> {
  const paths = getLockPaths(context);
  const deadline = Date.now() + options.acquisitionTimeoutMs;

  await ensureDir(context.paths.storageRoot);

  while (true) {
    try {
      await fs.mkdir(paths.directoryPath);
      await writeLockMetadata(paths, commandName);

      let released = false;
      let heartbeatError: unknown = null;
      const keepHeartbeatAlive = async (): Promise<void> => {
        while (!released) {
          await delay(options.heartbeatIntervalMs);
          if (released) {
            return;
          }
          try {
            const timestamp = new Date();
            await fs.utimes(paths.heartbeatPath, timestamp, timestamp);
          } catch (error) {
            heartbeatError = error;
            return;
          }
        }
      };

      const heartbeatPromise = keepHeartbeatAlive();

      return {
        release: async () => {
          released = true;
          await heartbeatPromise;
          if (heartbeatError) {
            throw new GitMarkError('WRITER_LOCK_RELEASE_FAILED', 'Writer lock release failed.', 1, heartbeatError);
          }
          try {
            await fs.rm(paths.directoryPath, { recursive: true, force: false });
          } catch (error) {
            throw new GitMarkError('WRITER_LOCK_RELEASE_FAILED', 'Writer lock release failed.', 1, error);
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof GitMarkError) {
        throw error;
      }
      if (code !== 'EEXIST') {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      const ownerSummary = await readOwnerSummary(paths);
      throw new GitMarkError(
        'WRITER_LOCK_TIMEOUT',
        `Timed out waiting for another writer after ${options.acquisitionTimeoutMs}ms. Retry the command.${ownerSummary}`,
      );
    }

    const heartbeatAgeMs = await readHeartbeatAgeMs(paths);
    if (heartbeatAgeMs > options.staleHeartbeatMs) {
      await reapStaleLock(paths);
      continue;
    }

    const remainingMs = Math.max(0, deadline - Date.now());
    const jitterMs = options.retryJitterMs > 0 ? Math.floor(Math.random() * (options.retryJitterMs + 1)) : 0;
    await delay(Math.min(remainingMs, options.retryIntervalMs + jitterMs));
  }
}

export async function withWriterLock<T>(
  context: CommandContext,
  commandName: string,
  fn: () => Promise<T>,
  options?: Partial<WriterLockOptions>,
): Promise<T> {
  const lock = await acquireWriterLock(context, commandName, resolveWriterLockOptions(options));
  let callbackError: unknown = null;

  try {
    return await fn();
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      await lock.release();
    } catch (error) {
      if (callbackError) {
        throw new GitMarkError('WRITER_LOCK_RELEASE_FAILED', 'Writer lock release failed.', 1, error);
      }
      throw error;
    }
  }
}

export async function inspectWriterLock(
  context: CommandContext,
  options?: Partial<WriterLockOptions>,
): Promise<WriterLockInspection> {
  const resolved = resolveWriterLockOptions(options);
  const paths = getLockPaths(context);

  try {
    const stat = await fs.stat(paths.directoryPath);
    if (!stat.isDirectory()) {
      return {
        exists: false,
        stale: false,
        heartbeatAgeMs: null,
        status: 'absent',
        ownerSummary: '',
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        exists: false,
        stale: false,
        heartbeatAgeMs: null,
        status: 'absent',
        ownerSummary: '',
      };
    }
    throw error;
  }

  const heartbeatAgeMs = await readHeartbeatAgeMs(paths);
  const stale = heartbeatAgeMs > resolved.staleHeartbeatMs;
  return {
    exists: true,
    stale,
    heartbeatAgeMs,
    status: stale ? 'stale' : 'active',
    ownerSummary: await readOwnerSummary(paths),
  };
}
