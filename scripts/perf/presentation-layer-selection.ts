/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Run only through exclusive fleet benchmark admission, after dependency builds. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { PresentationLayer } from '../../apps/viewer/src/lib/presentation-layers';
import { presentationLayersByProduct } from '../../apps/viewer/src/lib/presentation-layer-selection';
import { generatedLayerModel } from '../../apps/viewer/src/test/fixtures/presentation-layer-model';

const base = process.argv[2];
assert.ok(base, 'pass the reviewed base commit');
const cpu = () => readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
const startCpu = cpu();
await new Promise(resolve => setTimeout(resolve, 1_000));
const endCpu = cpu();
const deltas = endCpu.map((value, i) => value - startCpu[i]);
const idleFraction = (deltas[3] + deltas[4]) / deltas.reduce((sum, value) => sum + value, 0);
console.log('host qualification', JSON.stringify({ idleFraction, load: readFileSync('/proc/loadavg', 'utf8').trim(),
  cpuPressure: readFileSync('/proc/pressure/cpu', 'utf8').trim() }));
assert.ok(idleFraction >= 0.9, 'exclusive benchmark requires an actually idle host (>=90% idle CPU)');
console.log(execFileSync('ps', ['-eo', 'pid,ppid,pcpu,rss,args', '--sort=-pcpu'], { encoding: 'utf8' }).split('\n').slice(0, 14).join('\n'));

const baselinePath = resolve('apps/viewer/src/lib/.presentation-layer-selection-before.ts');
writeFileSync(baselinePath, execFileSync('git', ['show', `${base}:apps/viewer/src/lib/presentation-layers.ts`]));
try {
  const before = await import(pathToFileURL(baselinePath).href) as typeof import('../../apps/viewer/src/lib/presentation-layers');
  const sources = [false, true].map(withLayer => new TextEncoder().encode(generatedLayerModel(20_000, withLayer)));
  const rows: Array<{ round: number; side: string; withLayer: boolean; edited: boolean; milliseconds: number }> = [];
  for (let round = 0; round < 5; round++) {
    for (const withLayer of [false, true]) {
      // Balanced, interleaved A/B with fresh stores/views on each side.
      for (const side of round % 2 ? ['after', 'before'] : ['before', 'after']) {
        global.gc?.();
        const store = await new IfcParser().parseColumnar(sources[Number(withLayer)].buffer, { disableWorkerScan: true });
        const view = new MutablePropertyView(null, 'benchmark');
        for (const edited of [false, true]) {
          if (edited) view.setProperty(1, 'Pset_Test', 'Unrelated', 'changed');
          const start = performance.now();
          // Reproduce the original selection path using the base's actual API:
          // fully resolve every layer, then invert layer -> products for selection.
          let layers: readonly PresentationLayer[];
          if (side === 'before') {
            const index = new Map<number, PresentationLayer[]>();
            for (const layer of before.resolvePresentationLayers(store, view)) {
              for (const id of layer.productIds) {
                const memberships = index.get(id) ?? [];
                memberships.push(layer);
                index.set(id, memberships);
              }
            }
            layers = index.get(1) ?? [];
          } else {
            layers = presentationLayersByProduct(store, view).get(1) ?? [];
          }
          const milliseconds = performance.now() - start;
          assert.deepEqual(layers.map(layer => [layer.expressId, layer.Name, layer.Identifier]),
            withLayer ? [[620001, 'BREP layer', 'L-1']] : []);
          const row = { round, side, withLayer, edited, milliseconds };
          rows.push(row);
          console.log('selection sample', JSON.stringify(row));
        }
      }
    }
  }
  console.log('selection A/B result', JSON.stringify({ base,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), walls: 20_000,
    entities: [620_000, 620_001], sourceBytes: sources.map(source => source.byteLength),
    outputIdentity: 'selected layer expressId, Name and Identifier identical in every paired sample', rows }));
} finally {
  unlinkSync(baselinePath);
}
