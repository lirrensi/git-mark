import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pinRecord, unpinRecord, loadIndexFile, saveIndexFile } from '../src/index.ts';

function makeContext(root: string) {
  return {
    paths: {
      home: root,
      indexPath: path.join(root, '.gitmarks.toml'),
      configPath: path.join(root, '.gitmark', 'config.toml'),
      logPath: path.join(root, '.gitmark', 'history.log'),
      statePath: path.join(root, '.gitmark', 'state.json'),
      storageRoot: path.join(root, '.gitmark'),
      reposRoot: path.join(root, '.gitmark', 'repos'),
      tempRoot: path.join(root, '.gitmark', 'tmp'),
    },
    config: {
      storage: {
        root: path.join(root, '.gitmark'),
        temp_root: path.join(root, '.gitmark', 'tmp'),
        max_temp_size_mb: 2048,
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
    },
  };
}

test('pinRecord and unpinRecord toggle the surfaced flag only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-pin-test-'));
  const context = makeContext(root);
  await saveIndexFile(context.paths.indexPath, [
    {
      id: 'design',
      remotes: ['https://example.com/repo'],
      pinned: false,
      kept: true,
      discoverable: true,
      frozen: false,
      commit: '',
    },
  ]);

  await pinRecord(context, 'design');
  let records = await loadIndexFile(context.paths.indexPath);
  assert.equal(records[0].pinned, true);
  assert.equal(records[0].kept, true);

  await unpinRecord(context, 'design');
  records = await loadIndexFile(context.paths.indexPath);
  assert.equal(records[0].pinned, false);
  assert.equal(records[0].kept, true);
});

