import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getMcpToolInputSchema } from '../src/help.ts';
import { createMcpServer, startMcpServer } from '../src/mcp.ts';
import { buildNodeLaunchCommand } from '../src/runtime.ts';

async function createConnectedPair(server = createMcpServer()): Promise<{ client: Client; server: ReturnType<typeof createMcpServer> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'git-mark-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test('MCP startup initializes cleanly on the SDK transport path', async () => {
  let bootstrapCount = 0;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'git-mark-test-client', version: '1.0.0' });
  const server = await startMcpServer(serverTransport, {
    loadBootstrapFiles: async () => {
      bootstrapCount += 1;
    },
    buildToolDescription: async () => 'stub description',
    runMcpAction: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });

  try {
    await client.connect(clientTransport);

    assert.equal(bootstrapCount, 1);
    assert.deepEqual(client.getServerCapabilities(), { tools: {} });
    assert.equal(client.getServerVersion()?.name, 'git-mark');
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test('tools/list returns exactly one git_mark tool', async () => {
  const description = 'dynamic tool description';
  const { client, server } = await createConnectedPair(
    createMcpServer({
      buildToolDescription: async () => description,
      runMcpAction: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
  );

  try {
    const result = await client.listTools();

    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0]?.name, 'git_mark');
    assert.equal(result.tools[0]?.description, description);
    assert.deepEqual(result.tools[0]?.inputSchema, getMcpToolInputSchema());
    assert.equal(result.tools[0]?.inputSchema?.type, 'object');
    assert.equal('oneOf' in (result.tools[0]?.inputSchema ?? {}), false);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test('tools/call accepts structured action payload and surfaces CLI failures as tool errors', async () => {
  const calls: unknown[] = [];
  const results = [
    { stdout: 'search output', stderr: '', exitCode: 0 },
    { stdout: '', stderr: 'load failed', exitCode: 2 },
  ];
  const { client, server } = await createConnectedPair(
    createMcpServer({
      buildToolDescription: async () => 'dynamic tool description',
      runMcpAction: async (call) => {
        calls.push(call);
        const next = results.shift();
        assert.ok(next);
        return next;
      },
    }),
  );

  try {
    const searchResult = await client.callTool({
      name: 'git_mark',
      arguments: { action: 'search', query: 'design', limit: 3, offset: 1 },
    });
    const loadResult = await client.callTool({
      name: 'git_mark',
      arguments: { action: 'load', id: 'design' },
    });

    assert.deepEqual(calls, [
      { action: 'search', query: 'design', limit: 3, offset: 1 },
      { action: 'load', id: 'design' },
    ]);
    assert.equal(searchResult.isError, false);
    assert.deepEqual(searchResult.content, [{ type: 'text', text: 'search output' }]);
    assert.equal(loadResult.isError, true);
    assert.deepEqual(loadResult.content, [{ type: 'text', text: 'load failed' }]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test('TypeScript CLI delegation uses tsx runtime instead of experimental strip types', () => {
  const launch = buildNodeLaunchCommand('C:/repo/src/cli.ts', ['search', 'design']);

  assert.equal(launch.command, process.execPath);
  assert.ok(launch.args[0]?.includes('tsx'));
  assert.equal(launch.args[1], 'C:/repo/src/cli.ts');
  assert.deepEqual(launch.args.slice(2), ['search', 'design']);
  assert.equal(launch.args.includes('--experimental-strip-types'), false);
});
