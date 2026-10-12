/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

function object(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input));
  return input as Record<string, unknown>;
}

for (const provider of ['openai', 'anthropic'] as const) {
  for (const scenario of ['abort', 'deadline', 'reject'] as const) {
    test(`#7450 ${provider} ${scenario} settles before the genuine client import is released`, { timeout: 20_000 }, async () => {
      let received = 0;
      const peer = createServer((_request, response) => {
        received++;
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":{"message":"unexpected provider request"}}');
      });
      await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
      const address = peer.address();
      assert.ok(address && typeof address !== 'string');
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, [
        '--import', fileURLToPath(new URL('../../test/assistant-direct-load-hook.mjs', import.meta.url)),
        '--import', fileURLToPath(new URL('../../test/vite-module-hooks.mjs', import.meta.url)),
        fileURLToPath(new URL('../../test/assistant-direct-load-probe.ts', import.meta.url)),
        provider, scenario, `http://127.0.0.1:${address.port}`,
      ], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let diagnostics = '';
      child.stdout?.on('data', bytes => { diagnostics += String(bytes); });
      child.stderr?.on('data', bytes => { diagnostics += String(bytes); });
      child.once('error', error => { diagnostics += `Spawn error: ${error.message}`; });
      const messages: Record<string, unknown>[] = [];
      const listeners = new Set<() => void>();
      child.on('message', value => {
        const message = object(value);
        messages.push(message);
        if (message.kind === 'diagnostic') diagnostics += `Stage: ${String(message.stage)}\n`;
        for (const listener of listeners) listener();
      });
      let exited = false;
      const exit = new Promise<void>(resolve => child.once('close', (code, signal) => {
        diagnostics += `Host closed: code=${code}, signal=${signal}`;
        exited = true; for (const listener of listeners) listener(); resolve();
      }));
      const wait = (kind: string, milliseconds: number): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
        const inspect = () => {
          const message = messages.find(value => value.kind === kind);
          if (!message && !exited) return;
          clearTimeout(timer); listeners.delete(inspect);
          if (message) resolve(message);
          else reject(new Error(`Isolated ${provider} host exited before ${kind}: ${diagnostics}`));
        };
        const timer = setTimeout(() => {
          listeners.delete(inspect);
          console.error(`#7450 ${provider}/${scenario} stalled at ${kind}:\n${diagnostics}`);
          reject(new assert.AssertionError({ message: `#7450 request did not reach ${kind} before held client load release: ${diagnostics}` }));
        }, milliseconds);
        listeners.add(inspect); inspect();
      });
      try {
        await wait('held', 10_000);
        assert.equal(messages.some(message => message.kind === 'evaluated'), false);
        child.send(scenario === 'reject' ? 'reject' : scenario);
        const settled = await wait('outcome', 2_000);
        const outcome = object(settled.outcome);
        assert.equal(outcome.kind, scenario === 'abort' ? 'cancelled' : scenario === 'deadline' ? 'timeout' : 'error');
        if (scenario === 'reject') {
          assert.equal(outcome.code, 'request-failed');
          assert.match(String(outcome.message), /controlled direct-client chunk refusal/);
        }
        assert.ok(Array.isArray(settled.receipts));
        const receipts: readonly unknown[] = settled.receipts;
        assert.equal(receipts.length, 1, 'one terminal receipt, even without a provider dispatch');
        const receipt = object(receipts[0]);
        assert.equal(receipt.outcome, outcome.kind);
        assert.equal(receipt.route, provider);
        assert.equal(receipt.usageReported, false, 'no fabricated provider usage');
        assert.equal('inputTokens' in receipt, false);
        assert.equal('outputTokens' in receipt, false);
        assert.equal(settled.inFlight, 0);
        assert.equal(messages.filter(message => message.kind === 'fetch').length, 0, 'no provider or proxy attempt');
        assert.equal(received, 0, 'independent HTTP receiver saw no effect');
        assert.equal(messages.some(message => message.kind === 'evaluated'), false,
          'the outcome arrived before genuine client evaluation');
        if (scenario !== 'reject') {
          child.send('release');
          await wait('evaluated', 5_000);
          child.send('drain');
          await wait('drained', 1_000);
          assert.equal(messages.filter(message => message.kind === 'fetch').length, 0, 'late module completion does not dispatch');
          assert.equal(received, 0);
        }
      } finally {
        if (child.connected) { child.send('release'); child.send('finish'); }
        const grace = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1_000);
        await exit;
        clearTimeout(grace);
        peer.closeAllConnections();
        await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()));
      }
    });
  }
}
