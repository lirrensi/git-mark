import type { AddDraft, AddInspection } from './types.ts';

export function parseResourceList(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function limitText(input: string, maxLength: number): string {
  return input.length > maxLength ? `${input.slice(0, maxLength - 1).trimEnd()}…` : input;
}

export function suggestSummary(inspection: AddInspection): string {
  const excerpt = inspection.readmeExcerpt?.trim();
  if (excerpt) {
    const heading = excerpt.match(/(?:^|\n)\s*#+\s+([^\n]+)/);
    if (heading?.[1]) {
      return limitText(normalizeWhitespace(heading[1]), 300);
    }
    const firstSentence = excerpt.split(/(?<=[.!?])\s+/)[0];
    if (firstSentence) {
      return limitText(normalizeWhitespace(firstSentence), 300);
    }
  }
  const parts = [inspection.remote.split('/').pop() ?? inspection.remote];
  if (inspection.subpath) {
    parts.push(inspection.subpath);
  }
  return limitText(parts.filter(Boolean).join(' / '), 300);
}

export function formatInspection(inspection: AddInspection): string {
  const lines = [
    'Add preview',
    `  remote: ${inspection.remote}`,
  ];
  if (inspection.subpath) {
    lines.push(`  subpath: ${inspection.subpath}`);
  }
  if (inspection.readmeExcerpt) {
    lines.push(`  readme: ${limitText(normalizeWhitespace(inspection.readmeExcerpt), 220)}`);
  }
  if (inspection.preview.length > 0) {
    lines.push('  visible files:');
    for (const item of inspection.preview) {
      lines.push(`    ${item}`);
    }
  }
  return lines.join('\n');
}

export interface PromptAdapter {
  input(message: string, initial?: string): Promise<string>;
  select<T>(message: string, choices: Array<{ name: string; value: T }>, initial?: T): Promise<T>;
}

export type DuplicateAddResolution = 'replace' | 'keep-both' | 'cancel';

export async function createPromptAdapter(): Promise<PromptAdapter> {
  const { input: askInput, select: askSelect } = await import('@inquirer/prompts');
  return {
    async input(message: string, initial = ''): Promise<string> {
      const answer = await askInput({
        message,
        default: initial.length > 0 ? initial : undefined,
      });
      return answer.trim();
    },
    async select<T>(message: string, choices: Array<{ name: string; value: T }>, initial?: T): Promise<T> {
      return askSelect({
        message,
        choices,
        default: initial === undefined ? undefined : choices.findIndex((choice) => Object.is(choice.value, initial)),
      });
    },
  };
}

export async function collectAddDraft(
  inspection: AddInspection,
  defaults: Partial<AddDraft>,
  prompt: PromptAdapter,
): Promise<AddDraft> {
  const summary = await prompt.input('Summary (leave blank to keep empty)', defaults.summary ?? '');
  let description = defaults.description ?? '';
  if (defaults.description === undefined) {
    if (inspection.readmeExcerpt) {
      const descriptionMode = await prompt.select('Description', [
        { name: 'Use README excerpt', value: 'readme' },
        { name: 'Leave empty', value: 'empty' },
        { name: 'Write my own', value: 'custom' },
      ], 'readme');
      if (descriptionMode === 'readme') {
        description = inspection.readmeExcerpt;
      } else if (descriptionMode === 'custom') {
        description = await prompt.input('Description (optional)', '');
      } else {
        description = '';
      }
    }
  }
  const resources =
    defaults.resources !== undefined
      ? defaults.resources
      : parseResourceList(await prompt.input('Resources or notes (comma-separated, optional)', ''));
  const pinned =
    defaults.pinned !== undefined
      ? defaults.pinned
      : await prompt.select('Visibility', [
          { name: 'Global: pin in default list', value: true },
          { name: 'Local only: hide from default list', value: false },
        ], true);
  const kept =
    defaults.kept !== undefined
      ? defaults.kept
      : await prompt.select('Storage', [
          { name: 'Local: keep a stable copy', value: true },
          { name: 'Temporary: reclone when needed', value: false },
        ], true);
  const discoverable =
    defaults.discoverable !== undefined
      ? defaults.discoverable
      : await prompt.select('Search visibility', [
          { name: 'Searchable by default', value: true },
          { name: 'Hidden from search', value: false },
        ], true);

  return {
    summary,
    description,
    resources,
    pinned,
    kept,
    discoverable,
  };
}

export async function resolveDuplicateAdd(prompt: PromptAdapter, existingId: string): Promise<DuplicateAddResolution> {
  return prompt.select(
    `Package already exists as ${existingId}`,
    [
      { name: 'Replace the existing record', value: 'replace' },
      { name: 'Keep both under another id', value: 'keep-both' },
      { name: 'Cancel', value: 'cancel' },
    ],
    'replace',
  );
}

export async function promptForUniqueId(
  prompt: PromptAdapter,
  suggestedId: string,
  existingIds: Iterable<string>,
): Promise<string> {
  const takenIds = new Set(existingIds);
  let message = 'Package id';
  for (;;) {
    const chosenId = await prompt.input(message, suggestedId);
    if (!takenIds.has(chosenId)) {
      return chosenId;
    }
    message = 'Package id already exists; choose another id';
  }
}
