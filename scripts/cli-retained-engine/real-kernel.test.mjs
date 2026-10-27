// SPDX-License-Identifier: MPL-2.0
// Real SDK qualification belongs ONLY to geometry-platform's non-required
// cli-retained lane. Ordinary PR tests use inert peers in scripts/ instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = process.env.IFCLITE_RETAINED_ENGINE;
const available = directory && existsSync(directory);
test('staged Node workers run the shared real-kernel contracts (#7955)', {
  timeout: 120000,
  skip: !available && 'SKIP: retained engine directory absent; stage an SDK build and set IFCLITE_RETAINED_ENGINE (geometry-platform cli-retained lane)',
}, async t => {
  const engine = resolve(directory);
  const manifest = JSON.parse(await readFile(join(engine, 'engine-manifest.json'), 'utf8'));
  for (const asset of manifest.assets) {
    const bytes = await readFile(join(engine, asset.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.path);
  }
  const base = pathToFileURL(`${engine}/`);
  const { SmlibWorkerTransport } = await import(new URL('smlib/node/client.mjs', base));
  const { runContract } = await import(new URL('smlib/contract.mjs', base));
  const { runSweepContract } = await import(new URL('smlib/sweep-contract.mjs', base));
  const transports = [new SmlibWorkerTransport(), new SmlibWorkerTransport()];
  t.after(() => { for (const transport of transports) transport.dispose(); });
  const reports = [];
  for (const transport of transports) {
    const token = transport.incarnation;
    reports.push({ primitive: await runContract(frames => transport.batch(frames, token)),
      sweeps: await runSweepContract(transport, token) });
    assert.ok(transport.peakHeapBytes > 0);
  }
  assert.deepEqual(reports[0], reports[1], 'independent kernels agree through the Node host');
  const transport = transports[0], previous = transport.incarnation;
  const replacement = transport.restart();
  transport.retire(previous);
  assert.equal(transport.incarnation, replacement);
  assert.deepEqual(await runContract(frames => transport.batch(frames, replacement)), reports[0].primitive);
  t.diagnostic(JSON.stringify({ reports, peakHeapBytes: transports.map(transport => transport.peakHeapBytes) }));
});
