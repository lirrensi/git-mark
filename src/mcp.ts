#!/usr/bin/env -S node --experimental-strip-types
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureToolDirectories, getBootstrapPaths, resolveToolPaths } from './env.ts';
import { ensureConfigFile, loadRuntimeConfig } from './config.ts';
import { loadIndexFile } from './index.ts';
import { getMcpToolDescription } from './help.ts';

const execFileAsync = promisify(execFile);
const currentFile = fileURLToPath(import.meta.url);
const cliEntry = path.join(path.dirname(currentFile), 'cli.ts');

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

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(char) && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

async function runCli(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = tokenizeCommand(command);
  try {
    const result = await execFileAsync(process.execPath, ['--experimental-strip-types', cliEntry, ...args], {
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

async function buildToolDescription(): Promise<string> {
  const result = await runCli('list');
  return getMcpToolDescription(result.stdout);
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
            name: 'git_mark',
            description,
            inputSchema: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  description: 'CLI-style `gmk` command string.',
                },
              },
              required: ['command'],
            },
          },
        ],
      },
    };
  }

  if (request.method === 'tools/call') {
    const toolName = String(request.params?.name ?? '');
    if (toolName !== 'git_mark') {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    }
    const command = String((request.params?.arguments as Record<string, unknown> | undefined)?.command ?? '');
    const result = await runCli(command);
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
