import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function removeIfExists(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

export async function readTextIfExists(targetPath: string): Promise<string | null> {
  if (!(await pathExists(targetPath))) {
    return null;
  }
  return fs.readFile(targetPath, 'utf8');
}

export async function writeText(targetPath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, content, 'utf8');
}

export async function writeTextAtomic(targetPath: string, content: string): Promise<void> {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await ensureDir(directory);
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, targetPath);
}
