import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultRuntimeConfig } from './index.ts';
import { GitMarkError } from './errors.ts';
import { ensureDir, writeTextAtomic } from './fs.ts';
import { parseRuntimeConfig, stringifyRuntimeConfig } from './toml.ts';
import type { RuntimeConfig } from './types.ts';

export async function loadRuntimeConfig(configPath: string): Promise<RuntimeConfig> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = parseRuntimeConfig(raw);
    const defaults = defaultRuntimeConfig();
    return {
      storage: {
        ...defaults.storage,
        ...(parsed.storage ?? {}),
        root: String((parsed.storage as Record<string, unknown> | undefined)?.root ?? defaults.storage.root),
        temp_root: String((parsed.storage as Record<string, unknown> | undefined)?.temp_root ?? defaults.storage.temp_root),
        max_temp_size_mb: Number(
          (parsed.storage as Record<string, unknown> | undefined)?.max_temp_size_mb ?? defaults.storage.max_temp_size_mb,
        ),
      },
      network: {
        ...defaults.network,
        ...(parsed.network ?? {}),
        git_timeout_sec: Number(
          (parsed.network as Record<string, unknown> | undefined)?.git_timeout_sec ?? defaults.network.git_timeout_sec,
        ),
        allow_lfs:
          Boolean((parsed.network as Record<string, unknown> | undefined)?.allow_lfs ?? defaults.network.allow_lfs),
      },
      hooks: {
        ...defaults.hooks,
        ...(parsed.hooks ?? {}),
        module: String((parsed.hooks as Record<string, unknown> | undefined)?.module ?? defaults.hooks.module),
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return defaultRuntimeConfig();
    }
    throw new GitMarkError(
      'CONFIG_INVALID',
      `Could not load config file ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      1,
      error,
    );
  }
}

export async function ensureConfigFile(configPath: string): Promise<void> {
  const defaults = defaultRuntimeConfig();
  await ensureDir(path.dirname(configPath));
  try {
    await fs.access(configPath);
  } catch {
    await writeTextAtomic(configPath, stringifyRuntimeConfig(defaults));
  }
}
