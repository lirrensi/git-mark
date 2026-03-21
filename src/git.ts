import { spawn } from 'node:child_process';
import path from 'node:path';
import { GitMarkError } from './errors.ts';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

let gitAvailability: Promise<void> | null = null;
const DEFAULT_GIT_TIMEOUT_MS = 180_000;

export function gitEnv(allowLfs: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...(allowLfs ? {} : { GIT_LFS_SKIP_SMUDGE: '1' }),
  };
}

export function runGit(args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const clearGitTimer = (): void => {
      clearTimeout(timer);
    };

    const rejectOnce = (error: GitMarkError): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearGitTimer();
      reject(error);
    };

    const resolveOnce = (result: GitResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearGitTimer();
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      child.kill();
      rejectOnce(
        new GitMarkError(
          'GIT_TIMEOUT',
          `git ${args.join(' ')} timed out after ${timeoutMs / 1000} seconds.`,
        ),
      );
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (timedOut) {
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (timedOut) {
        return;
      }
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        rejectOnce(new GitMarkError('GIT_UNAVAILABLE', 'git is not accessible on PATH.'));
        return;
      }
      rejectOnce(new GitMarkError('GIT_UNAVAILABLE', `git could not be started: ${error.message}`));
    });
    child.on('close', (code) => {
      if (timedOut) {
        clearGitTimer();
        return;
      }
      if (code === 0) {
        resolveOnce({ stdout, stderr, code: 0 });
        return;
      }
      rejectOnce(
        new GitMarkError(
          'GIT_COMMAND_FAILED',
          `git ${args.join(' ')} failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        ),
      );
    });
  });
}

export function ensureGitAccessible(): Promise<void> {
  if (!gitAvailability) {
    gitAvailability = runGit(['--version']).then(() => undefined);
  }
  return gitAvailability;
}

export async function cloneRemote(
  remote: string,
  destination: string,
  allowLfs: boolean,
  timeoutMs?: number,
): Promise<void> {
  await runGit(['clone', '--no-tags', '--origin', 'origin', remote, destination], {
    env: gitEnv(allowLfs),
    timeoutMs,
  });
}

export async function fetchRemote(
  repoPath: string,
  remote = 'origin',
  allowLfs: boolean,
  timeoutMs?: number,
): Promise<void> {
  await runGit(['fetch', '--prune', remote], {
    cwd: repoPath,
    env: gitEnv(allowLfs),
    timeoutMs,
  });
}

export async function currentBranch(repoPath: string, timeoutMs?: number): Promise<string> {
  const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoPath, timeoutMs });
  return result.stdout.trim();
}

export async function currentCommit(repoPath: string, timeoutMs?: number): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath, timeoutMs });
  return result.stdout.trim();
}

export async function checkoutBranch(repoPath: string, branch: string, timeoutMs?: number): Promise<void> {
  await runGit(['checkout', '--force', branch], { cwd: repoPath, timeoutMs });
}

export async function resetToRemoteBranch(
  repoPath: string,
  branch: string,
  remote = 'origin',
  timeoutMs?: number,
): Promise<void> {
  await checkoutBranch(repoPath, branch, timeoutMs);
  await runGit(['reset', '--hard', `${remote}/${branch}`], { cwd: repoPath, timeoutMs });
}

export async function checkoutCommit(repoPath: string, commit: string, timeoutMs?: number): Promise<void> {
  await runGit(['checkout', '--force', commit], { cwd: repoPath, timeoutMs });
}

export async function listFiles(repoPath: string, targetPath = '.', depth = 2, limit = 24): Promise<string[]> {
  const entries: string[] = [];

  async function walk(currentPath: string, currentDepth: number, prefix: string): Promise<void> {
    if (entries.length >= limit || currentDepth < 0) {
      return;
    }
    const directory = path.join(repoPath, currentPath);
    const items = await import('node:fs/promises').then((fs) => fs.readdir(directory, { withFileTypes: true }));
    for (const item of items) {
      if (entries.length >= limit) {
        break;
      }
      const nextRelative = path.posix.join(prefix, item.name);
      entries.push(item.isDirectory() ? `${nextRelative}/` : nextRelative);
      if (item.isDirectory() && currentDepth > 0) {
        await walk(path.join(currentPath, item.name), currentDepth - 1, nextRelative);
      }
    }
  }

  await walk(targetPath, depth, '');
  return entries;
}
