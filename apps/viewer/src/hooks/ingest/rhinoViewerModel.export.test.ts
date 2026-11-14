/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The spatial tree of ifc-lite's own export, against the IFC it came from:
 * FZK house, this repo's Rust scene builder, `writeRhino3dm`, the real reader,
 * then the adapter — and the same IFC through `IfcParser`. The storeys, their
 * elevations and which storey each element sits on have to agree, because
 * that is what makes the storey filter and the storey-based section work on a
 * re-imported model (decision D3, docs/architecture/rhino-3dm-import.md).
 *
 * Skips when the fixtures (`pnpm fixtures`) or the Rhino wasm payload
 * (`scripts/build-wasm.sh`) are absent; CI has both.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IfcTypeEnum, type SpatialNode } from '@ifc-lite/data';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { readRhino3dm, writeRhino3dm } from '@ifc-lite/rhino3dm';

import { swapRhinoImportAxes } from '@/lib/import/rhino-import-job';
import { calculateStoreyHeights } from '@/utils/localParsingUtils';
import { rhinoViewerModel } from './rhinoViewerModel.js';

const FIXTURE = fileURLToPath(new URL('../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url));
const RHINO_WASM = fileURLToPath(new URL('../../../../../packages/wasm/pkg-rhino/ifc-lite-rhino_bg.wasm', import.meta.url));
const missing = !existsSync(RHINO_WASM) ? 'the Rhino wasm payload is not built (scripts/build-wasm.sh)'
  : !existsSync(FIXTURE) ? 'the FZK fixture is absent (pnpm fixtures)' : null;

/** The `.3dm` this repo's exporter writes for an IFC, as the CLI writes it. */
async function exportedTo3dm(ifc: Uint8Array): Promise<Uint8Array> {
  const engine = await import('@ifc-lite/wasm/rhino');
  engine.initSync({ module: readFileSync(RHINO_WASM) });
  const scene = engine.exportRhinoScene(ifc, JSON.stringify({}));
  try {
    return (await writeRhino3dm({ manifest: scene.manifest, blob: scene.blob })).bytes;
  } finally { scene.free(); }
}

/** Every storey in a hierarchy, by the name its entity carries. */
function storeysByName(store: IfcDataStore): Map<string, SpatialNode> {
  const storeys = new Map<string, SpatialNode>();
  const pending = [store.spatialHierarchy!.project];
  while (pending.length > 0) {
    const node = pending.pop() as SpatialNode;
    if (node.type === IfcTypeEnum.IfcBuildingStorey) storeys.set(node.name, node);
    for (const child of node.children) pending.push(child);
  }
  return storeys;
}

describe(`the .3dm of an ifc-lite export, against its IFC${missing ? ` (skipped: ${missing})` : ''}`, { skip: missing ?? false, timeout: 120_000 }, () => {
  beforeEach(() => mock.method(console, 'warn', () => undefined));
  afterEach(() => mock.restoreAll());

  it('comes back with the IFC\'s project, site, building and storeys, and the same elements on each storey', async () => {
    const ifc = new Uint8Array(readFileSync(FIXTURE));
    const bytes = await exportedTo3dm(ifc);
    const read = await readRhino3dm(bytes, { bakeInstances: true });
    swapRhinoImportAxes(read);
    const { dataStore } = rhinoViewerModel(read, bytes.buffer.slice(0) as ArrayBuffer, 1, 'AC20-FZK-Haus.3dm');
    const source = await new IfcParser().parseColumnar(
      ifc.buffer.slice(ifc.byteOffset, ifc.byteOffset + ifc.byteLength) as ArrayBuffer,
      { disableWorkerScan: true },
    );

    const imported = dataStore.spatialHierarchy;
    assert.ok(imported, 'the import carries a spatial hierarchy');
    // The stamps carry the source IFC's identity, so the containers are the
    // same entities, not look-alikes with new ids.
    assert.equal(dataStore.entities.getGlobalId(imported.project.expressId),
      source.entities.getGlobalId(source.spatialHierarchy!.project.expressId));
    const site = imported.project.children;
    assert.equal(site.length, 1);
    assert.equal(dataStore.entities.getTypeName(site[0].expressId), 'IfcSite');
    const building = site[0].children;
    assert.equal(building.length, 1);
    assert.equal(dataStore.entities.getTypeName(building[0].expressId), 'IfcBuilding');

    // Same storeys, by name and by elevation, and `storeyElevations` carries
    // them so `getStoreyByElevation` answers.
    const sourceStoreys = storeysByName(source);
    const importedStoreys = storeysByName(dataStore);
    assert.deepEqual([...importedStoreys.keys()].sort(), [...sourceStoreys.keys()].sort());
    assert.ok(importedStoreys.size >= 2, `FZK has more than one storey, found ${importedStoreys.size}`);
    for (const [name, node] of importedStoreys) {
      const expected = sourceStoreys.get(name)!.elevation;
      assert.equal(node.elevation, expected, `${name} elevation`);
      assert.equal(imported.storeyElevations.get(node.expressId), expected, `${name} in storeyElevations`);
      assert.equal(imported.getStoreyByElevation(expected!), node.expressId, `${name} by elevation`);
    }
    // Floor-to-floor heights follow from the elevations, as on the IFC path.
    // The IFC's own hierarchy carries none here: the parser leaves them to the
    // loader, which fills them from the same elevations (useIfcLoader.ts).
    assert.deepEqual(
      [...importedStoreys].flatMap(([name, node]) => {
        const height = imported.storeyHeights.get(node.expressId);
        return height === undefined ? [] : [[name, height] as const];
      }),
      [...calculateStoreyHeights(new Map([...sourceStoreys].map(([, node]) => [node.expressId, node.elevation!])))]
        .map(([expressId, height]) => [source.entities.getName(expressId), height] as const),
    );

    // Every imported element sits on the storey its GlobalId sits on in the
    // IFC. The export draws 90 of the model's elements, so this is a subset of
    // the IFC's membership, and it has to be a complete one: an element whose
    // storey the import cannot answer would be missing from the storey filter.
    const storeyNameOf = (store: IfcDataStore, expressId: number): string | undefined => {
      const storeyId = store.spatialHierarchy!.elementToStorey.get(expressId);
      return storeyId === undefined ? undefined : store.entities.getName(storeyId);
    };
    const sourceByGlobalId = new Map<string, number>();
    for (const expressId of source.entities.expressId) {
      if (expressId) sourceByGlobalId.set(source.entities.getGlobalId(expressId), expressId);
    }
    let compared = 0;
    for (const expressId of dataStore.entities.expressId) {
      const globalId = dataStore.entities.getGlobalId(expressId);
      const sourceId = sourceByGlobalId.get(globalId);
      // Containers are compared above; only the drawn objects run here.
      if (sourceId === undefined || expressId > read.entities.length) continue;
      const expected = storeyNameOf(source, sourceId);
      if (expected === undefined) continue;  // the IFC places it on no storey either
      assert.equal(storeyNameOf(dataStore, expressId), expected, `storey of ${globalId}`);
      compared += 1;
    }
    assert.ok(compared >= 80, `most of the 90 exported elements carry a storey, compared ${compared}`);
  });
});
