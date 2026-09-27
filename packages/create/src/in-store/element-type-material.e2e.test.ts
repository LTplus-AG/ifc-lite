/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End to end for the type and material builders (#6232 M3): author a wall, a
 * wall type carrying a two-layer IfcMaterialLayerSet, and an
 * IfcMaterialLayerSetUsage on the wall, all through the mutation overlay of
 * the Bonsai hello-wall sample. Then export with `StepExporter`, re-parse, and
 * mesh through the real wasm pipeline. The parser must read the layers back
 * off the wall, and the geometry engine must slice the wall into its two
 * material layers (`geometryClass` 3, `GEOM_CLASS_LAYER_SLICE`); without the
 * usage the wall is one plain body.
 *
 * The wasm half skips (never fails) when `packages/wasm/pkg/ifc-lite_bg.wasm`
 * is not built on this host — see `pnpm build:wasm:fetch`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser, extractMaterialsOnDemand, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore } from './wall.js';
import { addElementTypeToStore, assignTypeInStore } from './element-type.js';
import {
  addMaterialLayerSetToStore,
  addMaterialLayerSetUsageToStore,
  addMaterialToStore,
  assignMaterialInStore,
} from './material.js';
import { readRelatedLists, resolveAuthoringAnchor } from './resolve-relations.js';

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const SAMPLE = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const LAYER_SLICE = 3;

async function parse(bytes: Uint8Array) {
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

/** Author a 5 m × 0.3 m wall; with `layered`, type it and give it a layer set usage. */
async function exportWall(layered: boolean): Promise<{ text: string; wallId: number }> {
  const store = await parse(readFileSync(SAMPLE));
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const { wallId } = addWallToStore(editor, resolveSpatialAnchor(store, 42, view), {
    Start: [0, 3, 0], End: [5, 3, 0], Thickness: 0.3, Height: 3, Name: 'Layered wall',
  });
  if (layered) {
    const anchor = resolveAuthoringAnchor(store, view);
    const { typeId } = addElementTypeToStore(editor, anchor, { Type: 'IfcWallType', Name: 'EW-300', PredefinedType: 'SOLIDWALL' });
    assignTypeInStore(editor, anchor, typeId, [wallId], readRelatedLists(store, 'IfcRelDefinesByType', view));
    const concrete = addMaterialToStore(editor, anchor, { Name: 'Concrete', Category: 'concrete' }).materialId;
    const wool = addMaterialToStore(editor, anchor, { Name: 'Mineral wool', Category: 'insulation' }).materialId;
    const { layerSetId } = addMaterialLayerSetToStore(editor, anchor, {
      LayerSetName: 'EW-300',
      MaterialLayers: [{ Material: concrete, LayerThickness: 0.2 }, { Material: wool, LayerThickness: 0.1 }],
    });
    // The wall's profile is centred on its axis, so the layers start half the
    // thickness below the reference line.
    const { usageId } = addMaterialLayerSetUsageToStore(editor, anchor, { ForLayerSet: layerSetId, OffsetFromReferenceLine: -0.15 });
    assignMaterialInStore(editor, anchor, layerSetId, [typeId], readRelatedLists(store, 'IfcRelAssociatesMaterial', view));
    assignMaterialInStore(editor, anchor, usageId, [wallId], readRelatedLists(store, 'IfcRelAssociatesMaterial', view));
  }
  const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
  return { text: new TextDecoder().decode(result.content), wallId };
}

function wallClasses(api: IfcAPI, text: string, wallId: number): number[] {
  const bytes = new TextEncoder().encode(text);
  const pre = api.buildPrePassOnce(bytes);
  const classes: number[] = [];
  try {
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    );
    try {
      for (let i = 0; i < collection.length; i++) {
        const m = collection.get(i);
        if (!m) continue;
        if (m.expressId === wallId) classes.push(m.geometryClass);
        m.free();
      }
    } finally {
      collection.free();
    }
  } finally {
    api.clearPrePassCache();
  }
  return classes;
}

describe('wall type + layer set usage -> StepExporter -> parse + wasm mesh (#6232)', () => {
  it('reads the type and the usage\'s layers back off the exported wall', async () => {
    const { text, wallId } = await exportWall(true);
    const store = await parse(new TextEncoder().encode(text));
    const materials = extractMaterialsOnDemand(store, wallId);
    expect(materials?.type).toBe('MaterialLayerSet');
    expect(materials?.layers?.map((l) => [l.materialName, l.thickness])).toEqual([['Concrete', 0.2], ['Mineral wool', 0.1]]);
    expect(text).toMatch(new RegExp(`=IFCRELDEFINESBYTYPE\\('.{22}',\\$,\\$,\\$,\\(#${wallId}\\),#\\d+\\)`));
    expect(text).toMatch(/=IFCMATERIALLAYERSETUSAGE\(#\d+,\.AXIS2\.,\.POSITIVE\.,-0\.15,\$\)/);
    expect(text).toMatch(/=IFCWALLTYPE\('.{22}',\$,'EW-300',\$,\$,\$,\$,\$,\$,\.SOLIDWALL\.\)/);
  });

  it.skipIf(!existsSync(WASM_PATH))('meshes the wall as one slice per material layer', async () => {
    initSync({ module: readFileSync(WASM_PATH) });
    const api = new IfcAPI();
    const plain = await exportWall(false);
    const layered = await exportWall(true);
    const plainClasses = wallClasses(api, plain.text, plain.wallId);
    const layeredClasses = wallClasses(api, layered.text, layered.wallId);
    expect(plainClasses.length).toBeGreaterThan(0);
    expect(plainClasses).not.toContain(LAYER_SLICE);
    expect(layeredClasses.filter((c) => c === LAYER_SLICE)).toHaveLength(2);
  });
});
