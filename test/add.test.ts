import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAddDraft, parseResourceList, suggestSummary } from '../src/add.ts';

test('parseResourceList trims and splits values', () => {
  assert.deepEqual(parseResourceList('alpha, beta\n gamma , ,delta'), ['alpha', 'beta', 'gamma', 'delta']);
});

test('suggestSummary prefers a README heading', () => {
  const summary = suggestSummary({
    source: 'https://example.com/repo',
    remote: 'https://example.com/repo',
    preview: [],
    readmeExcerpt: '# Sample Skills\n\nA tiny repo.',
  });
  assert.equal(summary, 'Sample Skills');
});

test('collectAddDraft keeps blank summary blank when the user presses enter', async () => {
  const answers: Array<string | boolean> = ['', 'empty', '', true, true, false];
  const prompt = {
    async input(): Promise<string> {
      return String(answers.shift() ?? '');
    },
    async select<T>(): Promise<T> {
      return answers.shift() as T;
    },
  };
  const draft = await collectAddDraft(
    {
      source: 'https://example.com/repo',
      remote: 'https://example.com/repo',
      preview: [],
      readmeExcerpt: 'README content',
    },
    {},
    prompt,
  );
  assert.equal(draft.summary, '');
  assert.equal(draft.description, '');
  assert.equal(draft.pinned, true);
  assert.equal(draft.kept, true);
  assert.equal(draft.discoverable, false);
});
