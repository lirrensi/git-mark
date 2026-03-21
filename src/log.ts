import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists } from './fs.ts';

function timestamp(): string {
  return new Date().toISOString();
}

function serializeLine(level: string, message: string, meta?: Record<string, unknown>): string {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp()} [${level}] ${message}${suffix}`;
}

async function rotateLines(filePath: string, maxLines: number): Promise<void> {
  const text = await fs.readFile(filePath, 'utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length <= maxLines) {
    return;
  }
  const trimmed = lines.slice(-maxLines);
  await fs.writeFile(filePath, `${trimmed.join('\n')}\n`, 'utf8');
}

export class ImplementationLogger {
  private readonly filePath: string;
  private readonly maxLines: number;

  constructor(filePath: string, maxLines = 1000) {
    this.filePath = filePath;
    this.maxLines = maxLines;
  }

  async write(level: string, message: string, meta?: Record<string, unknown>): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    const line = serializeLine(level, message, meta);
    if (await pathExists(this.filePath)) {
      await fs.appendFile(this.filePath, `${line}\n`, 'utf8');
      await rotateLines(this.filePath, this.maxLines);
      return;
    }
    await fs.writeFile(this.filePath, `${line}\n`, 'utf8');
  }

  info(message: string, meta?: Record<string, unknown>): Promise<void> {
    return this.write('info', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): Promise<void> {
    return this.write('error', message, meta);
  }
}
