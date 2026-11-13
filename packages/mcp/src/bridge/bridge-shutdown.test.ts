/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite-mcp` must stop whatever its stdout does (#9523, final review of
 * PR #9905): a peer that stopped reading (full pipe) must not make SIGTERM or
 * stdin EOF hang, and a peer that closed stdout (EPIPE) must not crash the
 * process. Runs the built binary; "bounded" means the test's own timeout,
 * well under the 15 s a hang was observed to last.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const built = existsSync(CLI);
if (!built) console.warn('[mcp] skipping the binary shutdown tests: run `pnpm --filter @ifc-lite/mcp build`');

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

function launch(args: string[]): { child: ChildProcessWithoutNullStreams; stderr: () => string; exit: Promise<number | null> } {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  child.stdin.on('error', () => { /* the child may already be gone */ });
  const exit = new Promise<number | null>((done) => child.once('close', (c) => done(c)));
  return { child, stderr: () => stderr, exit };
}

/** Fill the child's stdout without ever reading it: the parent's buffer, then the pipe, then the child's own queue. */
async function fillStdout(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.write(`${JSON.stringify(INIT)}\n`);
  let id = 100;
  const burst = (n: number) => {
    let text = '';
    for (let i = 0; i < n; i++) text += `${JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } })}\n`;
    child.stdin.write(text);
  };
  // The parent buffers stdout up to its high-water mark and then stops reading:
  // from there on the child's writes fill the OS pipe and then its own queue.
  await expect.poll(() => { burst(50); return child.stdout.readableLength >= child.stdout.readableHighWaterMark; }, { timeout: 15_000, interval: 20 }).toBe(true);
  burst(2000);
  await new Promise((r) => setTimeout(r, 500));
}

describe.skipIf(!built)('shutdown with a stdout nobody reads', () => {
  it('exits on SIGTERM with 143 even though stdout cannot be flushed', async () => {
    const { child, stderr, exit } = launch(['--bridge', '--bridge-port', '0']);
    await expect.poll(stderr, { timeout: 15_000 }).toMatch(/ready on stdio/);
    await fillStdout(child);
    child.kill('SIGTERM');
    expect(await exit).toBe(143);
    expect(stderr()).toContain('stopping: SIGTERM');
  }, 30_000);

  it('exits on stdin end with 0 even though stdout cannot be flushed', async () => {
    const { child, stderr, exit } = launch(['--bridge', '--bridge-port', '0']);
    await expect.poll(stderr, { timeout: 15_000 }).toMatch(/ready on stdio/);
    await fillStdout(child);
    child.stdin.end();
    expect(await exit).toBe(0);
    expect(stderr()).toMatch(/stopping: stdin (ended|closed)/);
  }, 30_000);
});

describe.skipIf(!built)('stdout closed by the peer (EPIPE)', () => {
  it.each([
    ['--bridge', ['--bridge', '--bridge-port', '0']],
    ['the plain stdio server', []],
  ])('%s stops cleanly instead of crashing', async (_label, args) => {
    const { child, stderr, exit } = launch(args);
    await expect.poll(stderr, { timeout: 15_000 }).toMatch(/ready on stdio/);
    // Close the read end: the child's next write fails with EPIPE.
    child.stdout.destroy();
    child.stdin.write(`${JSON.stringify(INIT)}\n`);
    expect(await exit).toBe(0);
    expect(stderr()).toMatch(/stdout closed by the peer \(EPIPE\)/);
    expect(stderr()).not.toMatch(/Unhandled|uncaught|fatal/i);
  }, 30_000);
});
