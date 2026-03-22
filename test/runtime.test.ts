import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getBootstrapPaths, resolveToolPaths } from '../src/env.ts';
import {
  cleanupTempMaterializations,
  defaultRuntimeConfig,
  loadState,
  persistRecordArtifacts,
  reconcileRuntimeState,
  repoKeyFor,
  runHooks,
  saveIndexFile,
  saveState,
} from '../src/index.ts';
import type { CommandContext, PackageRecord } from '../src/types.ts';

function makeContext(root: string, hookModulePath = ''): CommandContext {
  return {
    paths: {
      home: root,
      indexPath: path.join(root, '.gitmark', 'index.toml'),
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
        temp_root: path.join(root, 'scratch'),
        max_temp_size_mb: 64,
      },
      network: {
        git_timeout_sec: 180,
        allow_lfs: false,
      },
      hooks: {
        module: hookModulePath,
      },
    },
  };
}

test('effective runtime paths honor loaded storage roots', () => {
  const bootstrapPaths = {
    home: '/home/tester',
    indexPath: '/home/tester/.gitmark/index.toml',
    configPath: '/home/tester/.gitmark/config.toml',
  };
  const paths = resolveToolPaths(bootstrapPaths, {
    storage: {
      root: '/var/lib/gitmark-data',
      temp_root: '/var/tmp/gitmark-scratch',
      max_temp_size_mb: 64,
    },
    network: {
      git_timeout_sec: 180,
      allow_lfs: false,
    },
    hooks: {
      module: '',
    },
  });
  assert.equal(paths.indexPath, bootstrapPaths.indexPath);
  assert.equal(paths.configPath, bootstrapPaths.configPath);
  assert.equal(paths.storageRoot, '/var/lib/gitmark-data');
  assert.equal(paths.reposRoot, path.join('/var/lib/gitmark-data', 'repos'));
  assert.equal(paths.logPath, path.join('/var/lib/gitmark-data', 'history.log'));
  assert.equal(paths.statePath, path.join('/var/lib/gitmark-data', 'state.json'));
  assert.equal(paths.tempRoot, '/var/tmp/gitmark-scratch');
});

test('bootstrap paths use ~/.gitmark/index.toml', () => {
  const bootstrapPaths = getBootstrapPaths();
  assert.match(bootstrapPaths.indexPath, /[\\/]\.gitmark[\\/]index\.toml$/);
});

test('default runtime config uses a 180 second git timeout', () => {
  const config = defaultRuntimeConfig();
  assert.equal(config.network.git_timeout_sec, 180);
});

test('TypeScript hook modules load and receive hook context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-hook-test-'));
  const outputPath = path.join(root, 'hook-output.json');
  const hookModulePath = path.join(root, 'hooks.ts');
  await fs.writeFile(
    hookModulePath,
    `import fs from 'node:fs/promises';\nexport async function preLoad(context) {\n  await fs.writeFile(${JSON.stringify(outputPath)}, JSON.stringify(context), 'utf8');\n}\n`,
    'utf8',
  );
  const context = makeContext(root, hookModulePath);
  const record: PackageRecord = {
    id: 'design',
    remotes: ['https://example.com/repo'],
    subpath: 'skills/design',
    pinned: true,
    kept: true,
    discoverable: true,
    frozen: false,
    commit: '',
  };

  await runHooks(context, 'preLoad', record, path.join(root, 'repo'), record.remotes[0], 'main');

  const captured = JSON.parse(await fs.readFile(outputPath, 'utf8')) as Record<string, string>;
  assert.equal(captured.packageId, 'design');
  assert.equal(captured.selectedRemote, 'https://example.com/repo');
  assert.equal(captured.subpath, 'skills/design');
  assert.equal(captured.defaultBranch, 'main');
  assert.equal(captured.hookName, 'preLoad');
  assert.match(captured.visiblePath, /skills[\\/]design$/);
});

test('malformed state.json is preserved and recovered as empty state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-state-test-'));
  const statePath = path.join(root, 'state.json');
  await fs.writeFile(statePath, '{not valid json', 'utf8');

  const state = await loadState(statePath);
  const entries = await fs.readdir(root);
  const brokenEntry = entries.find((entry) => entry.startsWith('state.broken-'));

  assert.deepEqual(state, { repos: {}, temps: {} });
  assert.ok(brokenEntry);
  assert.equal(entries.includes('state.json'), false);
  assert.equal(await fs.readFile(path.join(root, brokenEntry as string), 'utf8'), '{not valid json');
});

test('loadState preserves entries when artifacts are missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-state-compat-'));
  const statePath = path.join(root, 'state.json');
  await fs.writeFile(
    statePath,
    JSON.stringify({
      repos: {
        kept: {
          path: '/repo',
          selectedRemote: 'https://example.com/repo',
          defaultBranch: 'main',
          lastCommit: 'abc123',
          updatedAt: '2026-03-22T00:00:00.000Z',
        },
      },
      temps: {
        temp: {
          path: '/tmp/repo',
          repoKey: 'kept',
          selectedRemote: 'https://example.com/repo',
          defaultBranch: 'main',
          materializedAt: '2026-03-22T00:00:00.000Z',
          lastAccessedAt: '2026-03-22T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );

  const state = await loadState(statePath);

  assert.equal(state.repos.kept.artifacts, undefined);
  assert.equal(state.temps.temp.artifacts, undefined);
  assert.equal(state.repos.kept.defaultBranch, 'main');
});

test('persistRecordArtifacts writes cached README text and skills into state.json', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-artifact-state-'));
  const context = makeContext(root);
  await fs.mkdir(context.paths.storageRoot, { recursive: true });
  await saveState(context.paths.statePath, { repos: {}, temps: {} });
  const record: PackageRecord = {
    id: 'design-skill',
    remotes: ['https://example.com/repo'],
    pinned: true,
    kept: true,
    discoverable: true,
    frozen: false,
    commit: '',
  };

  await persistRecordArtifacts(context, record, {
    readmeText: '# Design skill\nLocal artifact cache.',
    readmeSource: 'README.md',
    preview: ['README.md', 'skills/design/SKILL.md'],
    skills: {
      'Design Skill': 'Reusable design workflow',
    },
  });

  const state = await loadState(context.paths.statePath);
  const repoState = state.repos[repoKeyFor(record)];

  assert.equal(repoState.artifacts?.readmeSource, 'README.md');
  assert.equal(repoState.artifacts?.readmeText, '# Design skill\nLocal artifact cache.');
  assert.deepEqual(repoState.artifacts?.skills, {
    'Design Skill': 'Reusable design workflow',
  });
});

test('inspection-only artifacts survive reconciliation and temp cleanup before materialization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-inspection-artifacts-'));
  const context = makeContext(root);
  await fs.mkdir(context.paths.storageRoot, { recursive: true });
  await fs.mkdir(context.paths.tempRoot, { recursive: true });
  const keptRecord: PackageRecord = {
    id: 'kept-artifact',
    remotes: ['https://example.com/kept'],
    pinned: true,
    kept: true,
    discoverable: true,
    frozen: false,
    commit: '',
  };
  const tempRecord: PackageRecord = {
    id: 'temp-artifact',
    remotes: ['https://example.com/temp'],
    pinned: true,
    kept: false,
    discoverable: true,
    frozen: false,
    commit: '',
  };
  await saveIndexFile(context.paths.indexPath, [keptRecord, tempRecord]);
  await saveState(context.paths.statePath, { repos: {}, temps: {} });
  await persistRecordArtifacts(context, keptRecord, { readmeText: 'kept readme' });
  await persistRecordArtifacts(context, tempRecord, { readmeText: 'temp readme' });

  await reconcileRuntimeState(context, {
    pruneOrphanRepoDirectories: true,
    pruneOrphanTempDirectories: true,
  });
  await cleanupTempMaterializations(context);

  const state = await loadState(context.paths.statePath);
  assert.equal(state.repos[repoKeyFor(keptRecord)]?.path, '');
  assert.equal(state.repos[repoKeyFor(keptRecord)]?.artifacts?.readmeText, 'kept readme');
  assert.equal(state.temps[tempRecord.id]?.path, '');
  assert.equal(state.temps[tempRecord.id]?.artifacts?.readmeText, 'temp readme');
});
