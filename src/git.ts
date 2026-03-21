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
}

let gitAvailability: Promise<void> | null = null;

export function gitEnv(allowLfs: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...(allowLfs ? {} : { GIT_LFS_SKIP_SMUDGE: '1' }),
  };
}

export function runGit(args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new GitMarkError('GIT_UNAVAILABLE', 'git is not accessible on PATH.'));
        return;
      }
      reject(new GitMarkError('GIT_UNAVAILABLE', `git could not be started: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code: 0 });
        return;
      }
      reject(
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

export async function cloneRemote(remote: string, destination: string, allowLfs: boolean): Promise<void> {
  await runGit(['clone', '--no-tags', '--origin', 'origin', remote, destination], {
    env: gitEnv(allowLfs),
  });
}

export async function fetchRemote(repoPath: string, remote = 'origin', allowLfs: boolean): Promise<void> {
  await runGit(['fetch', '--prune', remote], {
    cwd: repoPath,
    env: gitEnv(allowLfs),
  });
}

export async function currentBranch(repoPath: string): Promise<string> {
  const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoPath });
  return result.stdout.trim();
}

export async function currentCommit(repoPath: string): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
  return result.stdout.trim();
}

export async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  await runGit(['checkout', '--force', branch], { cwd: repoPath });
}

export async function resetToRemoteBranch(repoPath: string, branch: string, remote = 'origin'): Promise<void> {
  await checkoutBranch(repoPath, branch);
  await runGit(['reset', '--hard', `${remote}/${branch}`], { cwd: repoPath });
}

export async function checkoutCommit(repoPath: string, commit: string): Promise<void> {
  await runGit(['checkout', '--force', commit], { cwd: repoPath });
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

