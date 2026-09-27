#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-mesh latency for walls that host openings (#6232 WP1), in node against
 * the real wasm runtime and the built packages: walk + serialize
 * (`serializeEntitySubgraph`), then pre-pass + produce (`remeshOnApi`, the
 * worker's body). Excludes postMessage and the viewer's store/drain/rebuild,
 * which the browser measurement covers.
 *
 *   node scripts/perf/remesh-latency.mjs [fixture.ifc] [--iters N]
 *
 * Default fixture: tests/models/ara3d/AC20-FZK-Haus.ifc (`pnpm fixtures`).
 * Needs `pnpm build` and a built wasm runtime.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSync, IfcAPI } from '../../packages/wasm/pkg/ifc-lite.js';
import { IfcParser } from '../../packages/parser/dist/index.js';
import { RelationshipType } from '../../packages/data/dist/index.js';
import { serializeEntitySubgraph } from '../../packages/export/dist/index.js';
import { applyRemeshConfig, filterStyleWire, remeshOnApi } from '../../packages/geometry/dist/remesh/remesh-core.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const itersAt = args.indexOf('--iters');
const iters = itersAt >= 0 ? Number(args[itersAt + 1]) : 20;
const file = args.find((a, i) => !a.startsWith('--') && i !== itersAt + 1)
  ?? join(ROOT, 'tests/models/ara3d/AC20-FZK-Haus.ifc');
if (!existsSync(file)) {
  console.log(`fixture missing: ${file} — run \`pnpm fixtures\``);
  process.exit(0);
}

initSync({ module: readFileSync(join(ROOT, 'packages/wasm/pkg/ifc-lite_bg.wasm')) });
const api = new IfcAPI();
applyRemeshConfig(api, { mergeLayers: false, tessellationQuality: null, skipSmallCuts: false, rectParamFastPath: true });

const bytes = new Uint8Array(readFileSync(file));
const pre = api.buildPrePassOnce(bytes);
api.clearPrePassCache();
const frame = { x: pre.rtcOffset?.[0] ?? 0, y: pre.rtcOffset?.[1] ?? 0, z: pre.rtcOffset?.[2] ?? 0, needsShift: Boolean(pre.needsShift) };
const store = await new IfcParser().parseColumnar(bytes.slice().buffer);

const hosts = [];
for (const [type, ids] of store.entityIndex.byType) {
  if (!type.startsWith('IFCWALL')) continue;
  for (const id of ids) {
    const openings = store.relationships.getRelated(id, RelationshipType.VoidsElement, 'forward').length;
    if (openings > 0) hosts.push({ id, openings });
  }
}

const samples = { walk: [], prepass: [], produce: [], total: [] };
let triangles = 0;
for (let i = 0; i < iters; i++) {
  for (const { id } of hosts) {
    const t0 = performance.now();
    const sub = serializeEntitySubgraph(store, null, { targets: new Set([id]) });
    const styles = filterStyleWire(pre.styleIds, pre.styleColors, sub.ids);
    const t1 = performance.now();
    const result = remeshOnApi(api, {
      buffer: sub.bytes, targets: Uint32Array.of(id), frame, ...styles,
      materialElementIds: pre.materialElementIds, materialColorCounts: pre.materialColorCounts, materialColors: pre.materialColors,
    });
    const t2 = performance.now();
    if (i === 0) triangles += result.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
    samples.walk.push(t1 - t0);
    samples.prepass.push(result.ms.prepass);
    samples.produce.push(result.ms.produce);
    samples.total.push(t2 - t0);
  }
}

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const openings = hosts.map((h) => h.openings);
console.log(JSON.stringify({
  fixture: file.split('/').pop(),
  hosts: hosts.length,
  openingsPerHost: { min: Math.min(...openings), max: Math.max(...openings) },
  iterations: iters,
  samples: samples.total.length,
  trianglesPerPass: triangles,
  ms: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, { p50: +pct(v, 50).toFixed(2), p95: +pct(v, 95).toFixed(2) }])),
}, null, 2));
api.free();
