/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A response the stdio transport cannot serialize must still answer its
 * request (#9523 review of PR #9905): it was logged and dropped, so the client
 * waited forever. Any server is affected, not only `--bridge`.
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MCPServer } from '../server.js';
import { ToolRegistry } from '../tools/types.js';
import { ResourceRegistry } from '../resources/types.js';
import { PromptRegistry } from '../prompts/types.js';
import { StdioTransport } from './stdio.js';

describe('StdioTransport serialization failures', () => {
  it('answers the request with a JSON-RPC error and keeps stdout pure', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'unserializable',
      description: 'returns a BigInt, which JSON.stringify rejects',
      inputSchema: { type: 'object' },
      handler: () => ({ content: [], structuredContent: { n: 1n } }),
    });
    const server = new MCPServer({ version: '0', tools, resources: new ResourceRegistry(), prompts: new PromptRegistry() });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
    stderr.setEncoding('utf8').on('data', (c: string) => { err += c; });
    const transport = new StdioTransport({ stdin, stdout, stderr });
    await transport.connect(server);
    const send = (m: object) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ id: 2, method: 'tools/call', params: { name: 'unserializable', arguments: {} } });
    await expect.poll(() => out.split('\n').filter(Boolean).length).toBe(2);
    const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; error?: { code: number; message: string } });
    expect(lines[1]).toMatchObject({ id: 2, error: { code: -32603, message: expect.stringContaining('could not be serialized') } });
    expect(err).toContain('failed to serialize');
    transport.close();
  });
});
