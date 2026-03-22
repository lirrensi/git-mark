import assert from 'node:assert/strict';
import test from 'node:test';
import { repoKeyFor } from '../src/index.ts';
import { countSearchPackages, searchPackages } from '../src/search.ts';
import type { PackageRecord, ToolState } from '../src/types.ts';

function record(overrides: Partial<PackageRecord>): PackageRecord {
  return {
    id: 'package',
    remotes: ['https://example.com/repo'],
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

function emptyState(): ToolState {
  return { repos: {}, temps: {} };
}

function stateWithArtifacts(recordValue: PackageRecord, artifacts: NonNullable<ToolState['repos'][string]['artifacts']>): ToolState {
  return recordValue.kept
    ? { repos: { [repoKeyFor(recordValue)]: { path: '', selectedRemote: '', defaultBranch: '', lastCommit: '', updatedAt: '', artifacts } }, temps: {} }
    : { repos: {}, temps: { [recordValue.id]: { path: '', repoKey: repoKeyFor(recordValue), selectedRemote: '', defaultBranch: '', materializedAt: '', lastAccessedAt: '', artifacts } } };
}

test('search excludes discoverable=false records', () => {
  const records = [
    record({ id: 'hidden-design', summary: 'Design system', discoverable: false }),
    record({ id: 'visible-design', summary: 'Design system', discoverable: true }),
  ];

  const results = searchPackages(records, emptyState(), 20, 0, 'design');

  assert.equal(results.length, 1);
  assert.equal(results[0].record.id, 'visible-design');
  assert.equal(countSearchPackages(records, emptyState(), 'design'), 1);
});

test('search prefers exact id matches over broader content matches', () => {
  const exact = record({ id: 'design', summary: 'Notes', description: 'Small reference.' });
  const readmeOnly = record({ id: 'docs', summary: 'Notes', description: 'Small reference.' });
  const state = stateWithArtifacts(readmeOnly, { readmeText: 'design design design handbook' });
  const results = searchPackages(
    [exact, readmeOnly],
    state,
    20,
    0,
    'design',
  );

  assert.equal(results[0].record.id, 'design');
});

test('search ranks multi-word summary and description matches sensibly', () => {
  const results = searchPackages(
    [
      record({
        id: 'design-system',
        summary: 'Design component system starter',
        description: 'Component library guidance for a design system rollout.',
      }),
      record({
        id: 'component-guide',
        summary: 'Component handbook',
        description: 'Design tokens and component examples.',
      }),
      record({
        id: 'release-notes',
        summary: 'Monthly release notes',
        description: 'Operational updates only.',
      }),
    ],
    emptyState(),
    20,
    0,
    'design component',
  );

  assert.equal(results[0].record.id, 'design-system');
  assert.equal(results[1].record.id, 'component-guide');
});

test('search supports prefix matching for partial lookups', () => {
  const results = searchPackages(
    [
      record({ id: 'typescript-utils', summary: 'TypeScript helpers' }),
        record({ id: 'notes', summary: 'Plain notes' }),
    ],
    emptyState(),
    20,
    0,
    'type',
  );

  assert.equal(results[0].record.id, 'typescript-utils');
});

test('search supports light fuzzy matching for near tokens', () => {
  const results = searchPackages(
    [
      record({ id: 'observability', summary: 'Observability dashboards and tracing' }),
        record({ id: 'security', summary: 'Access controls' }),
    ],
    emptyState(),
    20,
    0,
    'observabilty',
  );

  assert.equal(results[0].record.id, 'observability');
});

test('search paging honors limit and offset', () => {
  const records = [
    record({ id: 'alpha', summary: 'design' }),
    record({ id: 'beta', summary: 'design' }),
    record({ id: 'gamma', summary: 'design' }),
  ];

  const page = searchPackages(records, emptyState(), 1, 1, 'design');

  assert.equal(page.length, 1);
  assert.equal(page[0].record.id, 'beta');
});

test('search uses cached README text for recall', () => {
  const readmeRecord = record({ id: 'notes' });
  const results = searchPackages(
    [readmeRecord],
    stateWithArtifacts(readmeRecord, { readmeText: 'mini search tutorial and cookbook' }),
    20,
    0,
    'cookbook',
  );

  assert.equal(results[0].record.id, 'notes');
});

test('search uses cached skill descriptions for recall', () => {
  const skillRecord = record({ id: 'toolbox' });
  const results = searchPackages(
    [skillRecord],
    stateWithArtifacts(skillRecord, { skills: { 'Search Helper': 'indexes local repos for recall' } }),
    20,
    0,
    'indexes',
  );

  assert.equal(results[0].record.id, 'toolbox');
});
