#!/usr/bin/env -S node --experimental-strip-types
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureToolDirectories, getBootstrapPaths, resolveToolPaths } from './env.ts';
import { formatRedError, GitMarkError } from './errors.ts';
import { ImplementationLogger } from './log.ts';
import { ensureConfigFile, loadRuntimeConfig } from './config.ts';
import {
  cleanupTempMaterializations,
  ensureGitAvailableOrThrow,
  addRecord,
  currentPath,
  freezeRecord,
  inferPackageId,
  inspectAddSource,
  listRecords,
  loadRecord,
  peekRecord,
  pinRecord,
  searchRecords,
  unfreezeRecord,
  unpinRecord,
  updateAllRecords,
  updateRecord,
} from './index.ts';
import { getCliHelpText } from './help.ts';
import { collectAddDraft, createPromptAdapter, formatInspection, suggestSummary } from './add.ts';
import type { CommandContext, PackageRecord } from './types.ts';

function printUsage(): void {
  console.log(getCliHelpText());
}

function parseOptions(args: string[]): { values: Record<string, string | boolean | string[]>; remaining: string[] } {
  const values: Record<string, string | boolean | string[]> = {};
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      remaining.push(token);
      continue;
    }
    if (token.startsWith('--no-')) {
      values[token.slice(5)] = false;
      continue;
    }
    const equalsIndex = token.indexOf('=');
    if (equalsIndex !== -1) {
      const key = token.slice(2, equalsIndex);
      values[key] = token.slice(equalsIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith('--')) {
      const existing = values[key];
      const nextValue = next;
      if (existing === undefined) {
        values[key] = nextValue;
      } else if (Array.isArray(existing)) {
        existing.push(nextValue);
      } else {
        values[key] = [String(existing), nextValue];
      }
      index += 1;
      continue;
    }
    values[key] = true;
  }
  return { values, remaining };
}

function toBoolean(value: string | boolean | string[] | undefined, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value === 'false' || value === '0' || value === 'no') {
      return false;
    }
    if (value === 'true' || value === '1' || value === 'yes') {
      return true;
    }
  }
  return fallback;
}

function toStringArray(value: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }
  return [];
}

function parseIntegerOption(
  value: string | boolean | string[] | undefined,
  fallback: number,
  minimum = 0,
): number {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (parsed >= minimum) {
      return parsed;
    }
  }
  return fallback;
}

function printRecords(records: PackageRecord[], includeDetails: boolean): void {
  if (records.length === 0) {
    console.log('No packages found.');
    return;
  }
  for (const record of records) {
    const flags = [
      record.pinned !== false ? 'pinned' : 'hidden',
      record.kept ? 'kept' : 'temp',
      record.frozen ? `frozen@${record.commit ?? ''}` : 'live',
    ].join(' | ');
    console.log(`${record.id}  ${flags}`);
    if (includeDetails) {
      if (record.summary) {
        console.log(`  summary: ${record.summary}`);
      }
      if (record.subpath) {
        console.log(`  subpath: ${record.subpath}`);
      }
    }
  }
}

function printSearchResults(results: Array<{ record: PackageRecord; score: number }>): void {
  if (results.length === 0) {
    console.log('No matches.');
    return;
  }
  for (const hit of results) {
    console.log(`${hit.record.id}  score=${hit.score}`);
    if (hit.record.summary) {
      console.log(`  summary: ${hit.record.summary}`);
    }
  }
}

function printContinuationHint(command: string, offset: number, limit: number, total: number): void {
  const nextOffset = offset + limit;
  if (nextOffset >= total) {
    return;
  }
  console.log(`More results available. Use \`${command} --offset ${nextOffset} --limit ${limit}\` to continue.`);
}

function printPeek(record: PackageRecord, preview: string[], readme?: string): void {
  console.log(record.id);
  console.log(`  remotes: ${record.remotes.join(', ')}`);
  if (record.subpath) {
    console.log(`  subpath: ${record.subpath}`);
  }
  console.log(`  pinned: ${record.pinned !== false}`);
  console.log(`  kept: ${record.kept !== false}`);
  console.log(`  discoverable: ${record.discoverable !== false}`);
  console.log(`  frozen: ${record.frozen === true}`);
  if (record.summary) {
    console.log(`  summary: ${record.summary}`);
  }
  if (record.description) {
    console.log(`  description: ${record.description}`);
  } else if (readme) {
    console.log(`  readme: ${readme}`);
  }
  if (record.resources && record.resources.length > 0) {
    console.log(`  resources: ${record.resources.join(', ')}`);
  }
  if (preview.length > 0) {
    console.log('  preview:');
    for (const line of preview) {
      console.log(`    ${line}`);
    }
  } else {
    console.log('  preview: (not available)');
  }
}

export async function runCli(rawArgs: string[]): Promise<void> {
  const bootstrapPaths = getBootstrapPaths();

  const command = rawArgs[0];
  if (!command || command === '--help' || command === '-h' || command === '-help' || command === 'help') {
    printUsage();
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log('0.2.0');
    return;
  }

  let logger: ImplementationLogger | null = null;

  try {
    await ensureConfigFile(bootstrapPaths.configPath);
    const config = await loadRuntimeConfig(bootstrapPaths.configPath);
    const paths = resolveToolPaths(bootstrapPaths, config);
    await ensureToolDirectories(paths);
    logger = new ImplementationLogger(paths.logPath);
    const context: CommandContext = { paths, config };

    await cleanupTempMaterializations(context);

    switch (command) {
      case 'add': {
        const source = rawArgs[1];
        if (!source) {
          throw new GitMarkError('USAGE', 'add requires a remote source.');
        }
        const { values } = parseOptions(rawArgs.slice(2));
        const parsed = inferPackageId(source.split('#', 1)[0], source.includes('#') ? source.split('#', 2)[1] : undefined);
        const inspection = await inspectAddSource(context, source);
        const interactive = process.stdin.isTTY && process.stdout.isTTY && !toBoolean(values.yes, false);
        const summaryFlag = typeof values.summary === 'string' ? values.summary : undefined;
        const descriptionFlag = typeof values.description === 'string' ? values.description : undefined;
        const resourceFlag = toStringArray(values.resource ?? values.resources);
        const defaults = {
          summary: summaryFlag ?? (!interactive ? suggestSummary(inspection) : undefined),
          description:
            descriptionFlag ?? (!interactive ? inspection.readmeExcerpt ?? '' : undefined),
          resources: resourceFlag.length > 0 ? resourceFlag : undefined,
          pinned: typeof values.pinned === 'boolean' ? values.pinned : undefined,
          kept: typeof values.kept === 'boolean' ? values.kept : undefined,
          discoverable: typeof values.discoverable === 'boolean' ? values.discoverable : undefined,
        };
        if (interactive) {
          console.log(formatInspection(inspection));
          console.log(`  suggested summary: ${suggestSummary(inspection)}`);
        }
        const draft = interactive
          ? await collectAddDraft(inspection, defaults, await createPromptAdapter())
          : {
              summary: defaults.summary ?? '',
              description: defaults.description ?? '',
              resources: defaults.resources ?? [],
              pinned: defaults.pinned ?? true,
              kept: defaults.kept ?? true,
              discoverable: defaults.discoverable ?? true,
            };
        const record = await addRecord(context, source, {
          id: typeof values.id === 'string' ? values.id : parsed,
          summary: draft.summary,
          description: draft.description,
          resources: draft.resources,
          pinned: draft.pinned,
          kept: draft.kept,
          discoverable: draft.discoverable,
          frozen: toBoolean(values.frozen, false),
          commit: typeof values.commit === 'string' ? values.commit : '',
        });
        console.log(record.id);
        await logger.info('add', { id: record.id, remote: record.remotes[0] });
        return;
      }
      case 'list': {
        const records = await listRecords(context, false);
        printRecords(records, true);
        await logger.info('list', { count: records.length });
        return;
      }
      case 'list-all': {
        const { values } = parseOptions(rawArgs.slice(1));
        const limit = parseIntegerOption(values.limit, 15, 1);
        const offset = parseIntegerOption(values.offset, 0, 0);
        const records = await listRecords(context, true);
        const page = records.slice(offset, offset + limit);
        printRecords(page, true);
        printContinuationHint('gmk list-all', offset, limit, records.length);
        await logger.info('list-all', { count: page.length, total: records.length, limit, offset });
        return;
      }
      case 'search': {
        const { values, remaining } = parseOptions(rawArgs.slice(1));
        const query = remaining.join(' ').trim();
        const limit = parseIntegerOption(values.limit, 10, 1);
        const offset = parseIntegerOption(values.offset, 0, 0);
        const results = await searchRecords(context, query, limit, offset);
        printSearchResults(results.hits);
        printContinuationHint(`gmk search ${query}`, offset, limit, results.total);
        await logger.info('search', { query, count: results.hits.length, total: results.total, limit, offset });
        return;
      }
      case 'peek': {
        const id = rawArgs[1];
        if (!id) {
          throw new GitMarkError('USAGE', 'peek requires a package id.');
        }
        const result = await peekRecord(context, id);
        printPeek(result.record, result.preview, result.readme);
        await logger.info('peek', { id });
        return;
      }
      case 'load': {
        const id = rawArgs[1];
        if (!id) {
          throw new GitMarkError('USAGE', 'load requires a package id.');
        }
        const loadedPath = await loadRecord(context, id);
        console.log(loadedPath);
        await logger.info('load', { id, path: loadedPath });
        return;
      }
      case 'path': {
        const id = rawArgs[1];
        if (!id) {
          throw new GitMarkError('USAGE', 'path requires a package id.');
        }
        const localPath = await currentPath(context, id);
        console.log(localPath);
        await logger.info('path', { id, path: localPath });
        return;
      }
      case 'update': {
        const id = rawArgs[1];
        if (!id) {
          throw new GitMarkError('USAGE', 'update requires a package id.');
        }
        const updatedPath = await updateRecord(context, id);
        console.log(updatedPath);
        await logger.info('update', { id, path: updatedPath });
        return;
      }
      case 'pin': {
        const id = rawArgs[1];
        if (!id) {
          throw new GitMarkError('USAGE', 'pin requires a package id.');
        }
        const record = await pinRecord(context, id);
        console.log(`${record.id} pinned`);
        await logger.info('pin', { id });
        return;
      }
      case 'unpin': {
        const id = rawArgs[1];
        if (!id) {
          throw new GitMarkError('USAGE', 'unpin requires a package id.');
        }
        const record = await unpinRecord(context, id);
        console.log(`${record.id} unpinned`);
        await logger.info('unpin', { id });
        return;
      }
      case 'updateall': {
        const count = await updateAllRecords(context);
        console.log(`updated ${count} package(s)`);
        await logger.info('updateall', { count });
        return;
      }
      case 'freeze': {
        const id = rawArgs[1];
        if (!id) {
          throw new GitMarkError('USAGE', 'freeze requires a package id.');
        }
        const record = await freezeRecord(context, id);
        console.log(`${record.id} frozen @ ${record.commit}`);
        await logger.info('freeze', { id, commit: record.commit });
        return;
      }
      case 'unfreeze': {
        const id = rawArgs[1];
        if (!id) {
          throw new GitMarkError('USAGE', 'unfreeze requires a package id.');
        }
        const record = await unfreezeRecord(context, id);
        console.log(`${record.id} unfrozen`);
        await logger.info('unfreeze', { id });
        return;
      }
      default:
        throw new GitMarkError('USAGE', `Unknown command: ${command}`);
    }
  } catch (error) {
    if (logger) {
      await logger.error('command failed', {
        command,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    console.error(formatRedError(error));
    if (error instanceof GitMarkError && error.status > 1) {
      process.exitCode = error.status;
    } else {
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runCli(process.argv.slice(2));
}
