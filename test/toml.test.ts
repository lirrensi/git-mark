import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadRuntimeConfig } from '../src/config.ts';
import { loadIndexFile } from '../src/index.ts';
import { parsePackageIndex, stringifyPackageIndex, parseRuntimeConfig, stringifyRuntimeConfig } from '../src/toml.ts';

test('package index round trip', () => {
  const original = [
    {
      id: 'design',
      remotes: ['https://github.com/you/mega-repo'],
      subpath: 'skills/design',
      summary: 'Design references',
      description: 'Longer explanation',
      resources: ['templates', 'guidelines'],
      pinned: true,
      kept: true,
      discoverable: true,
      frozen: false,
      commit: '',
    },
  ];
  const text = stringifyPackageIndex(original);
  const parsed = parsePackageIndex(text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'design');
  assert.deepEqual(parsed[0].resources, ['templates', 'guidelines']);
});

test('runtime config round trip', () => {
  const config = stringifyRuntimeConfig({
    storage: {
      root: '/tmp/gitmark',
      temp_root: '/tmp/gitmark/tmp',
      max_temp_size_mb: 64,
    },
    network: {
      git_timeout_sec: 120,
      allow_lfs: false,
    },
    hooks: {
      module: '~/hooks/gitmark-hooks.ts',
    },
  });
  const parsed = parseRuntimeConfig(config);
  assert.equal(parsed.storage?.root, '/tmp/gitmark');
  assert.equal(parsed.hooks?.module, '~/hooks/gitmark-hooks.ts');
});

test('runtime config parses hooks.module from TOML', () => {
  const parsed = parseRuntimeConfig('[hooks]\nmodule = "./hooks.ts"\n');
  assert.equal(parsed.hooks?.module, './hooks.ts');
});

test('malformed config.toml fails loudly after the file exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-config-invalid-'));
  const configPath = path.join(root, 'config.toml');
  await fs.writeFile(configPath, 'root = "/tmp/outside-section"\n', 'utf8');

  await assert.rejects(
    () => loadRuntimeConfig(configPath),
    /Could not load config file .*config\.toml: Invalid config TOML at line 1: keys must appear inside/,
  );
});

test('malformed package index fails loudly with line context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-index-invalid-'));
  const indexPath = path.join(root, '.gitmark', 'index.toml');
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, '[[package]]\nid = "design"\n', 'utf8');

  await assert.rejects(
    () => loadIndexFile(indexPath),
    /Invalid index TOML at line \d+: package "design" is missing remotes\./,
  );
});
