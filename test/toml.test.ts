import assert from 'node:assert/strict';
import test from 'node:test';
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
      pre_load: '',
      pre_expose: '',
      post_load: '',
      pre_update: '',
      post_update: '',
    },
  });
  const parsed = parseRuntimeConfig(config);
  assert.equal(parsed.storage?.root, '/tmp/gitmark');
});

