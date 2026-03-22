#!/usr/bin/env -S node --experimental-strip-types
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureToolDirectories, getBootstrapPaths, resolveToolPaths } from './env.ts';
import { ensureConfigFile, loadRuntimeConfig } from './config.ts';
import { loadIndexFile } from './index.ts';
import { getMcpToolDescription, getMcpToolInputSchema } from './help.ts';
import type { PackageRecord } from './types.ts';

const execFileAsync = promisify(execFile);
const currentFile = fileURLToPath(import.meta.url);
const isTypeScriptEntry = currentFile.endsWith('.ts');
const cliEntry = path.join(path.dirname(currentFile), isTypeScriptEntry ? 'cli.ts' : 'cli.js');
const MCP_TOOL_NAME = 'git_mark';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type McpAction = 'list' | 'search' | 'peek' | 'load';

interface ParsedMcpCall {
  action: McpAction;
  id?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

function parseInteger(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${field}: expected an integer >= ${minimum}.`);
  }
  return parsed;
}

function parseString(value: unknown, field: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Invalid ${field}: expected a non-empty string.`);
  }
  return trimmed;
}

function parseMcpCallArguments(raw: unknown): ParsedMcpCall {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid arguments: expected an object.');
  }

  const values = raw as Record<string, unknown>;
  const action = parseString(values.action, 'action');
  if (!action || !['list', 'search', 'peek', 'load'].includes(action)) {
    throw new Error('Invalid action: expected list, search, peek, or load.');
  }

  if (action === 'list') {
    return { action };
  }

  if (action === 'search') {
    const query = parseString(values.query, 'query');
    if (!query) {
      throw new Error('Invalid query: expected a non-empty string.');
    }
    const limit = parseInteger(values.limit, 'limit', 1);
    const offset = parseInteger(values.offset, 'offset', 0);
    return { action, query, limit, offset };
  }

  const id = parseString(values.id, 'id');
  if (!id) {
    throw new Error('Invalid id: expected a non-empty string.');
  }
  return { action, id };
}

async function runCliArgs(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const nodeArgs = isTypeScriptEntry ? ['--experimental-strip-types', cliEntry, ...args] : [cliEntry, ...args];
    const result = await execFileAsync(process.execPath, nodeArgs, {
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
    const captured = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: String(captured.stdout ?? ''),
      stderr: String(captured.stderr ?? (error instanceof Error ? error.message : String(error))),
      exitCode: typeof captured.code === 'number' ? captured.code : 1,
    };
  }
}

async function runMcpAction(call: ParsedMcpCall): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        protocolVersion: String(request.params?.protocolVersion ?? '2024-11-05'),
        serverInfo: {
          name: 'git-mark',
          version: '0.2.0',
        },
        capabilities: {
          tools: {},
        },
      },
    };
  }

  if (request.method === 'tools/list') {
    const description = await buildToolDescription();
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        tools: [
          {
            name: MCP_TOOL_NAME,
            description,
            inputSchema: getMcpToolInputSchema(),
          },
        ],
      },
    };
  }

  if (request.method === 'tools/call') {
    const toolName = String(request.params?.name ?? '');
    if (toolName !== MCP_TOOL_NAME) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    }
    let call: ParsedMcpCall;
    try {
      call = parseMcpCallArguments(request.params?.arguments);
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          code: -32602,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const result = await runMcpAction(call);
    const text = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        content: [
          {
            type: 'text',
            text: text.length > 0 ? text : result.exitCode === 0 ? '' : `command exited with code ${result.exitCode}`,
          },
        ],
        isError: result.exitCode !== 0,
      },
    };
  }

  if (request.method === 'shutdown' || request.method === 'exit') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: null,
    };
  }

  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    error: { code: -32601, message: `Unknown method: ${request.method}` },
  };
}

function encodeMessage(payload: JsonRpcResponse): Buffer {
  const body = JSON.stringify(payload);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`, 'utf8');
}

async function loadBootstrapFiles(): Promise<void> {
  const bootstrapPaths = getBootstrapPaths();
  await ensureConfigFile(bootstrapPaths.configPath);
  const config = await loadRuntimeConfig(bootstrapPaths.configPath);
  const paths = resolveToolPaths(bootstrapPaths, config);
  await ensureToolDirectories(paths);
  await loadIndexFile(bootstrapPaths.indexPath);
}

export async function runMcp(): Promise<void> {
  await loadBootstrapFiles();

  let buffer = Buffer.alloc(0);
  let exiting = false;
  let processing = Promise.resolve();

  const send = (message: JsonRpcResponse): void => {
    process.stdout.write(encodeMessage(message));
  };

  const parseBuffer = async (): Promise<void> => {
    while (true) {
      const separator = buffer.indexOf(Buffer.from('\r\n\r\n'));
      if (separator === -1) {
        return;
      }
      const headerText = buffer.slice(0, separator).toString('utf8');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        return;
      }
      const contentLength = Number(match[1]);
      const bodyStart = separator + 4;
      if (buffer.length < bodyStart + contentLength) {
        return;
      }
      const body = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
      buffer = buffer.slice(bodyStart + contentLength);
      const request = JSON.parse(body) as JsonRpcRequest;
      const response = await handleRequest(request);
      if (response) {
        send(response);
      }
      if (request.method === 'exit') {
        exiting = true;
      }
    }
  };

  process.stdin.resume();
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    processing = processing
      .then(() => parseBuffer())
      .catch((error) => {
        send({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
  });

  process.stdin.on('end', () => {
    void processing.then(() => {
      if (exiting) {
        process.exit(0);
      }
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runMcp();
}
