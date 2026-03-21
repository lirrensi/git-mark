import os from 'node:os';
import path from 'node:path';
import { ensureDir } from './fs.ts';
import type { ToolPaths } from './types.ts';

export function getHomeDir(): string {
  return os.homedir();
}

export function expandHome(input: string): string {
  if (input === '~') {
    return getHomeDir();
  }
  if (input.startsWith('~/')) {
    return path.join(getHomeDir(), input.slice(2));
  }
  return input;
}

export function getToolPaths(): ToolPaths {
  const home = getHomeDir();
  const storageRoot = expandHome('~/.gitmark');
  return {
    home,
    indexPath: expandHome('~/.gitmarks.toml'),
    configPath: path.join(storageRoot, 'config.toml'),
    logPath: path.join(storageRoot, 'history.log'),
    statePath: path.join(storageRoot, 'state.json'),
    storageRoot,
    reposRoot: path.join(storageRoot, 'repos'),
    tempRoot: path.join(storageRoot, 'tmp'),
  };
}

export async function ensureToolDirectories(paths: ToolPaths): Promise<void> {
  await ensureDir(paths.storageRoot);
  await ensureDir(paths.reposRoot);
  await ensureDir(paths.tempRoot);
}
