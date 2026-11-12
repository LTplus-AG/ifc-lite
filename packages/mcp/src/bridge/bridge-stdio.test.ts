/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--bridge` end to end through real newline-delimited stdio framing (#9523):
 * an MCP client on one side, a fake tab on the other. The first case runs the
 * bridge in-process over `StdioTransport`; the second spawns the built
 * `ifc-lite-mcp --bridge` binary and also checks that stdout stays pure
 * JSON-RPC while the bridge logs its pairing link to stderr.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { StdioTransport } from '../transport/stdio.js';
import { startBridgeServer, type RunningBridge } from './run.js';
import { BRIDGE_STATUS_TOOL, parsePairingFragment } from './protocol.js';
import { MUTATING_TOOL, READ_TOOL, pairTab, type FakeTab } from '../test/bridge-fake-tab.js';

type Line = { id?: number; method?: string; result?: Record<string, unknown>; error?: unknown };

/** A line-reading JSON-RPC client over a pair of streams. */
function stdioClient(write: (line: string) => void) {
  let buffer = '';
  const lines: Line[] = [];
  const raw: string[] = [];
  return {
    lines,
    raw,
    feed(chunk: string) {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          raw.push(line);
          lines.push(JSON.parse(line) as Line);
        }
        nl = buffer.indexOf('\n');
      }
    },
    send(msg: object) {
      write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    },
    async reply(id: number, timeoutMs = 5000): Promise<Line> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = lines.find((l) => l.id === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no reply to ${id}`);
    },
  };
}

const tabs: FakeTab[] = [];
const bridges: RunningBridge[] = [];
afterEach(async () => {
  for (const t of tabs.splice(0)) t.ws.terminate();
  for (const b of bridges.splice(0)) await b.close();
});

describe('7. happy path through stdio framing', () => {
  it('lists the tab\'s tools, forwards a call and passes the tab\'s result through intact', async () => {
    const r = await startBridgeServer({ version: '0.0.0-test', port: 0, readOnly: false });
    bridges.push(r);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout, stderr: new PassThrough() });
    await transport.connect(r.server);
    const client = stdioClient((line) => stdin.write(line));
    stdout.setEncoding('utf8').on('data', (c: string) => client.feed(c));

    client.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect((await client.reply(1)).result).toMatchObject({ serverInfo: { name: 'ifc-lite-bridge' }, capabilities: { tools: { listChanged: true } } });
    client.send({ method: 'notifications/initialized' });

    const { tab, welcome } = await pairTab({ port: r.bridge.port, code: r.bridge.pairingCode(), permission: 'read-write' });
    tabs.push(tab);
    await expect.poll(() => client.lines.some((l) => l.method === 'notifications/tools/list_changed')).toBe(true);

    client.send({ id: 2, method: 'tools/list' });
    const listed = (await client.reply(2)).result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    expect(listed.tools.map((t) => t.name)).toEqual([BRIDGE_STATUS_TOOL, READ_TOOL.name, MUTATING_TOOL.name]);
    expect(listed.tools[1]).toMatchObject({ description: READ_TOOL.description, inputSchema: READ_TOOL.inputSchema });

    client.send({ id: 3, method: 'tools/call', params: { name: READ_TOOL.name, arguments: { type: 'IfcDoor' } } });
    const call = await tab.next('call');
    expect(call).toMatchObject({ sessionId: welcome.sessionId, name: READ_TOOL.name, arguments: { type: 'IfcDoor' } });
    const tabError = {
      content: [{ type: 'text', text: 'No entity of type IfcDoor' }],
      structuredContent: { code: 'ENTITY_NOT_FOUND', message: 'No entity of type IfcDoor', details: { type: 'IfcDoor' } },
      isError: true,
    };
    tab.reply(welcome.sessionId, call.id, tabError);
    expect((await client.reply(3)).result).toEqual(tabError);

    client.send({ id: 4, method: 'tools/call', params: { name: READ_TOOL.name, arguments: { type: 'IfcWall' } } });
    const second = await tab.next('call');
    const ok = { content: [{ type: 'text', text: '2 walls' }], structuredContent: { count: 2 } };
    tab.reply(welcome.sessionId, second.id, ok);
    expect((await client.reply(4)).result).toEqual(ok);
    transport.close();
  });
});

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const built = existsSync(CLI);
if (!built) console.warn('[mcp] skipping the --bridge binary test: run `pnpm --filter @ifc-lite/mcp build`');

describe.skipIf(!built)('ifc-lite-mcp --bridge binary', () => {
  it('serves a paired tab over stdio, keeps stdout pure JSON-RPC and logs the link on stderr', async () => {
    const child = spawn(process.execPath, [CLI, '--bridge', '--bridge-port', '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise<number | null>((done) => child.once('close', (c) => done(c)));
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    const client = stdioClient((line) => child.stdin.write(line));
    child.stdout.setEncoding('utf8').on('data', (c: string) => client.feed(c));
    try {
      await expect.poll(() => /open (\S+#\S+)/.exec(stderr), { timeout: 15_000 }).not.toBeNull();
      const link = /open (\S+#\S+)/.exec(stderr)![1];
      const fragment = parsePairingFragment(new URL(link).hash);
      expect(fragment).not.toBeNull();

      client.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      await client.reply(1, 15_000);
      const { tab, welcome } = await pairTab({ port: fragment!.port, code: fragment!.code });
      tabs.push(tab);
      client.send({ id: 2, method: 'tools/call', params: { name: READ_TOOL.name, arguments: {} } });
      const call = await tab.next('call');
      tab.reply(welcome.sessionId, call.id, { content: [{ type: 'text', text: 'from the tab' }] });
      expect((await client.reply(2)).result).toEqual({ content: [{ type: 'text', text: 'from the tab' }] });
      // Every stdout line parsed as JSON in `feed`; check each is JSON-RPC 2.0.
      for (const line of client.raw) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
      expect(stderr).toContain('paired with fake-tab');
    } finally {
      child.stdin.end();
    }
    expect(await closed).toBe(0);
  }, 30_000);

  it('refuses --bridge with a model file', async () => {
    const child = spawn(process.execPath, [CLI, '--bridge', 'model.ifc'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    const code = await new Promise<number | null>((done) => child.once('close', (c) => done(c)));
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('loads no files');
  }, 30_000);
});
