import type { PackageRecord, RuntimeConfig } from './types.ts';

function formatTomlError(target: 'index' | 'config', lineNumber: number, message: string): Error {
  return new Error(`Invalid ${target} TOML at line ${lineNumber}: ${message}`);
}

function stripComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inDouble) {
      escaped = true;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '#' && !inDouble && !inSingle) {
      return line.slice(0, index);
    }
  }
  return line;
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;
  let depth = 0;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inDouble) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"' && !inSingle) {
      current += char;
      inDouble = !inDouble;
      continue;
    }
    if (char === "'" && !inDouble) {
      current += char;
      inSingle = !inSingle;
      continue;
    }
    if (char === '[' && !inDouble && !inSingle) {
      depth += 1;
    }
    if (char === ']' && !inDouble && !inSingle) {
      depth -= 1;
    }
    if (char === separator && !inDouble && !inSingle && depth === 0) {
      if (current.trim().length > 0) {
        parts.push(current.trim());
      }
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

function parseStringValue(raw: string): string {
  const text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    return JSON.parse(text);
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1);
  }
  return text;
}

function parseTomlValue(raw: string): string | number | boolean | string[] {
  const text = raw.trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    const body = text.slice(1, -1).trim();
    if (body.length === 0) {
      return [];
    }
    return splitTopLevel(body, ',').map((entry) => {
      const value = parseTomlValue(entry);
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      return value.join(', ');
    });
  }
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  return parseStringValue(text);
}

function stringifyTomlValue(value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stringifyTomlValue(entry)).join(', ')}]`;
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

function boolOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function parsePackageIndex(text: string): PackageRecord[] {
  const records: PackageRecord[] = [];
  let current: Partial<PackageRecord> | null = null;
  let sawContent = false;

  for (const [lineIndex, rawLine] of text.split('\n').entries()) {
    const lineNumber = lineIndex + 1;
    const line = stripComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    sawContent = true;
    if (line === '[[package]]') {
      if (current) {
        validatePackageRecord(current, records.length, lineNumber - 1);
      }
      current = {};
      records.push(current as PackageRecord);
      continue;
    }
    if (!current) {
      throw formatTomlError('index', lineNumber, 'package fields must appear after [[package]].');
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      throw formatTomlError('index', lineNumber, `expected key = value, got ${JSON.stringify(line)}.`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = parseTomlValue(line.slice(separatorIndex + 1));
    if (key === 'remotes' || key === 'resources') {
      current[key] = Array.isArray(value) ? value : [String(value)];
      continue;
    }
    if (key === 'pinned' || key === 'kept' || key === 'discoverable' || key === 'frozen') {
      current[key] = boolOrDefault(value, false);
      continue;
    }
    if (key === 'id' || key === 'subpath' || key === 'summary' || key === 'description' || key === 'commit') {
      current[key] = String(value);
      continue;
    }
    throw formatTomlError('index', lineNumber, `unknown package key ${JSON.stringify(key)}.`);
  }

  if (current) {
    validatePackageRecord(current, records.length, text.split('\n').length);
  }
  if (!sawContent) {
    return [];
  }

  return records.map((record) => ({
    id: record.id ?? '',
    remotes: record.remotes ?? [],
    subpath: record.subpath,
    summary: record.summary,
    description: record.description,
    resources: record.resources,
    pinned: boolOrDefault(record.pinned, false),
    kept: boolOrDefault(record.kept, false),
    discoverable: boolOrDefault(record.discoverable, true),
    frozen: boolOrDefault(record.frozen, false),
    commit: record.commit,
  }));
}

function validatePackageRecord(record: Partial<PackageRecord>, index: number, lineNumber: number): void {
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw formatTomlError('index', lineNumber, `package #${index} is missing a valid id.`);
  }
  if (!Array.isArray(record.remotes) || record.remotes.length === 0) {
    throw formatTomlError('index', lineNumber, `package ${JSON.stringify(record.id)} is missing remotes.`);
  }
}

export function stringifyPackageIndex(records: PackageRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    lines.push('[[package]]');
    lines.push(`id = ${JSON.stringify(record.id)}`);
    lines.push(`remotes = ${stringifyTomlValue(record.remotes ?? [])}`);
    if (record.subpath) {
      lines.push(`subpath = ${JSON.stringify(record.subpath)}`);
    }
    if (record.summary !== undefined) {
      lines.push(`summary = ${JSON.stringify(record.summary)}`);
    }
    if (record.description !== undefined) {
      lines.push(`description = ${JSON.stringify(record.description)}`);
    }
    if (record.resources && record.resources.length > 0) {
      lines.push(`resources = ${stringifyTomlValue(record.resources)}`);
    }
    lines.push(`pinned = ${record.pinned ? 'true' : 'false'}`);
    lines.push(`kept = ${record.kept ? 'true' : 'false'}`);
    lines.push(`discoverable = ${record.discoverable === false ? 'false' : 'true'}`);
    lines.push(`frozen = ${record.frozen ? 'true' : 'false'}`);
    if (record.commit !== undefined) {
      lines.push(`commit = ${JSON.stringify(record.commit)}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function parseRuntimeConfig(text: string): Partial<RuntimeConfig> {
  const config: Partial<RuntimeConfig> = {};
  let section: 'storage' | 'network' | 'hooks' | null = null;
  let sawContent = false;

  for (const [lineIndex, rawLine] of text.split('\n').entries()) {
    const lineNumber = lineIndex + 1;
    const line = stripComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    sawContent = true;
    if (line === '[storage]' || line === '[network]' || line === '[hooks]') {
      section = line.slice(1, -1) as 'storage' | 'network' | 'hooks';
      if (section === 'storage' && !config.storage) {
        config.storage = {} as RuntimeConfig['storage'];
      }
      if (section === 'network' && !config.network) {
        config.network = {} as RuntimeConfig['network'];
      }
      if (section === 'hooks' && !config.hooks) {
        config.hooks = {} as RuntimeConfig['hooks'];
      }
      continue;
    }
    if (!section) {
      throw formatTomlError('config', lineNumber, 'keys must appear inside [storage], [network], or [hooks].');
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      throw formatTomlError('config', lineNumber, `expected key = value, got ${JSON.stringify(line)}.`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = parseTomlValue(line.slice(separatorIndex + 1));
    if (section === 'storage' && config.storage) {
      (config.storage as unknown as Record<string, unknown>)[key] = value;
    }
    if (section === 'network' && config.network) {
      (config.network as unknown as Record<string, unknown>)[key] = value;
    }
    if (section === 'hooks' && config.hooks) {
      (config.hooks as unknown as Record<string, unknown>)[key] = value;
    }
  }

  if (!sawContent) {
    return config;
  }

  return config;
}

export function stringifyRuntimeConfig(config: RuntimeConfig): string {
  return [
    '[storage]',
    `root = ${JSON.stringify(config.storage.root)}`,
    `temp_root = ${JSON.stringify(config.storage.temp_root)}`,
    `max_temp_size_mb = ${config.storage.max_temp_size_mb}`,
    '',
    '[network]',
    `git_timeout_sec = ${config.network.git_timeout_sec}`,
    `allow_lfs = ${config.network.allow_lfs ? 'true' : 'false'}`,
    '',
    '[hooks]',
    `module = ${JSON.stringify(config.hooks.module)}`,
    '',
  ].join('\n');
}
