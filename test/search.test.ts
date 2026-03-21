import assert from 'node:assert/strict';
import test from 'node:test';
import { countSearchPackages, searchPackages } from '../src/search.ts';
import type { PackageRecord } from '../src/types.ts';

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

test('search excludes discoverable=false records', () => {
  const records = [
    record({ id: 'hidden-design', summary: 'Design system', discoverable: false }),
    record({ id: 'visible-design', summary: 'Design system', discoverable: true }),
  ];

  const results = searchPackages(records, 'design');

  assert.equal(results.length, 1);
  assert.equal(results[0].record.id, 'visible-design');
  assert.equal(countSearchPackages(records, 'design'), 1);
});

test('search prefers exact id matches over broader content matches', () => {
  const results = searchPackages(
    [
      record({ id: 'design', summary: 'Notes', description: 'Small reference.' }),
      record({ id: 'docs', summary: 'Design handbook', description: 'Design design design design design.' }),
    ],
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

  const page = searchPackages(records, 'design', 1, 1);

  assert.equal(page.length, 1);
  assert.equal(page[0].record.id, 'beta');
});
