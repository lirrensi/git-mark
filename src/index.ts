import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cloneRemote,
  currentBranch,
  currentCommit,
  ensureGitAccessible,
  fetchRemote,
  checkoutCommit,
  resetToRemoteBranch,
  runGit,
} from './git.ts';
import { expandHome } from './env.ts';
import { GitMarkError } from './errors.ts';
import { ensureDir, pathExists, readTextIfExists, removeIfExists, writeTextAtomic } from './fs.ts';
import type {
  CommandContext,
  CleanupResult,
  DoctorReport,
  HookContext,
  HookName,
  PackageRecord,
  PackageSourceIdentity,
  ReconcileRuntimeOptions,
  ReconcileRuntimeReport,
  RepoState,
  RemoveRecordResult,
  SearchHit,
  SyncRecordsResult,
  TempState,
  ToolState,
  RuntimeConfig,
} from './types.ts';
import { parsePackageIndex, stringifyPackageIndex } from './toml.ts';
import { countSearchPackages, searchPackages } from './search.ts';
import type { AddInspection } from './types.ts';
import { inspectWriterLock } from './lock.ts';

const DEFAULT_MAX_LINES = 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PREVIEW_LIMIT = 12;
const DEFAULT_README_EXCERPT_LENGTH = 400;
const DEFAULT_GIT_TIMEOUT_MS = 180_000;

export function defaultRuntimeConfig() {
  return {
    storage: {
      root: path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.gitmark'),
      temp_root: path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.gitmark', 'tmp'),
      max_temp_size_mb: 2048,
    },
    network: {
      git_timeout_sec: 180,
      allow_lfs: false,
    },
    hooks: {
      module: '',
    },
  };
}

function getRuntimeGitTimeoutMs(config: RuntimeConfig): number {
  const timeoutSeconds = Number(config.network.git_timeout_sec);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return DEFAULT_GIT_TIMEOUT_MS;
  }
  return Math.round(timeoutSeconds * 1000);
}

export function sanitizeId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'package';
}

export function normalizeRemoteSource(source: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || source.startsWith('git@') || source.startsWith('ssh://')) {
    return source;
  }
  return `https://${source.replace(/^\/+/, '')}`;
}

export function parseSourceDescriptor(source: string): { remotes: string[]; subpath?: string } {
  const [remotePart, subpathPart] = source.split('#', 2);
  const subpath = subpathPart ? subpathPart.replace(/^\/+|\/+$/g, '') : '';
  return {
    remotes: [normalizeRemoteSource(remotePart)],
    subpath: subpath.length > 0 ? subpath : undefined,
  };
}

export function inferPackageId(remote: string, subpath?: string): string {
  const trimmedRemote = remote.replace(/\/+$/, '').replace(/\.git$/, '');
  const repoName = trimmedRemote.split('/').pop() ?? 'package';
  const slug = sanitizeId(repoName);
  if (!subpath) {
    return slug;
  }
  const leaf = sanitizeId(subpath.split('/').filter(Boolean).pop() ?? subpath);
  return `${slug}/${leaf}`;
}

export function ensureUniqueId(records: PackageRecord[], baseId: string): string {
  const existing = new Set(records.map((record) => record.id));
  if (!existing.has(baseId)) {
    return baseId;
  }
  let index = 2;
  while (existing.has(`${baseId}-${index}`)) {
    index += 1;
  }
  return `${baseId}-${index}`;
}

export function normalizeSourceRemote(remote: string): string {
  return normalizeRemoteSource(remote.trim()).replace(/\/+$/g, '').replace(/\.git$/i, '');
}

export function normalizeSourceSubpath(subpath?: string): string | undefined {
  const normalized = (subpath ?? '').trim().replace(/^\/+|\/+$/g, '');
  return normalized.length > 0 ? normalized : undefined;
}

export function findSamePackageRecord(
  records: PackageRecord[],
  source: PackageSourceIdentity,
): PackageRecord | undefined {
  const normalizedRemote = normalizeSourceRemote(source.remote);
  const normalizedSubpath = normalizeSourceSubpath(source.subpath);
  return records.find((record) => {
    if (normalizeSourceSubpath(record.subpath) !== normalizedSubpath) {
      return false;
    }
    return record.remotes.some((remote) => normalizeSourceRemote(remote) === normalizedRemote);
  });
}

export function repoKeyFor(record: PackageRecord): string {
  const normalized = [...record.remotes].map((entry) => entry.trim()).filter(Boolean).sort();
  const digest = crypto.createHash('sha256').update(normalized.join('\n')).digest('hex');
  return digest.slice(0, 24);
}

export async function loadIndexFile(indexPath: string): Promise<PackageRecord[]> {
  const text = await readTextIfExists(indexPath);
  if (!text) {
    return [];
  }
  return parsePackageIndex(text);
}

export async function saveIndexFile(indexPath: string, records: PackageRecord[]): Promise<void> {
  await writeTextAtomic(indexPath, stringifyPackageIndex(records));
}

export async function loadState(statePath: string): Promise<ToolState> {
  const text = await readTextIfExists(statePath);
  if (!text) {
    return { repos: {}, temps: {} };
  }
  try {
    const parsed = JSON.parse(text) as Partial<ToolState>;
    return {
      repos: parsed.repos ?? {},
      temps: parsed.temps ?? {},
    };
  } catch {
    await preserveBrokenStateFile(statePath);
    return { repos: {}, temps: {} };
  }
}

export async function saveState(statePath: string, state: ToolState): Promise<void> {
  await writeTextAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export async function cleanupTempMaterializations(context: CommandContext): Promise<void> {
  const state = await loadState(context.paths.statePath);
  const now = Date.now();
  let changed = false;

  for (const [id, temp] of Object.entries(state.temps)) {
    const age = now - new Date(temp.lastAccessedAt).getTime();
    const missing = !(await pathExists(temp.path));
    if (missing || Number.isNaN(age) || age > ONE_DAY_MS) {
      await removeIfExists(temp.path);
      delete state.temps[id];
      changed = true;
    }
  }

  const maxBytes = context.config.storage.max_temp_size_mb * 1024 * 1024;
  const totalSize = await calculateDirectorySize(context.paths.tempRoot);
  if (totalSize > maxBytes) {
    const orderedTemps = Object.entries(state.temps).sort(
      (left, right) =>
        new Date(left[1].lastAccessedAt).getTime() - new Date(right[1].lastAccessedAt).getTime(),
    );
    let remaining = totalSize;
    for (const [id, temp] of orderedTemps) {
      if (remaining <= maxBytes) {
        break;
      }
      const tempSize = await calculateDirectorySize(temp.path);
      await removeIfExists(temp.path);
      delete state.temps[id];
      remaining -= tempSize;
      changed = true;
    }
  }

  if (changed) {
    await saveState(context.paths.statePath, state);
  }
}

async function calculateDirectorySize(targetPath: string): Promise<number> {
  if (!(await pathExists(targetPath))) {
    return 0;
  }
  let total = 0;
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      total += await calculateDirectorySize(entryPath);
    } else {
      const stat = await fs.stat(entryPath);
      total += stat.size;
    }
  }
  return total;
}

async function preserveBrokenStateFile(statePath: string): Promise<void> {
  const brokenPath = path.join(
    path.dirname(statePath),
    `state.broken-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await fs.rename(statePath, brokenPath);
}

async function ensureRepoRoot(context: CommandContext): Promise<void> {
  await ensureDir(context.paths.storageRoot);
  await ensureDir(context.paths.reposRoot);
  await ensureDir(context.paths.tempRoot);
}

async function listDirectoryNames(targetPath: string): Promise<string[]> {
  if (!(await pathExists(targetPath))) {
    return [];
  }
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

interface RuntimeDriftSnapshot {
  records: PackageRecord[];
  state: ToolState;
  expectedPackageIds: Set<string>;
  expectedKeptRepoKeys: Set<string>;
  orphanTempStateEntries: Array<{ id: string; path: string; missingPath: boolean }>;
  orphanRepoStateEntries: Array<{ repoKey: string; path: string; missingPath: boolean }>;
  missingKeptMaterializations: Array<{ id: string; repoKey: string }>;
  orphanTempDirectories: string[];
  orphanRepoDirectories: string[];
}

async function collectRuntimeDriftSnapshot(context: CommandContext): Promise<RuntimeDriftSnapshot> {
  const records = await loadIndexFile(context.paths.indexPath);
  const state = await loadState(context.paths.statePath);
  const expectedPackageIds = new Set(records.map((record) => record.id));
  const keptRecords = records.filter((record) => record.kept);
  const expectedKeptRepoKeys = new Set(keptRecords.map((record) => repoKeyFor(record)));

  const orphanTempStateEntries: Array<{ id: string; path: string; missingPath: boolean }> = [];
  for (const [id, temp] of Object.entries(state.temps)) {
    const missingPath = !(await pathExists(temp.path));
    if (!expectedPackageIds.has(id) || missingPath) {
      orphanTempStateEntries.push({ id, path: temp.path, missingPath });
    }
  }

  const orphanRepoStateEntries: Array<{ repoKey: string; path: string; missingPath: boolean }> = [];
  for (const [repoKey, repo] of Object.entries(state.repos)) {
    const missingPath = !(await pathExists(repo.path));
    if (!expectedKeptRepoKeys.has(repoKey) || missingPath) {
      orphanRepoStateEntries.push({ repoKey, path: repo.path, missingPath });
    }
  }

  const missingKeptMaterializations: Array<{ id: string; repoKey: string }> = [];
  for (const record of keptRecords) {
    const repoKey = repoKeyFor(record);
    const repoState = state.repos[repoKey];
    if (!repoState || !(await pathExists(repoState.path))) {
      missingKeptMaterializations.push({ id: record.id, repoKey });
    }
  }

  const liveTempPaths = new Set(
    Object.values(state.temps)
      .map((temp) => temp.path)
      .filter((tempPath) => path.dirname(tempPath) === context.paths.tempRoot),
  );
  const liveRepoDirectories = new Set<string>();
  for (const [repoKey, repo] of Object.entries(state.repos)) {
    if (path.dirname(repo.path) === context.paths.reposRoot) {
      liveRepoDirectories.add(path.basename(repo.path));
      continue;
    }
    if (expectedKeptRepoKeys.has(repoKey)) {
      liveRepoDirectories.add(repoKey);
    }
  }
  for (const repoKey of expectedKeptRepoKeys) {
    liveRepoDirectories.add(repoKey);
  }

  const orphanTempDirectories = (await listDirectoryNames(context.paths.tempRoot))
    .map((name) => path.join(context.paths.tempRoot, name))
    .filter((directoryPath) => !liveTempPaths.has(directoryPath));
  const orphanRepoDirectories = (await listDirectoryNames(context.paths.reposRoot)).filter(
    (name) => !liveRepoDirectories.has(name),
  );

  return {
    records,
    state,
    expectedPackageIds,
    expectedKeptRepoKeys,
    orphanTempStateEntries,
    orphanRepoStateEntries,
    missingKeptMaterializations,
    orphanTempDirectories,
    orphanRepoDirectories,
  };
}

export async function reconcileRuntimeState(
  context: CommandContext,
  options: ReconcileRuntimeOptions = {},
): Promise<ReconcileRuntimeReport> {
  const snapshot = await collectRuntimeDriftSnapshot(context);
  const report: ReconcileRuntimeReport = {
    removedTempStateEntries: 0,
    removedRepoStateEntries: 0,
    deletedTempDirectories: 0,
    deletedRepoDirectories: 0,
    clearedTrackedTempStateEntries: 0,
  };
  let changed = false;

  for (const tempEntry of snapshot.orphanTempStateEntries) {
    if (options.pruneOrphanTempDirectories && (await pathExists(tempEntry.path))) {
      await removeIfExists(tempEntry.path);
      report.deletedTempDirectories += 1;
    }
    if (snapshot.state.temps[tempEntry.id]) {
      delete snapshot.state.temps[tempEntry.id];
      report.removedTempStateEntries += 1;
      changed = true;
    }
  }

  if (options.clearTrackedTemps) {
    for (const [id, temp] of Object.entries(snapshot.state.temps)) {
      if (await pathExists(temp.path)) {
        await removeIfExists(temp.path);
        report.deletedTempDirectories += 1;
      }
      delete snapshot.state.temps[id];
      report.clearedTrackedTempStateEntries += 1;
      changed = true;
    }
  }

  for (const repoEntry of snapshot.orphanRepoStateEntries) {
    if (options.pruneOrphanRepoDirectories && (await pathExists(repoEntry.path))) {
      await removeIfExists(repoEntry.path);
      report.deletedRepoDirectories += 1;
    }
    if (snapshot.state.repos[repoEntry.repoKey]) {
      delete snapshot.state.repos[repoEntry.repoKey];
      report.removedRepoStateEntries += 1;
      changed = true;
    }
  }

  if (options.pruneOrphanTempDirectories) {
    for (const orphanPath of snapshot.orphanTempDirectories) {
      if (await pathExists(orphanPath)) {
        await removeIfExists(orphanPath);
        report.deletedTempDirectories += 1;
      }
    }
  }

  if (options.pruneOrphanRepoDirectories) {
    for (const orphanName of snapshot.orphanRepoDirectories) {
      const orphanPath = path.join(context.paths.reposRoot, orphanName);
      if (await pathExists(orphanPath)) {
        await removeIfExists(orphanPath);
        report.deletedRepoDirectories += 1;
      }
    }
  }

  if (changed) {
    await saveState(context.paths.statePath, snapshot.state);
  }

  return report;
}

async function resolveCloneTarget(
  context: CommandContext,
  record: PackageRecord,
  materializedPath: string,
  persistAsRepoState: boolean,
): Promise<{ repoPath: string; selectedRemote: string; defaultBranch: string; commit: string }> {
  const gitTimeoutMs = getRuntimeGitTimeoutMs(context.config);
  const repoKey = repoKeyFor(record);
  await ensureRepoRoot(context);
  const state = await loadState(context.paths.statePath);
  const existingRepoState = state.repos[repoKey];
  if (persistAsRepoState && existingRepoState && (await pathExists(existingRepoState.path))) {
    const repoPath = existingRepoState.path;
    const selectedRemote = existingRepoState.selectedRemote || record.remotes[0];
    const defaultBranch = existingRepoState.defaultBranch;
    if (record.frozen && record.commit) {
      await checkoutCommit(repoPath, record.commit, gitTimeoutMs);
    } else if (defaultBranch) {
      try {
        await checkoutBranchIfDetached(repoPath, defaultBranch, gitTimeoutMs);
      } catch {
        // Keep the current checkout if the branch is not available locally yet.
      }
    }
    return {
      repoPath,
      selectedRemote,
      defaultBranch,
      commit: await currentCommit(repoPath, gitTimeoutMs),
    };
  }

  await removeIfExists(materializedPath);
  await ensureDir(path.dirname(materializedPath));

  let lastError: unknown = null;
  for (const remote of record.remotes) {
    try {
      await cloneRemote(remote, materializedPath, context.config.network.allow_lfs, gitTimeoutMs);
      const defaultBranch = await detectDefaultBranch(materializedPath, gitTimeoutMs);
      const commit = await currentCommit(materializedPath, gitTimeoutMs);
      return {
        repoPath: materializedPath,
        selectedRemote: remote,
        defaultBranch,
        commit,
      };
    } catch (error) {
      lastError = error;
      await removeIfExists(materializedPath);
    }
  }

  throw new GitMarkError(
    'CLONE_FAILED',
    `Could not clone any remote for package ${record.id}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function checkoutBranchIfDetached(repoPath: string, branch: string, timeoutMs: number): Promise<void> {
  try {
    const branchName = await currentBranch(repoPath, timeoutMs);
    if (branchName === branch) {
      return;
    }
  } catch {
    // Detached HEAD or no branch information.
  }
  await runGit(['checkout', '--force', branch], { cwd: repoPath, timeoutMs });
}

async function detectDefaultBranch(repoPath: string, timeoutMs: number): Promise<string> {
  try {
    const branch = await currentBranch(repoPath, timeoutMs);
    if (branch) {
      return branch;
    }
  } catch {
    // Fall through.
  }
  const result = await runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: repoPath,
    timeoutMs,
  });
  const ref = result.stdout.trim();
  return ref.startsWith('origin/') ? ref.slice('origin/'.length) : 'main';
}

async function resolveVisiblePath(record: PackageRecord, repoPath: string): Promise<string> {
  const visiblePath = record.subpath ? path.join(repoPath, record.subpath) : repoPath;
  if (!(await pathExists(visiblePath))) {
    throw new GitMarkError('SUBPATH_MISSING', `Package ${record.id} does not contain subpath ${record.subpath}.`);
  }
  return visiblePath;
}

export async function addRecord(context: CommandContext, input: string, options: Partial<PackageRecord>): Promise<PackageRecord> {
  const records = await loadIndexFile(context.paths.indexPath);
  const parsed = parseSourceDescriptor(input);
  const remote = parsed.remotes[0];
  const baseId = options.id ?? inferPackageId(remote, parsed.subpath);
  const id = ensureUniqueId(records, baseId);
  const record: PackageRecord = {
    id,
    remotes: options.remotes ?? parsed.remotes,
    subpath: options.subpath ?? parsed.subpath,
    summary: options.summary ?? '',
    description: options.description ?? '',
    resources: options.resources ?? [],
    pinned: options.pinned ?? true,
    kept: options.kept ?? true,
    discoverable: options.discoverable ?? true,
    frozen: options.frozen ?? false,
    commit: options.commit ?? '',
  };
  records.push(record);
  await saveIndexFile(context.paths.indexPath, records);
  return record;
}

export async function findExistingPackageRecord(
  context: CommandContext,
  input: string,
): Promise<PackageRecord | undefined> {
  const records = await loadIndexFile(context.paths.indexPath);
  const parsed = parseSourceDescriptor(input);
  return findSamePackageRecord(records, {
    remote: parsed.remotes[0],
    subpath: parsed.subpath,
  });
}

export async function replaceRecord(
  context: CommandContext,
  existingId: string,
  input: string,
  options: Partial<PackageRecord>,
): Promise<PackageRecord> {
  const records = await loadIndexFile(context.paths.indexPath);
  const index = records.findIndex((record) => record.id === existingId);
  if (index === -1) {
    throw new GitMarkError('NOT_FOUND', `Package ${existingId} was not found.`);
  }
  const parsed = parseSourceDescriptor(input);
  const record: PackageRecord = {
    id: existingId,
    remotes: options.remotes ?? parsed.remotes,
    subpath: options.subpath ?? parsed.subpath,
    summary: options.summary ?? '',
    description: options.description ?? '',
    resources: options.resources ?? [],
    pinned: options.pinned ?? true,
    kept: options.kept ?? true,
    discoverable: options.discoverable ?? true,
    frozen: options.frozen ?? false,
    commit: options.commit ?? '',
  };
  records[index] = record;
  await saveIndexFile(context.paths.indexPath, records);
  return record;
}

export async function listRecords(context: CommandContext, all = false): Promise<PackageRecord[]> {
  const records = await loadIndexFile(context.paths.indexPath);
  const filtered = all ? records : records.filter((record) => record.pinned !== false);
  return filtered.slice().sort((left, right) => left.id.localeCompare(right.id));
}

export async function searchRecords(
  context: CommandContext,
  query: string,
  limit = 10,
  offset = 0,
): Promise<{ hits: SearchHit[]; total: number }> {
  const records = await loadIndexFile(context.paths.indexPath);
  return {
    hits: searchPackages(records, query, limit, offset),
    total: countSearchPackages(records, query),
  };
}

export async function peekRecord(
  context: CommandContext,
  id: string,
): Promise<{ record: PackageRecord; preview: string[]; readme?: string }> {
  const records = await loadIndexFile(context.paths.indexPath);
  const record = records.find((entry) => entry.id === id);
  if (!record) {
    throw new GitMarkError('NOT_FOUND', `Package ${id} was not found.`);
  }
  const inspection = await materializeForInspection(context, record);
  const repoPath = inspection.repoPath;
  const preview = await previewVisiblePath(repoPath, record.subpath);
  const readme = await readReadmeExcerpt(record, repoPath);
  if (inspection.transient) {
    await removeIfExists(repoPath);
  }
  return { record, preview, readme };
}

export async function inspectAddSource(context: CommandContext, source: string): Promise<AddInspection> {
  const parsed = parseSourceDescriptor(source);
  const tempId = `inspect-${sanitizeId(parsed.remotes[0])}-${Date.now()}`;
  const scratchPath = path.join(context.paths.tempRoot, tempId);
  const record: PackageRecord = {
    id: tempId,
    remotes: parsed.remotes,
    subpath: parsed.subpath,
    summary: '',
    description: '',
    resources: [],
    pinned: false,
    kept: false,
    discoverable: true,
    frozen: false,
    commit: '',
  };

  try {
    await ensureGitAccessible();
    const clone = await resolveCloneTarget(context, record, scratchPath, false);
    const preview = await previewVisiblePath(clone.repoPath, parsed.subpath);
    const readmeExcerpt = await readReadmeExcerpt(record, clone.repoPath);
    return {
      source,
      remote: parsed.remotes[0],
      subpath: parsed.subpath,
      preview,
      readmeExcerpt,
    };
  } finally {
    await removeIfExists(scratchPath);
  }
}

async function materializeForInspection(
  context: CommandContext,
  record: PackageRecord,
): Promise<{ repoPath: string; transient: boolean }> {
  await ensureGitAccessible();
  const gitTimeoutMs = getRuntimeGitTimeoutMs(context.config);
  const repoKey = repoKeyFor(record);
  const state = await loadState(context.paths.statePath);
  if (record.kept && state.repos[repoKey] && (await pathExists(state.repos[repoKey].path))) {
    return { repoPath: state.repos[repoKey].path, transient: false };
  }
  if (!record.kept && state.temps[record.id] && (await pathExists(state.temps[record.id].path))) {
    state.temps[record.id].lastAccessedAt = new Date().toISOString();
    await saveState(context.paths.statePath, state);
    return { repoPath: state.temps[record.id].path, transient: false };
  }
  const scratchPath = path.join(context.paths.tempRoot, `peek-${sanitizeId(record.id)}-${Date.now()}`);
  const clone = await resolveCloneTarget(context, record, scratchPath, false);
  if (record.frozen && record.commit) {
    await checkoutCommit(clone.repoPath, record.commit, gitTimeoutMs);
  }
  return { repoPath: clone.repoPath, transient: true };
}

export async function loadRecord(context: CommandContext, id: string): Promise<string> {
  await ensureGitAccessible();
  const gitTimeoutMs = getRuntimeGitTimeoutMs(context.config);
  const records = await loadIndexFile(context.paths.indexPath);
  const record = records.find((entry) => entry.id === id);
  if (!record) {
    throw new GitMarkError('NOT_FOUND', `Package ${id} was not found.`);
  }
  const plannedPath = plannedMaterializationPath(context, record);
  await runHooks(context, 'preLoad', record, plannedPath, record.remotes[0], '');
  const state = await loadState(context.paths.statePath);
  if (record.kept) {
    const repoKey = repoKeyFor(record);
    const repoPath = path.join(context.paths.reposRoot, repoKey);
    const clone = await resolveCloneTarget(context, record, repoPath, true);
    if (record.frozen && record.commit) {
      await checkoutCommit(clone.repoPath, record.commit, gitTimeoutMs);
    }
    if (!record.frozen && clone.defaultBranch) {
      await checkoutBranchIfDetached(clone.repoPath, clone.defaultBranch, gitTimeoutMs);
    }
    state.repos[repoKey] = {
      path: clone.repoPath,
      selectedRemote: clone.selectedRemote,
      defaultBranch: clone.defaultBranch,
      lastCommit: await currentCommit(clone.repoPath, gitTimeoutMs),
      updatedAt: new Date().toISOString(),
    };
    await saveState(context.paths.statePath, state);
    await runHooks(context, 'preExpose', record, clone.repoPath, clone.selectedRemote, clone.defaultBranch);
    await runHooks(context, 'postLoad', record, clone.repoPath, clone.selectedRemote, clone.defaultBranch);
    return resolveVisiblePath(record, clone.repoPath);
  }

  const existingTemp = state.temps[record.id];
  if (existingTemp && (await pathExists(existingTemp.path))) {
    existingTemp.lastAccessedAt = new Date().toISOString();
    if (record.frozen && record.commit) {
      await checkoutCommit(existingTemp.path, record.commit, gitTimeoutMs);
    }
    await saveState(context.paths.statePath, state);
    await runHooks(context, 'preExpose', record, existingTemp.path, existingTemp.selectedRemote, existingTemp.defaultBranch);
    await runHooks(context, 'postLoad', record, existingTemp.path, existingTemp.selectedRemote, existingTemp.defaultBranch);
    return resolveVisiblePath(record, existingTemp.path);
  }

  const tempPath = path.join(context.paths.tempRoot, `${sanitizeId(record.id)}-${Date.now()}`);
  const clone = await resolveCloneTarget(context, record, tempPath, false);
  if (record.frozen && record.commit) {
    await checkoutCommit(clone.repoPath, record.commit, gitTimeoutMs);
  }
  state.temps[record.id] = {
    path: clone.repoPath,
    repoKey: repoKeyFor(record),
    selectedRemote: clone.selectedRemote,
    defaultBranch: clone.defaultBranch,
    materializedAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
  };
  await saveState(context.paths.statePath, state);
  await runHooks(context, 'preExpose', record, clone.repoPath, clone.selectedRemote, clone.defaultBranch);
  await runHooks(context, 'postLoad', record, clone.repoPath, clone.selectedRemote, clone.defaultBranch);
  return resolveVisiblePath(record, clone.repoPath);
}

export async function currentPath(context: CommandContext, id: string): Promise<string> {
  const records = await loadIndexFile(context.paths.indexPath);
  const record = records.find((entry) => entry.id === id);
  if (!record) {
    throw new GitMarkError('NOT_FOUND', `Package ${id} was not found.`);
  }
  const state = await loadState(context.paths.statePath);
  if (record.kept) {
    const repoKey = repoKeyFor(record);
    const repoState = state.repos[repoKey];
    if (!repoState || !(await pathExists(repoState.path))) {
      throw new GitMarkError('NOT_MATERIALIZED', `Package ${id} is not materialized. Use gmk load ${id}.`);
    }
    return resolveVisiblePath(record, repoState.path);
  }
  const tempState = state.temps[record.id];
  if (!tempState || !(await pathExists(tempState.path))) {
    throw new GitMarkError('NOT_MATERIALIZED', `Package ${id} is not materialized. Use gmk load ${id}.`);
  }
  return resolveVisiblePath(record, tempState.path);
}

export async function updateRecord(context: CommandContext, id: string, force = false): Promise<string> {
  await ensureGitAccessible();
  const gitTimeoutMs = getRuntimeGitTimeoutMs(context.config);
  const records = await loadIndexFile(context.paths.indexPath);
  const record = records.find((entry) => entry.id === id);
  if (!record) {
    throw new GitMarkError('NOT_FOUND', `Package ${id} was not found.`);
  }
  if (record.frozen && !force) {
    throw new GitMarkError('FROZEN', `Package ${id} is frozen and was skipped.`);
  }
  await loadRecord(context, id);
  const repoPath = await currentCloneRoot(context, record);
  const state = await loadState(context.paths.statePath);
  const repoKey = repoKeyFor(record);
  const repoState = record.kept ? state.repos[repoKey] : state.temps[record.id];
  const selectedRemote = repoState?.selectedRemote ?? record.remotes[0];
  const defaultBranch = repoState?.defaultBranch ?? 'main';
  await runHooks(context, 'preUpdate', record, repoPath, selectedRemote, defaultBranch);
  await fetchRemote(repoPath, 'origin', context.config.network.allow_lfs, gitTimeoutMs);
  await resetToRemoteBranch(repoPath, defaultBranch, 'origin', gitTimeoutMs);
  if (record.frozen && record.commit) {
    await checkoutCommit(repoPath, record.commit, gitTimeoutMs);
  }
  const commit = await currentCommit(repoPath, gitTimeoutMs);
  if (record.kept) {
    state.repos[repoKey] = {
      path: repoPath,
      selectedRemote,
      defaultBranch,
      lastCommit: commit,
      updatedAt: new Date().toISOString(),
    };
  } else {
    const tempState = repoState as TempState | undefined;
    state.temps[record.id] = {
      path: repoPath,
      repoKey,
      selectedRemote,
      defaultBranch,
      materializedAt: tempState?.materializedAt ?? new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    };
  }
  await saveState(context.paths.statePath, state);
  await runHooks(context, 'postUpdate', record, repoPath, selectedRemote, defaultBranch);
  return resolveVisiblePath(record, repoPath);
}

async function currentCloneRoot(context: CommandContext, record: PackageRecord): Promise<string> {
  const state = await loadState(context.paths.statePath);
  if (record.kept) {
    const repoKey = repoKeyFor(record);
    const repoState = state.repos[repoKey];
    if (!repoState) {
      throw new GitMarkError('NOT_MATERIALIZED', `Package ${record.id} is not materialized. Use gmk load ${record.id}.`);
    }
    return repoState.path;
  }
  const tempState = state.temps[record.id];
  if (!tempState) {
    throw new GitMarkError('NOT_MATERIALIZED', `Package ${record.id} is not materialized. Use gmk load ${record.id}.`);
  }
  return tempState.path;
}

export async function freezeRecord(context: CommandContext, id: string): Promise<PackageRecord> {
  await ensureGitAccessible();
  const gitTimeoutMs = getRuntimeGitTimeoutMs(context.config);
  const records = await loadIndexFile(context.paths.indexPath);
  const index = records.findIndex((entry) => entry.id === id);
  if (index === -1) {
    throw new GitMarkError('NOT_FOUND', `Package ${id} was not found.`);
  }
  const record = records[index];
  const pathOnDisk = await loadRecord(context, id);
  const commit = await currentCommit(pathOnDisk, gitTimeoutMs);
  record.frozen = true;
  record.commit = commit;
  records[index] = record;
  await saveIndexFile(context.paths.indexPath, records);
  return record;
}

export async function unfreezeRecord(context: CommandContext, id: string): Promise<PackageRecord> {
  const records = await loadIndexFile(context.paths.indexPath);
  const index = records.findIndex((entry) => entry.id === id);
  if (index === -1) {
    throw new GitMarkError('NOT_FOUND', `Package ${id} was not found.`);
  }
  const record = records[index];
  record.frozen = false;
  record.commit = '';
  records[index] = record;
  await saveIndexFile(context.paths.indexPath, records);
  return record;
}

export async function pinRecord(context: CommandContext, id: string): Promise<PackageRecord> {
  const records = await loadIndexFile(context.paths.indexPath);
  const index = records.findIndex((entry) => entry.id === id);
  if (index === -1) {
    throw new GitMarkError('NOT_FOUND', `Package ${id} was not found.`);
  }
  const record = records[index];
  record.pinned = true;
  records[index] = record;
  await saveIndexFile(context.paths.indexPath, records);
  return record;
}

export async function unpinRecord(context: CommandContext, id: string): Promise<PackageRecord> {
  const records = await loadIndexFile(context.paths.indexPath);
  const index = records.findIndex((entry) => entry.id === id);
  if (index === -1) {
    throw new GitMarkError('NOT_FOUND', `Package ${id} was not found.`);
  }
  const record = records[index];
  record.pinned = false;
  records[index] = record;
  await saveIndexFile(context.paths.indexPath, records);
  return record;
}

export async function removeRecord(context: CommandContext, id: string): Promise<RemoveRecordResult> {
  const records = await loadIndexFile(context.paths.indexPath);
  const recordIndex = records.findIndex((entry) => entry.id === id);
  if (recordIndex === -1) {
    throw new GitMarkError('NOT_FOUND', `Package ${id} was not found.`);
  }

  const removed = records[recordIndex];
  const remainingRecords = records.filter((entry) => entry.id !== id);
  await saveIndexFile(context.paths.indexPath, remainingRecords);

  const result: RemoveRecordResult = {
    removedId: removed.id,
    deletedTempStateEntries: 0,
    deletedRepoStateEntries: 0,
    deletedTempDirectories: 0,
    deletedRepoDirectories: 0,
    reconciliation: {
      removedTempStateEntries: 0,
      removedRepoStateEntries: 0,
      deletedTempDirectories: 0,
      deletedRepoDirectories: 0,
      clearedTrackedTempStateEntries: 0,
    },
  };

  const state = await loadState(context.paths.statePath);
  let changed = false;

  const tempState = state.temps[removed.id];
  if (tempState) {
    if (await pathExists(tempState.path)) {
      await removeIfExists(tempState.path);
      result.deletedTempDirectories += 1;
    }
    delete state.temps[removed.id];
    result.deletedTempStateEntries += 1;
    changed = true;
  }

  if (removed.kept) {
    const repoKey = repoKeyFor(removed);
    const remainingKeptRepoKeys = new Set(remainingRecords.filter((entry) => entry.kept).map((entry) => repoKeyFor(entry)));
    const repoState = state.repos[repoKey];
    if (repoState && !remainingKeptRepoKeys.has(repoKey)) {
      if (await pathExists(repoState.path)) {
        await removeIfExists(repoState.path);
        result.deletedRepoDirectories += 1;
      }
      delete state.repos[repoKey];
      result.deletedRepoStateEntries += 1;
      changed = true;
    }
  }

  if (changed) {
    await saveState(context.paths.statePath, state);
  }

  result.reconciliation = await reconcileRuntimeState(context, {
    pruneOrphanRepoDirectories: true,
    pruneOrphanTempDirectories: true,
  });
  return result;
}

export async function syncKeptRecords(context: CommandContext): Promise<SyncRecordsResult> {
  const reconciliation = await reconcileRuntimeState(context, {
    pruneOrphanRepoDirectories: true,
    pruneOrphanTempDirectories: true,
  });
  const records = await loadIndexFile(context.paths.indexPath);
  const keptRecords = records.filter((record) => record.kept);
  for (const record of keptRecords) {
    await loadRecord(context, record.id);
  }
  return {
    keptPackagesProcessed: keptRecords.length,
    reconciliation,
  };
}

export async function doctorRuntime(context: CommandContext): Promise<DoctorReport> {
  const issues: string[] = [];

  try {
    await ensureGitAccessible();
  } catch (error) {
    issues.push(`git unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const snapshot = await collectRuntimeDriftSnapshot(context);
  const lock = await inspectWriterLock(context);

  if (lock.status === 'stale') {
    issues.push(`writer lock is stale${lock.ownerSummary}`);
  }

  for (const tempEntry of snapshot.orphanTempStateEntries) {
    if (!snapshot.expectedPackageIds.has(tempEntry.id)) {
      issues.push(`orphan temp state: ${tempEntry.id} -> ${tempEntry.path}`);
    }
    if (tempEntry.missingPath) {
      issues.push(`missing temp materialization: ${tempEntry.id} -> ${tempEntry.path}`);
    }
  }

  for (const repoEntry of snapshot.orphanRepoStateEntries) {
    if (!snapshot.expectedKeptRepoKeys.has(repoEntry.repoKey)) {
      issues.push(`orphan repo state: ${repoEntry.repoKey} -> ${repoEntry.path}`);
    }
    if (repoEntry.missingPath) {
      issues.push(`missing repo materialization: ${repoEntry.repoKey} -> ${repoEntry.path}`);
    }
  }

  for (const missingRepo of snapshot.missingKeptMaterializations) {
    issues.push(`missing kept materialization: ${missingRepo.id}`);
  }

  for (const orphanTempDirectory of snapshot.orphanTempDirectories) {
    issues.push(`orphan temp directory: ${orphanTempDirectory}`);
  }

  for (const orphanRepoDirectory of snapshot.orphanRepoDirectories) {
    issues.push(`orphan repo directory: ${path.join(context.paths.reposRoot, orphanRepoDirectory)}`);
  }

  return {
    clean: issues.length === 0,
    issues,
    lockStatus: lock.status,
  };
}

export async function cleanupRuntime(context: CommandContext): Promise<CleanupResult> {
  return reconcileRuntimeState(context, {
    pruneOrphanRepoDirectories: true,
    pruneOrphanTempDirectories: true,
    clearTrackedTemps: true,
  });
}

export async function updateAllRecords(context: CommandContext): Promise<number> {
  const records = await loadIndexFile(context.paths.indexPath);
  let count = 0;
  for (const record of records) {
    if (record.frozen) {
      continue;
    }
    await updateRecord(context, record.id, true);
    count += 1;
  }
  return count;
}

export async function previewVisiblePath(repoPath: string, subpath?: string): Promise<string[]> {
  const base = subpath ? path.join(repoPath, subpath) : repoPath;
  if (!(await pathExists(base))) {
    return [];
  }
  const entries = await listDirectoryPreview(base, 2, DEFAULT_PREVIEW_LIMIT);
  return entries;
}

async function listDirectoryPreview(targetPath: string, depth: number, limit: number): Promise<string[]> {
  const entries: string[] = [];

  async function walk(currentPath: string, currentDepth: number, prefix: string): Promise<void> {
    if (entries.length >= limit || currentDepth < 0) {
      return;
    }
    const items = await fs.readdir(currentPath, { withFileTypes: true });
    for (const item of items) {
      if (entries.length >= limit) {
        break;
      }
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      entries.push(item.isDirectory() ? `${relative}/` : relative);
      if (item.isDirectory() && currentDepth > 0) {
        await walk(path.join(currentPath, item.name), currentDepth - 1, relative);
      }
    }
  }

  await walk(targetPath, depth, '');
  return entries;
}

async function readReadmeExcerpt(record: PackageRecord, repoPath: string): Promise<string | undefined> {
  const candidates = [path.join(repoPath, 'README.md'), path.join(repoPath, 'README'), path.join(repoPath, 'readme.md')];
  if (record.subpath) {
    candidates.unshift(
      path.join(repoPath, record.subpath, 'README.md'),
      path.join(repoPath, record.subpath, 'README'),
      path.join(repoPath, record.subpath, 'readme.md'),
    );
  }
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const text = await fs.readFile(candidate, 'utf8');
    const excerpt = text.slice(0, DEFAULT_README_EXCERPT_LENGTH).replace(/\s+/g, ' ').trim();
    return excerpt.length > 0 ? excerpt : undefined;
  }
  return undefined;
}

export async function runHooks(
  context: CommandContext,
  hookName: HookName,
  record: PackageRecord,
  repoPath: string,
  selectedRemote: string,
  defaultBranch: string,
): Promise<void> {
  const gitTimeoutMs = getRuntimeGitTimeoutMs(context.config);
  const hookModule = await loadHookModule(context);
  if (!hookModule) {
    return;
  }
  const hook = hookModule[hookName];
  if (typeof hook !== 'function') {
    return;
  }
  const hookContext: HookContext = {
    packageId: record.id,
    repoPath,
    visiblePath: record.subpath ? path.join(repoPath, record.subpath) : repoPath,
    selectedRemote,
    subpath: record.subpath ?? '',
    resolvedCommit: await resolveHookCommit(record, repoPath, gitTimeoutMs),
    defaultBranch,
    hookName,
  };
  try {
    await hook(hookContext);
  } catch (error) {
    throw new GitMarkError(
      'HOOK_FAILED',
      `${hookName} hook failed for package ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
      1,
      error,
    );
  }
}

async function loadHookModule(context: CommandContext): Promise<Partial<Record<HookName, (context: HookContext) => unknown>> | null> {
  const configuredPath = context.config.hooks.module.trim();
  if (!configuredPath) {
    return null;
  }
  const expandedPath = expandHome(configuredPath);
  const resolvedPath = path.isAbsolute(expandedPath)
    ? expandedPath
    : path.resolve(path.dirname(context.paths.configPath), expandedPath);
  if (!(await pathExists(resolvedPath))) {
    throw new GitMarkError('HOOK_LOAD_FAILED', `Hook module could not be loaded from ${resolvedPath}: file does not exist.`);
  }
  try {
    return (await import(pathToFileURL(resolvedPath).href)) as Partial<Record<HookName, (context: HookContext) => unknown>>;
  } catch (error) {
    throw new GitMarkError(
      'HOOK_LOAD_FAILED',
      `Hook module could not be loaded from ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      1,
      error,
    );
  }
}

async function resolveHookCommit(record: PackageRecord, repoPath: string, timeoutMs: number): Promise<string> {
  if (await pathExists(repoPath)) {
    try {
      return await currentCommit(repoPath, timeoutMs);
    } catch {
      // Fall back to the record commit when the repo is not fully ready yet.
    }
  }
  return record.commit ?? '';
}

function plannedMaterializationPath(context: CommandContext, record: PackageRecord): string {
  if (record.kept) {
    return path.join(context.paths.reposRoot, repoKeyFor(record));
  }
  return path.join(context.paths.tempRoot, `${sanitizeId(record.id)}-${Date.now()}`);
}

export async function resolveIndexAndConfig(context: CommandContext): Promise<{ records: PackageRecord[]; state: ToolState }> {
  return {
    records: await loadIndexFile(context.paths.indexPath),
    state: await loadState(context.paths.statePath),
  };
}

export async function ensureGitAvailableOrThrow(): Promise<void> {
  await ensureGitAccessible();
}
