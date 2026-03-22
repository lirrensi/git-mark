import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectRepoArtifacts } from '../src/artifacts.ts';
import type { PackageRecord } from '../src/types.ts';

function record(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: 'design-skill',
    remotes: ['https://example.com/repo'],
    subpath: 'skills/design',
    pinned: true,
    kept: true,
    discoverable: true,
    frozen: false,
    commit: '',
    ...overrides,
  };
}

test('collectRepoArtifacts truncates README text at 16384 characters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-artifacts-readme-'));
  await fs.mkdir(path.join(root, 'skills', 'design'), { recursive: true });
  await fs.writeFile(path.join(root, 'skills', 'design', 'README.md'), 'a'.repeat(17_000), 'utf8');

  const artifacts = await collectRepoArtifacts(root, record(), 'abc123');

  assert.equal(artifacts.readmeText?.length, 16_384);
  assert.equal(artifacts.readmeSource, 'skills/design/README.md');
});

test('collectRepoArtifacts uses the visible subpath for preview and skill discovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmk-artifacts-visible-'));
  await fs.mkdir(path.join(root, 'skills', 'design', 'good-skill'), { recursive: true });
  await fs.mkdir(path.join(root, 'skills', 'design', 'bad-skill'), { recursive: true });
  await fs.mkdir(path.join(root, 'outside-skill'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), 'root readme', 'utf8');
  await fs.writeFile(path.join(root, 'root-only.txt'), 'hidden from preview', 'utf8');
  await fs.writeFile(path.join(root, 'skills', 'design', 'README.md'), '# Visible readme', 'utf8');
  await fs.writeFile(path.join(root, 'skills', 'design', 'visible.txt'), 'visible', 'utf8');
  await fs.writeFile(
    path.join(root, 'skills', 'design', 'good-skill', 'SKILL.md'),
    '---\nname: Design Skill\ndescription: Reusable design workflow\n---\n# Body\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'skills', 'design', 'bad-skill', 'SKILL.md'),
    '---\nname: Missing Description\n---\n# Body\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'outside-skill', 'SKILL.md'),
    '---\nname: Outside Skill\ndescription: Should not be collected\n---\n',
    'utf8',
  );

  const artifacts = await collectRepoArtifacts(root, record(), 'def456');

  assert.equal(artifacts.readmeSource, 'skills/design/README.md');
  assert.equal(artifacts.preview?.includes('visible.txt'), true);
  assert.equal(artifacts.preview?.includes('root-only.txt'), false);
  assert.deepEqual(artifacts.skills, {
    'Design Skill': 'Reusable design workflow',
  });
});
