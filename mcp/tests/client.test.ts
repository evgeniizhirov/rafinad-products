import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { env, keys, token } from './helpers';
import { handle } from '../src/index';

test('official MCP client connects over Streamable HTTP in legacy and modern protocol modes', async () => {
  for (const mode of ['legacy', 'auto'] as const) {
    const bearer = await token();
    const client = new Client({ name: 'acceptance-client', version: '1.0.0' }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL(env.MCP_RESOURCE), {
      authProvider: { token: async () => bearer },
      fetch: async (input, init) => handle(new Request(input, init), env, {
        keys, fetcher: async () => Response.json({ user: { id: 'fixture-user' } }),
      }),
    });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 14);
      const result = await client.callTool({ name: 'get_my_profile', arguments: {} });
      assert.deepEqual(result.structuredContent, { data: {
        user: { id: 'fixture-user' },
        mcp_access: { writes_enabled: true, token_has_write_scope: true, can_write: true },
      } });
    } finally { await client.close(); }
  }
});
