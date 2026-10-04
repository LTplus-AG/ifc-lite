/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: source-persisted edit effect measured through the real mesh pipeline. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { addWallToStore } from './wall.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { setElementSizeInStore } from './element-size-edit.js';
import { resizeWallInStore } from './wall-size-edit.js';
import { transformElementsInStore } from './element-transform-edit.js';
import { insideMesh, meshWalls } from './wall-join-mesh.oracle.js';

const WASM = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
it.skipIf(!existsSync(WASM))('#6232 source resize and pivot turn move wall occupancy, not only attribute values (run pnpm build:wasm)', async () => {
  initSync({ module: readFileSync(WASM) });
  const api = new IfcAPI();
  const bytes = readFileSync(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const wallId = addWallToStore(editor, resolveSpatialAnchor(store, 42, view), { Start: [10, 10, 0], End: [15, 10, 0], Thickness: .2, Height: 3 }).wallId;
  const exportText = (s: typeof store, v: MutablePropertyView) => new TextDecoder().decode(new StepExporter(s, v).export({ schema: 'IFC4', applyMutations: true }).content);
  const before = exportText(store, view);
  const persisted = await new IfcParser().parseColumnar(new TextEncoder().encode(before).buffer, { disableWorkerScan: true });
  const sourceView = new MutablePropertyView(null, 'm'), sourceEditor = new StoreEditor(persisted, sourceView);
  const original = meshWalls(api, before).get(wallId) ?? [];
  expect(original.length).toBeGreaterThan(0);
  // The ray oracle consumes the renderer's Y-up positions: IFC y=10 becomes render z=-10.
  expect(insideMesh(original, [12, 1, -10])).toBe(true);
  expect(insideMesh(original, [12, 1, -10.25])).toBe(false);
  sourceEditor.runAtomic(draft => {
    const target = { dataStore: persisted, view: draft.getMutationView(), editor: draft };
    const sized = setElementSizeInStore(target, wallId, { kind: 'wall', thickness: .6 });
    if (!sized.ok) throw new Error(sized.reason);
    const resized = resizeWallInStore(target, wallId, [10, 10, 0], [16, 10, 0]);
    if (!resized.ok) throw new Error(resized.reason);
  });
  const wide = meshWalls(api, exportText(persisted, sourceView)).get(wallId) ?? [];
  expect(insideMesh(wide, [12, 1, -10.25])).toBe(true);
  expect(insideMesh(wide, [15.5, 1, -10])).toBe(true);
  sourceEditor.runAtomic(draft => transformElementsInStore({ dataStore: persisted, view: draft.getMutationView(), editor: draft, selected: [wallId], op: { kind: 'rotate', pivot: [10, 10], angle: Math.PI / 2 } }));
  const turned = meshWalls(api, exportText(persisted, sourceView)).get(wallId) ?? [];
  expect(insideMesh(turned, [10, 1, -15.5])).toBe(true);
  expect(insideMesh(turned, [15.5, 1, -10])).toBe(false);
});
