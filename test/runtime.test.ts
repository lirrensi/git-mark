import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveToolPaths } from '../src/env.ts';
import { defaultRuntimeConfig, loadState, runHooks } from '../src/index.ts';
import type { CommandContext, PackageRecord } from '../src/types.ts';

function makeContext(root: string, hookModulePath = ''): CommandContext {
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
    indexPath: '/home/tester/.gitmarks.toml',
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
