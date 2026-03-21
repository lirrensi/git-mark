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

