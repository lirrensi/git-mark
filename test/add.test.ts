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

test('collectAddDraft uses the suggested summary as the default value', async () => {
  const answers: Array<string | boolean> = ['Suggested summary', 'empty', '', true, true, false];
  const seenInitialValues: string[] = [];
  const prompt = {
    async input(_message: string, initial?: string): Promise<string> {
      seenInitialValues.push(initial ?? '');
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
    { summary: 'Suggested summary' },
    prompt,
  );
  assert.equal(draft.summary, 'Suggested summary');
  assert.equal(seenInitialValues[0], 'Suggested summary');
  assert.equal(draft.description, '');
  assert.equal(draft.pinned, true);
  assert.equal(draft.kept, true);
  assert.equal(draft.discoverable, false);
});

test('collectAddDraft keeps an explicitly cleared summary empty', async () => {
  const answers: Array<string | boolean> = ['', 'empty', '', true, true, false];
  const prompt = {
    async input(message: string, initial?: string): Promise<string> {
      if (message.startsWith('Summary')) {
        assert.equal(initial, 'Suggested summary');
      }
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
    { summary: 'Suggested summary' },
    prompt,
  );
  assert.equal(draft.summary, '');
  assert.equal(draft.description, '');
  assert.equal(draft.pinned, true);
  assert.equal(draft.kept, true);
  assert.equal(draft.discoverable, false);
});
