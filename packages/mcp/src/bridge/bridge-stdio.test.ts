/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--bridge` end to end through real newline-delimited stdio framing (#9523):
 * an MCP client on one side, a fake tab on the other. The first case runs the
 * bridge in-process over `StdioTransport`; the rest spawn the built
 * `ifc-lite-mcp --bridge` binary and also check that stdout stays pure
 * JSON-RPC, that no port is bound until `bridge_status`, and that the
 * headless tools are served next to the tab's.
 */

import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { StdioTransport } from '../transport/stdio.js';
import { startBridgeServer, type RunningBridge } from './run.js';
import { BRIDGE_STATUS_TOOL, parsePairingFragment } from './bridge-protocol.js';
import { MUTATING_TOOL, READ_TOOL, pairTab, type FakeTab, tabTool } from '../test/bridge-fake-tab.js';

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
    expect((await client.reply(1)).result).toMatchObject({ serverInfo: { name: 'ifc-lite' }, capabilities: { tools: { listChanged: true } } });
    client.send({ method: 'notifications/initialized' });

    const { tab, welcome } = await pairTab({ port: r.bridge.port, code: r.bridge.pairingCode(), permission: 'read-write' });
    tabs.push(tab);
    await expect.poll(() => client.lines.some((l) => l.method === 'notifications/tools/list_changed')).toBe(true);

    client.send({ id: 2, method: 'tools/list' });
    const listed = (await client.reply(2)).result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    expect(listed.tools.map((t) => t.name)).toEqual([BRIDGE_STATUS_TOOL, tabTool(READ_TOOL.name), tabTool(MUTATING_TOOL.name)]);
    expect(listed.tools[1]).toMatchObject({ description: READ_TOOL.description, inputSchema: READ_TOOL.inputSchema });

    client.send({ id: 3, method: 'tools/call', params: { name: tabTool(READ_TOOL.name), arguments: { type: 'IfcDoor' } } });
    const call = await tab.next('call');
    expect(call).toMatchObject({ sessionId: welcome.sessionId, name: READ_TOOL.name, arguments: { type: 'IfcDoor' } });
    const tabError = {
      content: [{ type: 'text' as const, text: 'No entity of type IfcDoor' }],
      structuredContent: { code: 'ENTITY_NOT_FOUND', message: 'No entity of type IfcDoor', details: { type: 'IfcDoor' } },
      isError: true,
    };
    tab.reply(welcome.sessionId, call.id, tabError);
    expect((await client.reply(3)).result).toEqual(tabError);

    client.send({ id: 4, method: 'tools/call', params: { name: tabTool(READ_TOOL.name), arguments: { type: 'IfcWall' } } });
    const second = await tab.next('call');
    const ok = { content: [{ type: 'text' as const, text: '2 walls' }], structuredContent: { count: 2 } };
    tab.reply(welcome.sessionId, second.id, ok);
    expect((await client.reply(4)).result).toEqual(ok);
    transport.close();
  });
});

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const built = existsSync(CLI);
if (!built) console.warn('[mcp] skipping the --bridge binary test: run `pnpm --filter @ifc-lite/mcp build`');

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJ00000000000000000X',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#70= IFCWALL('WALL00000000000000000X',$,'Wall',$,$,$,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;

/** The built binary with `args`, an MCP client on its stdio, and its stderr so far. */
async function spawnCli(args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<number | null>((done) => child.once('close', (c) => done(c)));
  const out = { stderr: '' };
  child.stderr.setEncoding('utf8').on('data', (d: string) => { out.stderr += d; });
  const client = stdioClient((line) => child.stdin.write(line));
  child.stdout.setEncoding('utf8').on('data', (c: string) => client.feed(c));
  client.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await client.reply(1, 15_000);
  return { child, closed, out, client };
}

/** Call bridge_status the way an agent does; it binds the listener on first use. */
async function status(client: ReturnType<typeof stdioClient>, id: number) {
  client.send({ id, method: 'tools/call', params: { name: BRIDGE_STATUS_TOOL, arguments: {} } });
  return (await client.reply(id, 15_000)).result as { isError?: boolean; structuredContent: Record<string, unknown> };
}

describe.skipIf(!built)('ifc-lite-mcp --bridge binary', () => {
  it('P2: binds no port until bridge_status, then serves the tab next to the headless tools over pure JSON-RPC stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-bridge-'));
    const file = join(dir, 'building.ifc');
    await writeFile(file, MODEL, 'utf-8');
    const { child, closed, out, client } = await spawnCli([file, '--bridge', '--bridge-port', '0']);
    try {
      expect(out.stderr).not.toMatch(/ws:\/\/127\.0\.0\.1:\d+/);
      client.send({ id: 2, method: 'tools/list' });
      const before = ((await client.reply(2)).result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(before).toEqual(expect.arrayContaining(['model_info', 'model_load', 'export_ifc', BRIDGE_STATUS_TOOL]));
      expect(before.some((n) => n.startsWith('tab_'))).toBe(false);

      const unpaired = await status(client, 3);
      const fragment = parsePairingFragment(new URL(unpaired.structuredContent.pairingUrl as string).hash)!;
      expect(fragment.port).toBe(unpaired.structuredContent.port);
      const { tab, welcome } = await pairTab({ port: fragment.port, code: fragment.code });
      tabs.push(tab);
      await expect.poll(() => client.lines.some((l) => l.method === 'notifications/tools/list_changed')).toBe(true);
      client.send({ id: 4, method: 'tools/list' });
      const after = ((await client.reply(4)).result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(after).toEqual([...before, tabTool(READ_TOOL.name)]);

      // The headless tool answers from the file loaded here; the tab_ one from the tab.
      client.send({ id: 5, method: 'tools/call', params: { name: 'count_entities', arguments: { type: 'IfcWall' } } });
      expect(JSON.stringify((await client.reply(5)).result)).toContain('1');
      client.send({ id: 6, method: 'tools/call', params: { name: tabTool(READ_TOOL.name), arguments: {} } });
      const call = await tab.next('call');
      expect(call.name).toBe(READ_TOOL.name);
      tab.reply(welcome.sessionId, call.id, { content: [{ type: 'text', text: 'from the tab' }] });
      expect((await client.reply(6)).result).toEqual({ content: [{ type: 'text', text: 'from the tab' }] });
      // Every stdout line parsed as JSON in `feed`; check each is JSON-RPC 2.0.
      for (const line of client.raw) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
      expect(out.stderr).toContain('paired with fake-tab');
      // The effective allowlist is printed once, when the listener binds.
      expect(out.stderr.match(/allowed origins \(exactly these\): https:\/\/ifclite\.com\n/g)).toHaveLength(1);
    } finally {
      child.stdin.end();
      await rm(dir, { recursive: true, force: true });
    }
    expect(await closed).toBe(0);
  }, 30_000);

  it('answers a pending call on SIGTERM before exiting (bridge closed before the transport)', async () => {
    const { child, closed, client } = await spawnCli(['--bridge', '--bridge-port', '0']);
    const fragment = parsePairingFragment(new URL((await status(client, 2)).structuredContent.pairingUrl as string).hash)!;
    const { tab } = await pairTab({ port: fragment.port, code: fragment.code });
    tabs.push(tab);
    client.send({ id: 3, method: 'tools/call', params: { name: tabTool(READ_TOOL.name), arguments: {} } });
    await tab.next('call');
    child.kill('SIGTERM');
    expect(await closed).toBe(143);
    const answer = client.lines.find((l) => l.id === 3);
    expect(answer?.result).toMatchObject({
      isError: true,
      structuredContent: { code: 'VIEWER_NOT_CONNECTED', details: { reason: 'shutting-down' } },
    });
  }, 30_000);

  it('closes the bridge and frees its port on SIGTERM', async () => {
    const { child, closed, out, client } = await spawnCli(['--bridge', '--bridge-port', '0']);
    const port = (await status(client, 2)).structuredContent.port as number;
    child.kill('SIGTERM');
    expect(await closed).toBe(143);
    expect(out.stderr).toContain('stopping: SIGTERM');
    // The port is free again.
    const probe = createServer();
    await new Promise<void>((ok, fail) => { probe.once('error', fail); probe.listen(port, '127.0.0.1', () => ok()); });
    await new Promise<void>((ok) => probe.close(() => ok()));
  }, 30_000);

  it('P2: an explicit --bridge-port that is taken fails bridge_status, not the server', async () => {
    const holder = createServer();
    await new Promise<void>((ok) => holder.listen(0, '127.0.0.1', () => ok()));
    const port = (holder.address() as AddressInfo).port;
    try {
      const { child, closed, client } = await spawnCli(['--bridge', '--bridge-port', String(port)]);
      const result = await status(client, 2);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain('EADDRINUSE');
      // The headless tools keep working.
      client.send({ id: 3, method: 'tools/call', params: { name: 'model_list', arguments: {} } });
      expect((await client.reply(3)).result).not.toHaveProperty('isError', true);
      child.stdin.end();
      expect(await closed).toBe(0);
    } finally {
      await new Promise<void>((ok) => holder.close(() => ok()));
    }
  }, 30_000);

  it('refuses --bridge with --transport http', async () => {
    const child = spawn(process.execPath, [CLI, '--bridge', '--transport', 'http'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    const code = await new Promise<number | null>((done) => child.once('close', (c) => done(c)));
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('stdio only');
  }, 30_000);
});
