/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9296 (modelling parity, layered-walls row): a wall drawn with a layered
 * type places that type's layer set through a usage of its own. Retyping it
 * left the usage on the OLD type's set, so the wall kept the old build-up and
 * thickness (230 mm instead of the new type's 150 + 50 mm).
 *
 * Driven through `bim.store`, and read back from the exported IFC.
 */

import { expect, it } from 'vitest';
import { IfcCreator, readRelatedLists } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createOrdinaryStoreBackend } from './store-ordinary-backend.js';
import { createModellingStoreBackend } from './store-modelling-backend.js';
import { StoreNamespace } from './namespaces/store.js';
import type { BimBackend } from './types.js';

/** The exported file, as `id -> [TYPE, top-level arguments]`. */
function readStep(content: string | Uint8Array): Map<number, { type: string; args: string[] }> {
  const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
  const out = new Map<number, { type: string; args: string[] }>();
  for (const match of text.matchAll(/^#(\d+)\s*=\s*([A-Z0-9]+)\((.*)\);\s*$/gm)) {
    const args: string[] = [];
    let depth = 0, quoted = false, cell = '';
    for (const ch of match[3]) {
      if (ch === '\'') quoted = !quoted;
      if (!quoted && ch === '(') depth++;
      if (!quoted && ch === ')') depth--;
      if (!quoted && depth === 0 && ch === ',') { args.push(cell); cell = ''; } else cell += ch;
    }
    args.push(cell);
    out.set(Number(match[1]), { type: match[2], args });
  }
  return out;
}

const refs = (cell: string | undefined): number[] => [...(cell ?? '').matchAll(/#(\d+)/g)].map(m => Number(m[1]));

/** What the exported file says about a wall: its body thickness and the layers its material usage places. */
function exportedWall(step: ReturnType<typeof readStep>, wall: number): { thickness: number; layers: number[] } {
  const shape = step.get(refs(step.get(wall)?.args[6])[0]);
  const body = refs(shape?.args[2]).map(id => step.get(id)).find(rep => rep?.args[1] === '\'Body\'');
  const profile = step.get(refs(step.get(refs(body?.args[3])[0])?.args[0])[0]);
  const rel = [...step.values()].find(e => e.type === 'IFCRELASSOCIATESMATERIAL' && refs(e.args[4]).includes(wall));
  const usage = step.get(refs(rel?.args[5])[0]);
  const set = usage?.type === 'IFCMATERIALLAYERSETUSAGE' ? step.get(refs(usage.args[0])[0]) : undefined;
  return {
    thickness: profile?.type === 'IFCRECTANGLEPROFILEDEF' ? Number(profile.args[4]) : Number.NaN,
    layers: refs(set?.args[0]).map(id => Number(step.get(id)?.args[1])),
  };
}

async function session() {
  const creator = new IfcCreator({ Schema: 'IFC4' });
  const level = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const bytes = new TextEncoder().encode(creator.toIfc().content);
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const resolve = () => ({ modelId: 'm', store, editor, mutationView: view, view, ownerHistoryId: null });
  const sdk = new StoreNamespace({ store: { ...createOrdinaryStoreBackend(resolve), ...createModellingStoreBackend(resolve) } } as unknown as BimBackend);
  /** A wall type with its own layer set. */
  const layeredType = (Name: string, thicknesses: number[]) => {
    const type = sdk.addElementType('m', { Type: 'IfcWallType', Name }).expressId;
    const set = sdk.addMaterialLayerSet('m', { MaterialLayers: thicknesses.map(LayerThickness => ({ LayerThickness })) }).expressId;
    sdk.assignMaterial('m', set, [type]);
    return { type, set };
  };
  /** A wall drawn with `type`: typed by it, and placing `set` through a usage of its own, centred on its axis. */
  const drawWith = (type: number, set: number, total: number, y: number) => {
    const wall = sdk.addWall('m', level, { Start: [0, y, 0], End: [5, y, 0], Thickness: total, Height: 3 }).expressId;
    sdk.assignType('m', type, [wall]);
    const usage = sdk.addMaterialLayerSetUsage('m', { ForLayerSet: set, LayerSetDirection: 'AXIS2', OffsetFromReferenceLine: -total / 2 }).expressId;
    sdk.assignMaterial('m', usage, [wall]);
    return wall;
  };
  const exported = () => readStep(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
  const usageOf = (wall: number) => readRelatedLists(store, 'IfcRelAssociatesMaterial', view).find(rel => rel.relatedIds.includes(wall))!.relatingId!;
  return { sdk, level, layeredType, drawWith, usageOf, exported };
}

it('#9296 retyping a wall drawn with a layered type gives it the new type\'s layers and thickness, in the exported IFC', async () => {
  const m = await session();
  const a = m.layeredType('WT-230', [.115, .1, .015]), b = m.layeredType('WT-200-L', [.15, .05]);
  const wall = m.drawWith(a.type, a.set, .23, 0);
  expect(exportedWall(m.exported(), wall)).toEqual({ thickness: .23, layers: [.115, .1, .015] });

  m.sdk.assignType('m', b.type, [wall]);
  const after = exportedWall(m.exported(), wall);
  expect(after.layers).toEqual([.15, .05]);
  expect(after.thickness).toBeCloseTo(.2, 9);
});

it('#9296 a wall that shared its usage with the retyped one keeps the old type\'s layers', async () => {
  const m = await session();
  const a = m.layeredType('WT-230', [.115, .1, .015]), b = m.layeredType('WT-200-L', [.15, .05]);
  const moving = m.drawWith(a.type, a.set, .23, 0);
  const staying = m.sdk.addWall('m', m.level, { Start: [0, 3, 0], End: [5, 3, 0], Thickness: .23, Height: 3 }).expressId;
  m.sdk.assignType('m', a.type, [staying]);
  // One usage places the old type's set on both walls.
  m.sdk.assignMaterial('m', m.usageOf(moving), [staying]);
  m.sdk.assignType('m', b.type, [moving]);
  const step = m.exported();
  expect(exportedWall(step, moving).layers).toEqual([.15, .05]);
  expect(exportedWall(step, moving).thickness).toBeCloseTo(.2, 9);
  expect(exportedWall(step, staying)).toEqual({ thickness: .23, layers: [.115, .1, .015] });
});

it('#9296 a wall whose layers differ from its old type keeps them through a retype', async () => {
  const m = await session();
  const a = m.layeredType('WT-230', [.115, .1, .015]), b = m.layeredType('WT-200-L', [.15, .05]);
  const own = m.sdk.addMaterialLayerSet('m', { MaterialLayers: [{ LayerThickness: .3 }] }).expressId;
  const wall = m.drawWith(a.type, own, .3, 0);
  m.sdk.assignType('m', b.type, [wall]);
  expect(exportedWall(m.exported(), wall)).toEqual({ thickness: .3, layers: [.3] });
});

it('#9296 retyping to a type without layers leaves the wall the layers it had', async () => {
  const m = await session();
  const a = m.layeredType('WT-230', [.115, .1, .015]);
  const plain = m.sdk.addElementType('m', { Type: 'IfcWallType', Name: 'WT-plain' }).expressId;
  const wall = m.drawWith(a.type, a.set, .23, 0);
  m.sdk.assignType('m', plain, [wall]);
  expect(exportedWall(m.exported(), wall)).toEqual({ thickness: .23, layers: [.115, .1, .015] });
});
