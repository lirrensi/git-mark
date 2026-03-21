const COMMAND_LINES = [
  'gmk add <remote[#subpath]> [--id <id>] [--summary <text>] [--description <text>] [--resource <text>] [--yes]',
  'gmk help',
  'gmk list',
  'gmk list-all',
  'gmk search <query>',
  'gmk peek <id>',
  'gmk load <id>',
  'gmk path <id>',
  'gmk pin <id>',
  'gmk unpin <id>',
  'gmk update <id>',
  'gmk updateall',
  'gmk freeze <id>',
  'gmk unfreeze <id>',
];

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
    '',
  ].join('\n');
}

export function getMcpToolDescription(pinnedOutput: string): string {
  const pinned = pinnedOutput.trim();
  return [
    'git-mark bookmark manager for git-backed resources.',
    '',
    'Use `gmk help` for the full CLI help. `gmk add` is interactive in a TTY, inspects the source first, and `--yes` skips prompts.',
    'The add flow uses arrow-key choices for pinning, local keeping, and other selection steps.',
    'Common commands: `gmk list`, `gmk list-all`, `gmk search <query>`, `gmk peek <id>`, `gmk load <id>`, `gmk path <id>`, `gmk pin <id>`, and `gmk unpin <id>`.',
    '',
    pinned.length > 0 ? `Pinned resources:\n${pinned}` : 'Pinned resources: none yet.',
  ].join('\n');
}
