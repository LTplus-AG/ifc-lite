/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-mesh contract (#6232 WP1): an element meshed from its own subgraph
 * (`serializeEntitySubgraph`) through `remeshOnApi` — the exact body of
 * `remesh.worker.ts` — must produce the same triangles as meshing the whole
 * file on load, with the load's frame, style wire, material colours and
 * config. Compared per element by an FNV-1a hash of positions + indices, and
 * by colour and local-frame origin (world = origin + position, so the RTC
 * frame lands in the origin rather than in the positions).
 *
 * Runs against the built packages (`dist/`) and the real wasm runtime.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IfcParser } from '../../packages/parser/dist/index.js';
import { serializeEntitySubgraph } from '../../packages/export/dist/index.js';
import {
  applyRemeshConfig,
  filterStyleWire,
  remeshOnApi,
} from '../../packages/geometry/dist/remesh/remesh-core.js';

/** The load path's toggles: engine defaults, as the viewer loads a model. */
const LOAD_CONFIG = { mergeLayers: false, tessellationQuality: null, skipSmallCuts: false, rectParamFastPath: true };

/** FNV-1a over the bytes of every mesh's positions then indices, in order. */
function fnv(meshes) {
  let hash = 0x811c9dc5;
  for (const mesh of meshes) {
    for (const view of [mesh.positions, mesh.indices]) {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
    }
  }
  return hash;
}

/** Colour and origin per mesh; an absent or zero origin reads as [0,0,0]. */
function placementAndColour(meshes) {
  return meshes.map((mesh) => `${Array.from(mesh.color)}@${Array.from(mesh.origin ?? [0, 0, 0])}`).join('|');
}

/** Mesh the whole file once, grouped by express id, in `frame`. */
function loadMeshes(api, bytes, frame) {
  const pre = api.buildPrePassOnce(bytes);
  const wire = {
    styleIds: pre.styleIds,
    styleColors: pre.styleColors,
    materialElementIds: pre.materialElementIds,
    materialColorCounts: pre.materialColorCounts,
    materialColors: pre.materialColors,
  };
  const resolved = frame ?? {
    x: pre.rtcOffset?.[0] ?? 0, y: pre.rtcOffset?.[1] ?? 0, z: pre.rtcOffset?.[2] ?? 0, needsShift: Boolean(pre.needsShift),
  };
  const byId = new Map();
  try {
    const collection = api.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale, resolved.x, resolved.y, resolved.z, resolved.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors, pre.planeAngleToRadians,
      pre.materialElementIds, pre.materialColorCounts, pre.materialColors,
    );
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try {
          const list = byId.get(mesh.expressId) ?? [];
          list.push({ positions: mesh.positions, indices: mesh.indices, color: mesh.color, origin: mesh.origin });
          byId.set(mesh.expressId, list);
        } finally {
          mesh.free();
        }
      }
    } finally {
      collection.free();
    }
  } finally {
    api.clearPrePassCache();
  }
  return { byId, wire, frame: resolved };
}

/** Express ids of every product of `types` (all types when absent) that meshed on load. */
function targetsOf(store, byId, types) {
  if (!types) return [...byId.keys()].sort((a, b) => a - b);
  const out = [];
  for (const [type, ids] of store.entityIndex.byType) {
    if (!types.some((wanted) => type === wanted)) continue;
    for (const id of ids) if (byId.has(id)) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

/** Re-mesh each target from its subgraph; return the ids that differ from load. */
function remeshDiffs(api, store, load, targets) {
  const diffs = [];
  let meshed = 0;
  for (const id of targets) {
    const sub = serializeEntitySubgraph(store, null, { targets: new Set([id]) });
    assert.deepEqual(sub.unreadable, [], `#${id}: unreadable records in its subgraph`);
    const styles = filterStyleWire(load.wire.styleIds, load.wire.styleColors, sub.ids);
    const result = remeshOnApi(api, {
      buffer: sub.bytes,
      targets: Uint32Array.of(id),
      frame: load.frame,
      ...styles,
      materialElementIds: load.wire.materialElementIds,
      materialColorCounts: load.wire.materialColorCounts,
      materialColors: load.wire.materialColors,
    });
    assert.ok(result.meshes.every((mesh) => mesh.expressId === id), `#${id}: a non-target was meshed`);
    const expected = load.byId.get(id);
    if (fnv(result.meshes) !== fnv(expected) || placementAndColour(result.meshes) !== placementAndColour(expected)) diffs.push(id);
    meshed++;
  }
  return { diffs, meshed };
}

const FIXTURES = [
  { path: 'buildingsmart/wall-with-opening-and-window.ifc', types: ['IFCWALL', 'IFCWALLSTANDARDCASE'], min: 1 },
  { path: 'buildingsmart/Building-Architecture.ifc', types: ['IFCWALL', 'IFCWALLSTANDARDCASE'], min: 1 },
  // Multi-layer walls: exercises the material-layer index built from the buffer.
  { path: 'ara3d/duplex.ifc', types: ['IFCWALL', 'IFCWALLSTANDARDCASE'], min: 1 },
  // Real coordinates ~2,780 km from the origin: the pre-pass detects an RTC
  // shift, so every wall is re-meshed in a shifted load frame.
  { path: 'various/rvt01.ifc', types: ['IFCWALL', 'IFCWALLSTANDARDCASE'], min: 1, expectShift: true },
  // Georeferenced (IfcMapConversion); every product, and additionally a
  // forced non-zero shift, since the frame is the one input the subgraph
  // cannot derive for itself.
  {
    path: 'ifc5/Georeferencing_georeferenced-bridge-deck.ifc',
    min: 1,
    forcedFrame: { x: 2_600_000.25, y: 1_200_000.5, z: 410.75, needsShift: true },
  },
];

/** Register the re-mesh contracts. Async: parsing the fixtures is. */
export async function runRemeshContracts({ IfcAPI, FIXTURES_DIR, FIXTURES_HINT, test, skip }) {
  console.log('\n📋 Re-mesh from entity subgraph (#6232)');
  const api = new IfcAPI();
  try {
    applyRemeshConfig(api, LOAD_CONFIG);
    for (const fixture of FIXTURES) {
      const file = join(FIXTURES_DIR, fixture.path);
      if (!existsSync(file)) {
        skip(`re-mesh parity: ${fixture.path}`, `fixture missing — ${FIXTURES_HINT}`);
        continue;
      }
      const bytes = new Uint8Array(readFileSync(file));
      const store = await new IfcParser().parseColumnar(bytes.slice().buffer);
      for (const frame of [undefined, fixture.forcedFrame].filter((f, i) => i === 0 || f)) {
        const label = `${fixture.path}${frame ? ' (forced RTC shift)' : ''}`;
        test(`re-meshing each element from its subgraph matches the load: ${label}`, () => {
          const load = loadMeshes(api, bytes, frame);
          if (fixture.expectShift) assert.ok(load.frame.needsShift, `${fixture.path} no longer loads shifted`);
          const targets = targetsOf(store, load.byId, fixture.types);
          assert.ok(targets.length >= fixture.min, `expected meshed ${fixture.types?.join('/') ?? 'products'} in ${fixture.path}`);
          const { diffs, meshed } = remeshDiffs(api, store, load, targets);
          assert.deepEqual(diffs, [], `${diffs.length}/${meshed} elements differ from the load`);
        });
      }
    }

    const first = join(FIXTURES_DIR, FIXTURES[0].path);
    if (!existsSync(first)) skip('re-mesh with no target job', `fixture missing — ${FIXTURES_HINT}`);
    else test('re-mesh with no target job meshes nothing and releases the pre-pass cache', () => {
      const bytes = new Uint8Array(readFileSync(first));
      const result = remeshOnApi(api, {
        buffer: bytes, targets: Uint32Array.of(0), frame: { x: 0, y: 0, z: 0, needsShift: false },
        styleIds: new Uint32Array(), styleColors: new Uint8Array(),
      });
      assert.equal(result.meshes.length, 0);
      // A fresh pre-pass after the release still meshes the file.
      const again = loadMeshes(api, bytes);
      assert.ok(again.byId.size > 0);
    });
  } finally {
    api.free();
  }
}
