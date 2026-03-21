#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureToolDirectories, getBootstrapPaths, resolveToolPaths } from './env.ts';
import { formatRedError, GitMarkError } from './errors.ts';
import { ImplementationLogger } from './log.ts';
import { ensureConfigFile, loadRuntimeConfig } from './config.ts';
import {
    cleanupTempMaterializations,
    cleanupRuntime,
    doctorRuntime,
    ensureGitAvailableOrThrow,
    addRecord,
    currentPath,
    ensureUniqueId,
    findExistingPackageRecord,
    freezeRecord,
    inferPackageId,
    inspectAddSource,
    listRecords,
    loadRecord,
    peekRecord,
    pinRecord,
    reconcileRuntimeState,
    removeRecord,
    replaceRecord,
    searchRecords,
    syncKeptRecords,
    unfreezeRecord,
    unpinRecord,
    updateAllRecords,
    updateRecord,
} from './index.ts';
import { getCliHelpText } from './help.ts';
import {
    collectAddDraft,
    createPromptAdapter,
    formatInspection,
    promptForUniqueId,
    resolveDuplicateAdd,
    suggestSummary,
    type PromptAdapter,
} from './add.ts';
import { withWriterLock } from './lock.ts';
import type { CommandContext, PackageRecord } from './types.ts';

const WRITER_COMMANDS = new Set([
    'add',
    'peek',
    'load',
    'update',
    'updateall',
    'pin',
    'unpin',
    'freeze',
    'unfreeze',
    'remove',
    'rm',
    'cleanup',
    'sync',
    'edit',
]);

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

function normalizeInlineText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function truncateInlineText(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function recordSnippet(record: PackageRecord): string {
    const primary = normalizeInlineText(record.summary ?? '');
    if (primary.length > 0) {
        return truncateInlineText(primary, 72);
    }
    const fallback = normalizeInlineText(record.description ?? '');
    if (fallback.length > 0) {
        return truncateInlineText(fallback, 72);
    }
    return '';
}

export function formatRecordLines(record: PackageRecord, includeDetails: boolean, useColor: boolean): string[] {
    const style = (text: string, code: string) => (useColor ? `${code}${text}\x1b[0m` : text);
    const flags = [
        record.pinned !== false ? 'pinned' : 'hidden',
        record.kept ? 'kept' : 'temp',
        record.frozen ? `frozen@${record.commit ?? ''}` : 'live',
    ].join(', ');
    const snippet = recordSnippet(record);
    const lines = [
        [
            style(record.id, '\x1b[36m'),
            snippet ? style(snippet, '\x1b[37m') : '',
        ].filter(Boolean).join('  '),
        `  ${style(`(${flags})`, '\x1b[2m')}`,
    ];
    if (includeDetails && record.subpath) {
        lines.push(`  ${style(`subpath: ${record.subpath}`, '\x1b[2m')}`);
    }
    return lines;
}

export async function resolveAddTarget(options: {
    records: PackageRecord[];
    requestedId: string;
    existingMatch?: PackageRecord;
    interactive: boolean;
    prompt?: PromptAdapter;
}): Promise<{ mode: 'add' | 'replace'; id: string }> {
    const { records, requestedId, existingMatch, interactive, prompt } = options;
    if (!existingMatch) {
        return { mode: 'add', id: requestedId };
    }
    if (!interactive || !prompt) {
        throw new GitMarkError(
            'DUPLICATE_PACKAGE',
            `Package ${existingMatch.id} already matches ${existingMatch.remotes[0]}${existingMatch.subpath ? `#${existingMatch.subpath}` : ''}. Re-run interactively to replace it or keep both under another id.`,
        );
    }
    const duplicateResolution = await resolveDuplicateAdd(prompt, existingMatch.id);
    if (duplicateResolution === 'cancel') {
        throw new GitMarkError('ADD_CANCELLED', `Add cancelled for duplicate package ${existingMatch.id}.`);
    }
    if (duplicateResolution === 'replace') {
        return { mode: 'replace', id: existingMatch.id };
    }
    if (records.some((entry) => entry.id === requestedId)) {
        const id = await promptForUniqueId(prompt, ensureUniqueId(records, requestedId), records.map((entry) => entry.id));
        return { mode: 'add', id };
    }
    return { mode: 'add', id: requestedId };
}

function printRecords(records: PackageRecord[], includeDetails: boolean): void {
    if (records.length === 0) {
        console.log('No packages found.');
        return;
    }
    for (const record of records) {
        for (const line of formatRecordLines(record, includeDetails, process.stdout.isTTY)) {
            console.log(line);
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

export function resolveEditorCommand(platform = process.platform, env = process.env): string {
    return env.VISUAL || env.EDITOR || (platform === 'win32' ? 'notepad.exe' : 'vi');
}

async function launchEditorForIndex(indexPath: string): Promise<void> {
    const editor = resolveEditorCommand();
    await new Promise<void>((resolve, reject) => {
        const child = spawn(editor, [indexPath], {
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });
        child.once('error', (error) => {
            reject(new GitMarkError('EDITOR_LAUNCH_FAILED', `Could not launch editor ${editor}: ${error.message}`, 1, error));
        });
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new GitMarkError('EDITOR_EXIT_FAILED', `Editor ${editor} exited from signal ${signal}.`));
                return;
            }
            if ((code ?? 0) !== 0) {
                reject(new GitMarkError('EDITOR_EXIT_FAILED', `Editor ${editor} exited with code ${code ?? 0}.`));
                return;
            }
            resolve();
        });
    });
}

async function runWriterPreflight(context: CommandContext): Promise<void> {
    await reconcileRuntimeState(context, {
        pruneOrphanRepoDirectories: true,
        pruneOrphanTempDirectories: true,
    });
    await cleanupTempMaterializations(context);
}

async function executeCommand(
    command: string,
    rawArgs: string[],
    context: CommandContext,
    logger: ImplementationLogger,
): Promise<void> {
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
            const suggestedSummary = suggestSummary(inspection);
            const defaults = {
                summary: summaryFlag ?? suggestedSummary,
                description: descriptionFlag ?? (!interactive ? inspection.readmeExcerpt ?? '' : undefined),
                resources: resourceFlag.length > 0 ? resourceFlag : undefined,
                pinned: typeof values.pinned === 'boolean' ? values.pinned : undefined,
                kept: typeof values.kept === 'boolean' ? values.kept : undefined,
                discoverable: typeof values.discoverable === 'boolean' ? values.discoverable : undefined,
            };
            const prompt = interactive ? await createPromptAdapter() : null;
            if (interactive) {
                console.log(formatInspection(inspection));
                console.log(`  suggested summary: ${suggestedSummary}`);
            }
            const draft = interactive
                ? await collectAddDraft(inspection, defaults, prompt as Awaited<ReturnType<typeof createPromptAdapter>>)
                : {
                    summary: defaults.summary ?? '',
                    description: defaults.description ?? '',
                    resources: defaults.resources ?? [],
                    pinned: defaults.pinned ?? true,
                    kept: defaults.kept ?? true,
                    discoverable: defaults.discoverable ?? true,
                };
            const requestedId = typeof values.id === 'string' ? values.id : parsed;
            const records = await listRecords(context, true);
            const existingMatch = await findExistingPackageRecord(context, source);
            const addTarget = await resolveAddTarget({
                records,
                requestedId,
                existingMatch,
                interactive,
                prompt: prompt ?? undefined,
            });
            const recordInput = {
                summary: draft.summary,
                description: draft.description,
                resources: draft.resources,
                pinned: draft.pinned,
                kept: draft.kept,
                discoverable: draft.discoverable,
                frozen: toBoolean(values.frozen, false),
                commit: typeof values.commit === 'string' ? values.commit : '',
            };
            const record = addTarget.mode === 'replace'
                ? await replaceRecord(context, addTarget.id, source, recordInput)
                : await addRecord(context, source, {
                    id: addTarget.id,
                    ...recordInput,
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
        case 'remove':
        case 'rm': {
            const id = rawArgs[1];
            if (!id) {
                throw new GitMarkError('USAGE', `${command} requires a package id.`);
            }
            const removed = await removeRecord(context, id);
            console.log(
                `removed ${removed.removedId} (temp dirs=${removed.deletedTempDirectories + removed.reconciliation.deletedTempDirectories}, repo dirs=${removed.deletedRepoDirectories + removed.reconciliation.deletedRepoDirectories})`,
            );
            await logger.info('remove', { id });
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
        case 'doctor': {
            const report = await doctorRuntime(context);
            if (report.clean) {
                console.log(`doctor clean (lock=${report.lockStatus})`);
            } else {
                for (const issue of report.issues) {
                    console.log(`- ${issue}`);
                }
                process.exitCode = 1;
            }
            await logger.info('doctor', { clean: report.clean, issues: report.issues.length, lockStatus: report.lockStatus });
            return;
        }
        case 'cleanup': {
            const cleaned = await cleanupRuntime(context);
            console.log(
                `cleanup deleted temp dirs=${cleaned.deletedTempDirectories}, repo dirs=${cleaned.deletedRepoDirectories}, temp state=${cleaned.removedTempStateEntries + cleaned.clearedTrackedTempStateEntries}, repo state=${cleaned.removedRepoStateEntries}`,
            );
            await logger.info('cleanup', {
                deletedTempDirectories: cleaned.deletedTempDirectories,
                deletedRepoDirectories: cleaned.deletedRepoDirectories,
                removedTempStateEntries: cleaned.removedTempStateEntries,
                removedRepoStateEntries: cleaned.removedRepoStateEntries,
                clearedTrackedTempStateEntries: cleaned.clearedTrackedTempStateEntries,
            });
            return;
        }
        case 'sync': {
            const synced = await syncKeptRecords(context);
            console.log(`synced ${synced.keptPackagesProcessed} kept package(s)`);
            await logger.info('sync', {
                keptPackagesProcessed: synced.keptPackagesProcessed,
                removedTempStateEntries: synced.reconciliation.removedTempStateEntries,
                removedRepoStateEntries: synced.reconciliation.removedRepoStateEntries,
                deletedTempDirectories: synced.reconciliation.deletedTempDirectories,
                deletedRepoDirectories: synced.reconciliation.deletedRepoDirectories,
                clearedTrackedTempStateEntries: synced.reconciliation.clearedTrackedTempStateEntries,
            });
            return;
        }
        case 'edit': {
            await launchEditorForIndex(context.paths.indexPath);
            await reconcileRuntimeState(context, {
                pruneOrphanRepoDirectories: true,
                pruneOrphanTempDirectories: true,
            });
            console.log(context.paths.indexPath);
            await logger.info('edit', { indexPath: context.paths.indexPath });
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

        if (WRITER_COMMANDS.has(command)) {
            await withWriterLock(context, command, async () => {
                await runWriterPreflight(context);
                await executeCommand(command, rawArgs, context, logger as ImplementationLogger);
            });
            return;
        }

        await executeCommand(command, rawArgs, context, logger);
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
