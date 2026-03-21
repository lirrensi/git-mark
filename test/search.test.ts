import assert from 'node:assert/strict';
import test from 'node:test';
import { searchPackages } from '../src/search.ts';

test('search prefers exact id matches', () => {
  const results = searchPackages(
    [
      { id: 'design', remotes: ['https://example.com/a'], summary: 'Templates', discoverable: true },
      { id: 'docs', remotes: ['https://example.com/b'], summary: 'Design docs', discoverable: true },
    ],
    'design',
  );
  assert.equal(results[0].record.id, 'design');
});

test('search paging honors limit and offset', () => {
  const records = [
    { id: 'alpha', remotes: ['https://example.com/a'], summary: 'alpha design', discoverable: true },
    { id: 'beta', remotes: ['https://example.com/b'], summary: 'beta design', discoverable: true },
    { id: 'gamma', remotes: ['https://example.com/c'], summary: 'gamma design', discoverable: true },
  ];
  const page = searchPackages(records, 'design', 1, 1);
  assert.equal(page.length, 1);
  assert.equal(page[0].record.id, 'beta');
});
