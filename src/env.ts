import os from 'node:os';
import path from 'node:path';
import { ensureDir } from './fs.ts';
import type { BootstrapPaths, RuntimeConfig, ToolPaths } from './types.ts';

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

export function getBootstrapPaths(): BootstrapPaths {
  const home = getHomeDir();
  return {
    home,
    indexPath: expandHome('~/.gitmark/index.toml'),
    configPath: path.join(expandHome('~/.gitmark'), 'config.toml'),
  };
}

export function resolveToolPaths(bootstrapPaths: BootstrapPaths, config: RuntimeConfig): ToolPaths {
  const storageRoot = expandHome(config.storage.root);
  const tempRoot = expandHome(config.storage.temp_root);
  return {
    ...bootstrapPaths,
    logPath: path.join(storageRoot, 'history.log'),
    statePath: path.join(storageRoot, 'state.json'),
    storageRoot,
    reposRoot: path.join(storageRoot, 'repos'),
    tempRoot,
  };
}

export async function ensureToolDirectories(paths: ToolPaths): Promise<void> {
  await ensureDir(paths.storageRoot);
  await ensureDir(paths.reposRoot);
  await ensureDir(paths.tempRoot);
}
