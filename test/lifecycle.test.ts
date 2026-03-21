import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupRuntime,
  doctorRuntime,
  loadIndexFile,
  loadState,
  reconcileRuntimeState,
  removeRecord,
  repoKeyFor,
  saveIndexFile,
  saveState,
  syncKeptRecords,
} from '../src/index.ts';
import { runGit } from '../src/git.ts';
import type { CommandContext, PackageRecord, ToolState } from '../src/types.ts';

function makeContext(root: string): CommandContext {
  return {
    paths: {
      home: root,
      indexPath: path.join(root, '.gitmarks.toml'),
      configPath: path.join(root, '.gitmark', 'config.toml'),
      logPath: path.join(root, 'runtime', 'history.log'),
      statePath: path.join(root, 'runtime', 'state.json'),
      storageRoot: path.join(root, 'runtime'),
      reposRoot: path.join(root, 'runtime', 'repos'),
      tempRoot: path.join(root, 'runtime', 'tmp'),
    },
    config: {
      storage: {
        root: path.join(root, 'runtime'),
        temp_root: path.join(root, 'runtime', 'tmp'),
        max_temp_size_mb: 64,
      },
      network: {
        git_timeout_sec: 120,
        allow_lfs: false,
      },
      hooks: {
        module: '',
      },
    },
  };
}

function makeRecord(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: 'alpha',
    remotes: ['https://example.com/org/repo.git'],
    summary: '',
    description: '',
    resources: [],
    pinned: true,
    kept: true,
    discoverable: true,
    frozen: false,
    commit: '',
    ...overrides,
  };
}

async function setupContext(): Promise<CommandContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-lifecycle-'));
  const context = makeContext(root);
  await fs.mkdir(context.paths.reposRoot, { recursive: true });
  await fs.mkdir(context.paths.tempRoot, { recursive: true });
  await saveIndexFile(context.paths.indexPath, []);
  await saveState(context.paths.statePath, { repos: {}, temps: {} });
  return context;
}

async function createLocalRepo(root: string, name: string): Promise<string> {
  const repoPath = path.join(root, name);
  await fs.mkdir(repoPath, { recursive: true });
  await runGit(['init'], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, 'README.md'), `# ${name}\n`, 'utf8');
  await runGit(['add', '.'], { cwd: repoPath });
  await runGit(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}

test('reconciliation removes orphan temp and repo state entries', async () => {
  const context = await setupContext();
  const orphanTempPath = path.join(context.paths.tempRoot, 'old-temp');
  const orphanRepoPath = path.join(context.paths.reposRoot, 'old-repo');
  await fs.mkdir(orphanTempPath, { recursive: true });
  await fs.mkdir(orphanRepoPath, { recursive: true });
  await saveState(context.paths.statePath, {
    repos: {
      stale: {
        path: orphanRepoPath,
        selectedRemote: 'remote',
        defaultBranch: 'main',
        lastCommit: 'abc',
        updatedAt: new Date().toISOString(),
      },
    },
    temps: {
      stale: {
        path: orphanTempPath,
        repoKey: 'stale',
        selectedRemote: 'remote',
        defaultBranch: 'main',
        materializedAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      },
    },
  });

  const result = await reconcileRuntimeState(context);

  assert.equal(result.removedTempStateEntries, 1);
  assert.equal(result.removedRepoStateEntries, 1);
  assert.equal(result.deletedTempDirectories, 0);
  assert.equal(result.deletedRepoDirectories, 0);
  assert.deepEqual(await loadState(context.paths.statePath), { repos: {}, temps: {} });
  assert.equal(true, await fs.stat(orphanTempPath).then(() => true, () => false));
  assert.equal(true, await fs.stat(orphanRepoPath).then(() => true, () => false));
});

test('remove deletes temp materialization and temp state', async () => {
  const context = await setupContext();
  const record = makeRecord({ id: 'temp-only', kept: false });
  const tempPath = path.join(context.paths.tempRoot, 'temp-only-1');
  await fs.mkdir(tempPath, { recursive: true });
  await saveIndexFile(context.paths.indexPath, [record]);
  await saveState(context.paths.statePath, {
    repos: {},
    temps: {
      [record.id]: {
        path: tempPath,
        repoKey: 'temp-key',
        selectedRemote: record.remotes[0],
        defaultBranch: 'main',
        materializedAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      },
    },
  });

  const result = await removeRecord(context, record.id);

  assert.equal(result.removedId, record.id);
  assert.equal(result.deletedTempStateEntries, 1);
  assert.equal(result.deletedTempDirectories, 1);
  assert.deepEqual(await loadIndexFile(context.paths.indexPath), []);
  assert.deepEqual(await loadState(context.paths.statePath), { repos: {}, temps: {} });
  await assert.rejects(fs.stat(tempPath));
});

test('remove preserves a shared kept repo path still needed by another package', async () => {
  const context = await setupContext();
  const sharedRemote = 'https://example.com/shared/repo.git';
  const first = makeRecord({ id: 'shared-a', remotes: [sharedRemote], kept: true });
  const second = makeRecord({ id: 'shared-b', remotes: [sharedRemote], kept: true });
  const repoKey = repoKeyFor(first);
  const repoPath = path.join(context.paths.reposRoot, repoKey);
  await fs.mkdir(repoPath, { recursive: true });
  await saveIndexFile(context.paths.indexPath, [first, second]);
  await saveState(context.paths.statePath, {
    repos: {
      [repoKey]: {
        path: repoPath,
        selectedRemote: sharedRemote,
        defaultBranch: 'main',
        lastCommit: 'abc',
        updatedAt: new Date().toISOString(),
      },
    },
    temps: {},
  });

  const result = await removeRecord(context, first.id);
  const nextState = await loadState(context.paths.statePath);

  assert.equal(result.deletedRepoDirectories, 0);
  assert.equal(result.deletedRepoStateEntries, 0);
  assert.equal((await loadIndexFile(context.paths.indexPath)).map((record) => record.id).includes(second.id), true);
  assert.equal(true, await fs.stat(repoPath).then(() => true, () => false));
  assert.ok(nextState.repos[repoKey]);
});

test('cleanup removes tracked temp materializations and preserves kept repos', async () => {
  const context = await setupContext();
  const kept = makeRecord({ id: 'kept-one', kept: true });
  const tempRecord = makeRecord({ id: 'temp-one', kept: false });
  const repoKey = repoKeyFor(kept);
  const repoPath = path.join(context.paths.reposRoot, repoKey);
  const tempPath = path.join(context.paths.tempRoot, 'temp-one');
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(tempPath, { recursive: true });
  await saveIndexFile(context.paths.indexPath, [kept, tempRecord]);
  await saveState(context.paths.statePath, {
    repos: {
      [repoKey]: {
        path: repoPath,
        selectedRemote: kept.remotes[0],
        defaultBranch: 'main',
        lastCommit: 'abc',
        updatedAt: new Date().toISOString(),
      },
    },
    temps: {
      'temp-one': {
        path: tempPath,
        repoKey,
        selectedRemote: kept.remotes[0],
        defaultBranch: 'main',
        materializedAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      },
    },
  });

  const result = await cleanupRuntime(context);
  const nextState = await loadState(context.paths.statePath);

  assert.equal(result.deletedTempDirectories, 1);
  assert.equal(result.clearedTrackedTempStateEntries, 1);
  assert.deepEqual(nextState.temps, {});
  assert.ok(nextState.repos[repoKey]);
  assert.equal(true, await fs.stat(repoPath).then(() => true, () => false));
  await assert.rejects(fs.stat(tempPath));
});

test('doctor reports missing kept materializations and orphan runtime entries without mutating state', async () => {
  const context = await setupContext();
  const kept = makeRecord({ id: 'kept-missing', kept: true });
  const orphanTempPath = path.join(context.paths.tempRoot, 'orphan-temp');
  const orphanRepoPath = path.join(context.paths.reposRoot, 'orphan-repo');
  const state: ToolState = {
    repos: {
      orphan: {
        path: orphanRepoPath,
        selectedRemote: 'remote',
        defaultBranch: 'main',
        lastCommit: 'abc',
        updatedAt: new Date().toISOString(),
      },
    },
    temps: {
      orphan: {
        path: orphanTempPath,
        repoKey: 'orphan',
        selectedRemote: 'remote',
        defaultBranch: 'main',
        materializedAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      },
    },
  };
  await saveIndexFile(context.paths.indexPath, [kept]);
  await saveState(context.paths.statePath, state);

  const report = await doctorRuntime(context);

  assert.equal(report.clean, false);
  assert.match(report.issues.join('\n'), /missing kept materialization: kept-missing/);
  assert.match(report.issues.join('\n'), /orphan temp state: orphan/);
  assert.match(report.issues.join('\n'), /orphan repo state: orphan/);
  assert.deepEqual(await loadState(context.paths.statePath), state);
});

test('sync materializes kept packages and skips temp-only packages', async () => {
  const context = await setupContext();
  const sourceRepo = await createLocalRepo(path.dirname(context.paths.indexPath), 'fixture-repo');
  const kept = makeRecord({ id: 'kept-sync', remotes: [sourceRepo], kept: true });
  const tempOnly = makeRecord({ id: 'temp-sync', remotes: [sourceRepo], kept: false });
  await saveIndexFile(context.paths.indexPath, [kept, tempOnly]);

  const result = await syncKeptRecords(context);
  const state = await loadState(context.paths.statePath);
  const repoState = state.repos[repoKeyFor(kept)];

  assert.equal(result.keptPackagesProcessed, 1);
  assert.ok(repoState);
  assert.equal(await fs.stat(path.join(repoState.path, 'README.md')).then(() => true, () => false), true);
  assert.deepEqual(state.temps, {});
});
