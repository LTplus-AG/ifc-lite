/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Exclusive benchmark admission required. Pass BASE_COMMIT MODEL.ifc [...].
 * Parses once per model, compares complete layer metadata/member sets, then
 * measures five alternating cold-index pairs. No geometry or UI is mocked. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { resolvePresentationLayers, type PresentationLayer } from '../../apps/viewer/src/lib/presentation-layers';

const [base, ...models] = process.argv.slice(2);
assert.ok(base && models.length, 'usage: BASE_COMMIT MODEL.ifc [...]');
const cpu = () => readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
const start = cpu();
await new Promise(resolve => setTimeout(resolve, 1_000));
const deltas = cpu().map((n, i) => n - start[i]);
const idle = (deltas[3] + deltas[4]) / deltas.reduce((sum, n) => sum + n, 0);
console.log('host', JSON.stringify({ idle, load: readFileSync('/proc/loadavg', 'utf8').trim() }));
assert.ok(idle >= 0.9, 'measurement requires >=90% idle CPU');
const path = resolve('apps/viewer/src/lib/.presentation-layers-before-9928.ts');
writeFileSync(path, execFileSync('git', ['show', `${base}:apps/viewer/src/lib/presentation-layers.ts`]));
const canonical = (layers: readonly PresentationLayer[]) => layers.map(layer => ({
  ...layer, productIds: [...layer.productIds].sort((a, b) => a - b),
})).sort((a, b) => a.expressId - b.expressId);
try {
  const before = await import(pathToFileURL(path).href) as typeof import('../../apps/viewer/src/lib/presentation-layers');
  for (const model of models) {
    const bytes = readFileSync(model);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
    let decoded = 0;
    let attributes = 0;
    const getEntity = store.getEntity;
    store.getEntity = id => { decoded++; return getEntity(id); };
    const extractAttribute = EntityExtractor.prototype.extractAttribute;
    EntityExtractor.prototype.extractAttribute = function(ref, index) {
      attributes++;
      return extractAttribute.call(this, ref, index);
    };
    try {
      const expected = canonical(before.resolvePresentationLayers({ ...store }));
      assert.deepEqual(canonical(resolvePresentationLayers({ ...store })), expected, model);
      console.log('exactness', JSON.stringify({ model, layers: expected.length, memberships: expected.reduce((n, layer) => n + layer.productIds.length, 0) }));
      const samples = [];
      for (let round = 0; round < 5; round++) {
        for (const side of round % 2 ? ['after', 'before'] : ['before', 'after']) {
          decoded = attributes = 0;
          const fresh = { ...store };
          const start = performance.now();
          const layers = (side === 'before' ? before.resolvePresentationLayers : resolvePresentationLayers)(fresh);
          const ms = performance.now() - start;
          assert.deepEqual(canonical(layers), expected, `${model} ${side} ${round}`);
          samples.push({ round, side, ms, decoded, attributes });
        }
      }
      console.log('samples', JSON.stringify({ model, base, samples }));
    } finally {
      EntityExtractor.prototype.extractAttribute = extractAttribute;
    }
  }
} finally {
  unlinkSync(path);
}
