/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Over stdio, stdout carries JSON-RPC and nothing else. The geometry engine
 * (wasm) logs through `console.log` ("[IFC-LITE] Opening classifier: ...");
 * a client that parses stdout strictly breaks on that line (#8202). This
 * drives the built server process through initialize, tools/list and a
 * `clash_check` (which meshes the model), then checks every stdout line is a
 * JSON-RPC message and the engine's text arrived on stderr instead.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURE = fileURLToPath(new URL('../../../../rust/geometry/tests/fixtures/issue_098_wall_W.ifc', import.meta.url));
const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const WASM = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const missing = !existsSync(FIXTURE)
  ? 'issue_098_wall_W.ifc not found'
  : !existsSync(CLI)
    ? 'the server is not built: run `pnpm --filter @ifc-lite/mcp build`'
    : !existsSync(WASM)
      ? 'wasm bundle not built: run `pnpm build:wasm:fetch`'
      : null;
if (missing) console.warn(`[mcp] skipping the stdio stdout purity test: ${missing}`);

type Reply = { id?: number; result?: { isError?: boolean } };

/** Run the server process through the calls; resolve with everything it wrote. */
async function drive(): Promise<{ stdout: string; stderr: string; replies: Reply[] }> {
  const child = spawn(process.execPath, [CLI, FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  const replies = (): Reply[] => stdout.split('\n').flatMap((l) => {
    try { return [JSON.parse(l) as Reply]; } catch { return []; }
  });
  const reply = async (id: number): Promise<Reply> => {
    for (let i = 0; i < 1200; i++) {
      const r = replies().find((x) => x.id === id);
      if (r) return r;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error(`no reply to ${id}\nstderr: ${stderr.slice(-500)}`);
  };
  const send = (msg: object): void => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); };
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'purity-test', version: '1' } } });
    await reply(1);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    await reply(2);
    send({ id: 3, method: 'tools/call', params: { name: 'clash_check', arguments: {} } });
    const clash = await reply(3);
    expect(clash.result?.isError, JSON.stringify(clash)).toBeFalsy();
  } finally {
    child.stdin.end();
    child.kill();
  }
  return { stdout, stderr, replies: replies() };
}

describe.skipIf(missing)('stdio stdout carries only JSON-RPC', () => {
  it('writes every engine log line to stderr, none to stdout', async () => {
    const { stdout, stderr, replies } = await drive();
    const stray = stdout.split('\n').filter((l) => l !== '').filter((l) => {
      try { return (JSON.parse(l) as { jsonrpc?: string }).jsonrpc !== '2.0'; } catch { return true; }
    });
    expect(stray).toEqual([]);
    expect(replies.map((r) => r.id)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(stderr).toContain('[IFC-LITE] Opening classifier');
  }, 120_000);
});
