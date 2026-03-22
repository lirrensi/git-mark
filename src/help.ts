import type { PackageRecord } from './types.ts';

const COMMAND_LINES = [
  'gmk add <remote[#subpath]> [--id <id>] [--summary <text>] [--description <text>] [--resource <text>] [--yes]',
  'gmk help',
  'gmk list',
  'gmk list-all [--limit <n>] [--offset <n>]',
  'gmk search <query> [--limit <n>] [--offset <n>]',
  'gmk peek <id>',
  'gmk load <id>',
  'gmk path <id>',
  'gmk remove <id>',
  'gmk rm <id>',
  'gmk doctor',
  'gmk cleanup',
  'gmk sync',
  'gmk edit',
  'gmk pin <id>',
  'gmk unpin <id>',
  'gmk update <id>',
  'gmk updateall',
  'gmk freeze <id>',
  'gmk unfreeze <id>',
];

const MCP_ALLOWED_ACTIONS = ['list', 'search', 'peek', 'load'] as const;
const MCP_PINNED_LIMIT = 15;
const MCP_BLURB_LIMIT = 26;

export function getCliHelpText(): string {
  return [
    'git-mark / gmk',
    '',
    'Usage:',
    ...COMMAND_LINES.map((line) => `  ${line}`),
    '',
    'When run in a TTY, `gmk add` inspects the source, previews the fetched files, and asks for missing metadata with arrow-key choices.',
    'Use `--yes` to skip prompts and accept defaults.',
    'Use `gmk pin <id>` and `gmk unpin <id>` to control what surfaces in the global default list.',
    '`gmk remove` / `gmk rm` remove a bookmark and its local materialization; `gmk doctor` checks runtime drift.',
    '`gmk cleanup` prunes disposable runtime state and temp materializations; `gmk sync` materializes all kept packages.',
    '`gmk edit` opens the canonical package index TOML for manual editing.',
    '`gmk list-all` defaults to `--limit 15 --offset 0`; `gmk search` defaults to `--limit 10 --offset 0`.',
    '',
  ].join('\n');
}

function collapseWhitespace(value: string | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function getPinnedBlurb(record: PackageRecord): string {
  const source = collapseWhitespace(record.summary) || collapseWhitespace(record.description);
  if (!source) {
    return '';
  }
  if (source.length <= MCP_BLURB_LIMIT) {
    return source;
  }
  return `${source.slice(0, MCP_BLURB_LIMIT - 3).trimEnd()}...`;
}

function formatPinnedLine(record: PackageRecord): string {
  const safeId = collapseWhitespace(record.id) || 'package';
  const blurb = getPinnedBlurb(record);
  const payload: { id: string; blurb?: string } = { id: safeId };
  if (blurb) {
    payload.blurb = blurb;
  }
  return JSON.stringify(payload);
}

export function getMcpToolInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: [...MCP_ALLOWED_ACTIONS],
        description: 'Action to run. Use list, search, peek, or load.',
      },
      query: {
        type: 'string',
        minLength: 1,
        description: 'Required when action is search.',
      },
      id: {
        type: 'string',
        minLength: 1,
        description: 'Required when action is peek or load.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'Optional maximum result count for search.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Optional result offset for search.',
      },
    },
    required: ['action'],
  };
}

export function getMcpToolDescription(pinnedRecords: PackageRecord[]): string {
  const visibleRecords = pinnedRecords.slice(0, MCP_PINNED_LIMIT);
  const hiddenCount = Math.max(0, pinnedRecords.length - visibleRecords.length);
  const pinnedSection =
    visibleRecords.length > 0
      ? ['Pinned resources (sanitized data):', ...visibleRecords.map(formatPinnedLine)].join('\n')
      : 'Pinned resources: none yet.';

  return [
    'git-mark bookmark manager for git-backed resources.',
    '',
    'MCP tool: send one structured action object, not a free-form command string.',
    `Allowed actions: ${MCP_ALLOWED_ACTIONS.join(', ')}.`,
    'Read-only actions: list, search, peek.',
    'load is allowed and may materialize a repo path.',
    'Not exposed via MCP: remove, update, updateall, cleanup, sync, edit.',
    '',
    'Most used:',
    '{ "action": "list" }',
    '{ "action": "search", "query": "design" }',
    '{ "action": "peek", "id": "design" }',
    '{ "action": "load", "id": "design" }',
    'What to expect:',
    'list -> newline package list with ids and short blurbs',
    'search -> matching packages with ids and short summaries',
    'peek -> package materialization details and local path output',
    'load -> package materialization details and local path output',
    '',
    pinnedSection,
    hiddenCount > 0 ? `${hiddenCount} more available resources. Run \`gmk list\` to see all available packages.` : '',
  ].filter(Boolean).join('\n');
}
