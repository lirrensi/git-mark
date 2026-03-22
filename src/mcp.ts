#!/usr/bin/env -S node --experimental-strip-types
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ensureConfigFile, loadRuntimeConfig } from './config.ts';
import { ensureToolDirectories, getBootstrapPaths, resolveToolPaths } from './env.ts';
import { getMcpToolDescription, getMcpToolInputSchema } from './help.ts';
import { loadIndexFile } from './index.ts';
import { buildNodeLaunchCommand, resolveSiblingEntry } from './runtime.ts';
import type { PackageRecord } from './types.ts';

const execFileAsync = promisify(execFile);
const cliEntry = resolveSiblingEntry(import.meta.url, 'cli');
const MCP_TOOL_NAME = 'git_mark';

type McpAction = 'list' | 'search' | 'peek' | 'load';

interface ParsedMcpCall {
  action: McpAction;
  id?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

interface CliExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface McpDependencies {
  loadBootstrapFiles: () => Promise<void>;
  buildToolDescription: () => Promise<string>;
  runMcpAction: (call: ParsedMcpCall) => Promise<CliExecutionResult>;
}

function parseInteger(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new McpError(-32602, `Invalid ${field}: expected an integer >= ${minimum}.`);
  }
  return parsed;
}

function parseString(value: unknown, field: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new McpError(-32602, `Invalid ${field}: expected a non-empty string.`);
  }
  return trimmed;
}

export function parseMcpCallArguments(raw: unknown): ParsedMcpCall {
  if (!raw || typeof raw !== 'object') {
    throw new McpError(-32602, 'Invalid arguments: expected an object.');
  }

  const values = raw as Record<string, unknown>;
  const action = parseString(values.action, 'action');
  if (!action || !(['list', 'search', 'peek', 'load'] as const).includes(action as McpAction)) {
    throw new McpError(-32602, 'Invalid action: expected list, search, peek, or load.');
  }
  const typedAction = action as McpAction;

  if (typedAction === 'list') {
    return { action: typedAction };
  }

  if (typedAction === 'search') {
    const query = parseString(values.query, 'query');
    if (!query) {
      throw new McpError(-32602, 'Invalid query: expected a non-empty string.');
    }
    const limit = parseInteger(values.limit, 'limit', 1);
    const offset = parseInteger(values.offset, 'offset', 0);
    return { action: typedAction, query, limit, offset };
  }

  const id = parseString(values.id, 'id');
  if (!id) {
    throw new McpError(-32602, 'Invalid id: expected a non-empty string.');
  }
  return { action: typedAction, id };
}

async function runCliArgs(args: string[]): Promise<CliExecutionResult> {
  const delegatedCli = buildNodeLaunchCommand(cliEntry, args);
  try {
    const result = await execFileAsync(delegatedCli.command, delegatedCli.args, {
      encoding: 'utf8',
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      exitCode: 0,
    };
  } catch (error) {
    const captured = error as { stdout?: string; stderr?: string; code?: number | string };
    const stderr = String(captured.stderr ?? '').trim();
    const startupFailure =
      stderr.length > 0
        ? stderr
        : error instanceof Error
          ? `Failed to start delegated CLI: ${error.message}`
          : `Failed to start delegated CLI: ${String(error)}`;
    return {
      stdout: String(captured.stdout ?? ''),
      stderr: startupFailure,
      exitCode: typeof captured.code === 'number' ? captured.code : 1,
    };
  }
}

async function runMcpAction(call: ParsedMcpCall): Promise<CliExecutionResult> {
  switch (call.action) {
    case 'list':
      return runCliArgs(['list']);
    case 'search': {
      const args = ['search', call.query ?? ''];
      if (typeof call.limit === 'number') {
        args.push('--limit', String(call.limit));
      }
      if (typeof call.offset === 'number') {
        args.push('--offset', String(call.offset));
      }
      return runCliArgs(args);
    }
    case 'peek':
      return runCliArgs(['peek', call.id ?? '']);
    case 'load':
      return runCliArgs(['load', call.id ?? '']);
  }
}

async function buildToolDescription(): Promise<string> {
  const bootstrapPaths = getBootstrapPaths();
  const records = await loadIndexFile(bootstrapPaths.indexPath);
  const pinnedRecords: PackageRecord[] = records
    .filter((record) => record.pinned !== false)
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  return getMcpToolDescription(pinnedRecords);
}

async function loadBootstrapFiles(): Promise<void> {
  const bootstrapPaths = getBootstrapPaths();
  await ensureConfigFile(bootstrapPaths.configPath);
  const config = await loadRuntimeConfig(bootstrapPaths.configPath);
  const paths = resolveToolPaths(bootstrapPaths, config);
  await ensureToolDirectories(paths);
  await loadIndexFile(bootstrapPaths.indexPath);
}

function formatToolResult(result: CliExecutionResult): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  const text = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
  return {
    content: [
      {
        type: 'text',
        text: text.length > 0 ? text : result.exitCode === 0 ? '' : `command exited with code ${result.exitCode}`,
      },
    ],
    isError: result.exitCode !== 0,
  };
}

export function createMcpServer(deps: Partial<McpDependencies> = {}): Server {
  const resolvedDeps: McpDependencies = {
    loadBootstrapFiles,
    buildToolDescription,
    runMcpAction,
    ...deps,
  };

  const server = new Server(
    { name: 'git-mark', version: '0.2.0' },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: MCP_TOOL_NAME,
        description: await resolvedDeps.buildToolDescription(),
        inputSchema: getMcpToolInputSchema(),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== MCP_TOOL_NAME) {
      throw new McpError(-32601, `Unknown tool: ${request.params.name}`);
    }

    const call = parseMcpCallArguments(request.params.arguments);
    const result = await resolvedDeps.runMcpAction(call);
    return formatToolResult(result);
  });

  return server;
}

export async function startMcpServer(
  transport: Transport = new StdioServerTransport(),
  deps: Partial<McpDependencies> = {},
): Promise<Server> {
  const resolvedDeps: McpDependencies = {
    loadBootstrapFiles,
    buildToolDescription,
    runMcpAction,
    ...deps,
  };

  await resolvedDeps.loadBootstrapFiles();
  const server = createMcpServer(resolvedDeps);
  await server.connect(transport);
  return server;
}

export async function runMcp(): Promise<void> {
  await startMcpServer();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runMcp();
}
