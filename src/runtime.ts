import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export interface RuntimeLaunchCommand {
  command: string;
  args: string[];
}

export function resolveSiblingEntry(runtimeUrl: string, baseName: string): string {
  const currentFile = fileURLToPath(runtimeUrl);
  const extension = currentFile.endsWith('.ts') ? '.ts' : '.js';
  return path.join(path.dirname(currentFile), `${baseName}${extension}`);
}

export function buildNodeLaunchCommand(entryFile: string, args: string[] = []): RuntimeLaunchCommand {
  if (entryFile.endsWith('.ts')) {
    return {
      command: process.execPath,
      args: [require.resolve('tsx/cli'), entryFile, ...args],
    };
  }

  return {
    command: process.execPath,
    args: [entryFile, ...args],
  };
}
