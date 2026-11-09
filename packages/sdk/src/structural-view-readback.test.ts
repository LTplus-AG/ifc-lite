/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { QuantityType } from '@ifc-lite/data';
import {
  StepExporter, Ifc5Exporter, ParquetExporter, effectiveCreatedRecord,
  effectiveReferencers, editOwnershipRefusal, remeshContextRoots,
  captureAppearanceDependencies, planAuthoredResourceCleanup,
} from '@ifc-lite/export';
import { resolveSpatialAnchor, resolveDuplicateSource, effectiveStoreyElevation, deriveAuthoredBaseQuantities } from '@ifc-lite/create';
import { tableFromIPC } from 'apache-arrow';
import { readParquet } from 'parquet-wasm';
import { overlayFromView } from './headless/overlay.js';
import { createEffectiveRecordOverlay } from './effective-record-overlay.js';
import { effectiveCostReferenceOccurrences } from './cost-reference-scan.js';

// #9411's complete new public view/store member inventory, not just borrows.
const additions = new Set([
  'readNewEntity', 'readNewEntities', 'readNewEntitiesOfType',
  'getNewEntitiesReferencing', 'getAttributeOverrideReferenceCandidates',
]);

async function fixture() {
  // Real Bonsai wall: placement #1235, body #1230, point #1260.
  const bytes = new Uint8Array(await readFile(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)));
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'structural'), editor = new StoreEditor(store, view);
  const wall = editor.addEntity('IfcWall', ['0000000000000000000002', null, 'Authored wall', null, null, null, '#1230', null, null]).expressId;
  const shared = editor.addEntity('IfcWall', ['0000000000000000000003', null, 'Shared wall', null, null, '#1235', '#1230', null, null]).expressId;
  view.setAttribute(wall, 'Name', 'Edited wall');
  // Only an override introduces this reference; the authored index cannot find it.
  view.setAttribute(wall, 'ObjectPlacement', '#1235');
  view.setProperty(wall, 'Pset_Compat', 'Flag', true);
  view.createQuantitySet(wall, 'Qto_Compat', [{ name: 'Length', value: 2, quantityType: QuantityType.Length }]);
  const storey = store.entityIndex.byType.get('IFCBUILDINGSTOREY')![0]!;
  const relation = editor.addEntity('IfcRelContainedInSpatialStructure', ['0000000000000000000004', null, null, null, [`#${wall}`], `#${storey}`]).expressId;
  const color = editor.addEntity('IfcColourRgb', [null, 0.2, 0.3, 0.4]).expressId;
  editor.addEntity('IfcSurfaceStyleShading', [`#${color}`, null]);
  // Old methods ignore the newly added optional arguments. Bind delegates so
  // their implementation remains encapsulated behind this old public surface.
  const legacy = new Proxy(view, { get(target, key) {
    if (additions.has(String(key))) return undefined;
    if (key === 'getEffectiveChanges') return () => target.getEffectiveChanges();
    if (key === 'getAttributeOverrideEntityIds') return () => target.getAttributeOverrideEntityIds();
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const legacyEditor = new Proxy(editor, { get(target, key) {
    if (key === 'readNewEntity') return undefined;
    if (key === 'getMutationView') return () => legacy;
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { store, view, editor, legacy, legacyEditor, wall, shared, storey, relation, color };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Entry = readonly [string, (f: Fixture) => void | Promise<void>];
const entries: Entry[] = [
  ['export.effectiveReferencers', ({ store, legacy, wall, shared }) => {
    expect(effectiveReferencers(store, legacy)(1235)).toEqual(expect.arrayContaining([1222, wall, shared]));
  }],
  ['export.editOwnershipRefusal', ({ store, legacy, wall, shared }) => {
    expect(editOwnershipRefusal(store, legacy, [1235], new Set([1222, wall]))).toContain(`#${shared}`);
  }],
  ['export.STEP', ({ store, legacy, wall }) => {
    const text = new TextDecoder().decode(new StepExporter(store, legacy).export({ schema: 'IFC4', applyMutations: true }).content);
    expect(text).toContain(`#${wall}=IFCWALL(`);
    expect(text).toContain("'Edited wall'");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Flag'");
  }],
  ...[true, false].map((onlyTreeEntities): Entry => [`export.IFC5.tree=${onlyTreeEntities}`, ({ store, legacy }) => {
    expect(new Ifc5Exporter(store, undefined, legacy).export({ includeGeometry: false, onlyTreeEntities }).content).toContain('Edited wall');
  }]),
  ...['entities', 'relationships', 'properties', 'quantities'].map((table): Entry => [
    `export.Parquet.${table}`, async ({ store, view, legacy }) => {
      const rows = async (v: MutablePropertyView) => tableFromIPC(readParquet(await new ParquetExporter(store, undefined, v).exportTable(table)).intoIPCStream()).toArray().map(row => row.toJSON());
      const actual = await rows(legacy);
      expect(actual.length).toBeGreaterThan(0);
      expect(actual).toEqual(await rows(view));
    },
  ]),
  ['export.effectiveCreatedRecord', ({ store, legacy, wall }) => {
    expect(effectiveCreatedRecord(legacy, wall, store.schemaVersion)?.text).toContain("'Edited wall'");
  }],
  ['export.remeshContextRoots', ({ store, legacy }) => {
    expect(remeshContextRoots(store, legacy, new Set([1222])).size).toBeGreaterThan(0);
  }],
  ['export.captureAppearanceDependencies', ({ store, legacy, color }) => {
    const captured = captureAppearanceDependencies(store, legacy, new Set([color]));
    expect(() => captured.validate(legacy)).not.toThrow();
    legacy.setPositionalAttribute(color, 1, 0.8);
    expect(() => captured.validate(legacy)).toThrow();
  }],
  ['export.planAuthoredResourceCleanup', ({ store, legacy, color }) => {
    expect(planAuthoredResourceCleanup(store, legacy, new Set([color])).entityIds.has(color)).toBe(false);
  }],
  ['sdk.headless.inventory', ({ store, legacy, wall }) => {
    expect(overlayFromView(legacy, store)?.createdAll.find(entity => entity.expressId === wall)?.name).toBe('Edited wall');
  }],
  ['sdk.headless.point', ({ store, legacy, wall }) => {
    expect(overlayFromView(legacy, store)?.createdEntity(wall)?.name).toBe('Edited wall');
  }],
  ['sdk.headless.relationships', ({ store, legacy, wall, storey, relation }) => {
    expect(overlayFromView(legacy, store)?.relationshipEdges(storey, 'IfcRelContainedInSpatialStructure'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ targetId: wall, relationshipId: relation })]));
  }],
  ['sdk.effectiveRecordOverlay', ({ store, legacy, wall }) => {
    expect(createEffectiveRecordOverlay(legacy, store).created?.().find(record => record.expressId === wall)).toMatchObject({ type: 'IFCWALL' });
  }],
  ['sdk.costReferenceOccurrences', ({ store, legacy, wall, relation }) => {
    expect(effectiveCostReferenceOccurrences(store, legacy, new Set([wall])).get(wall)?.get(relation)).toBe(1);
  }],
  ['mutations.StoreEditor.borrowForwarder', ({ store, legacy, wall }) => {
    expect(new StoreEditor(store, legacy).readNewEntity(wall)?.expressId).toBe(wall);
  }],
  ['create.resolveDuplicateSource', ({ store, legacyEditor, wall, storey }) => {
    expect(resolveDuplicateSource(store, wall, legacyEditor)).toMatchObject({ placementExpressId: 1235, storeyId: storey });
  }],
  ['create.resolveSpatialAnchor', ({ store, legacy, storey }) => {
    expect(resolveSpatialAnchor(store, storey, legacy).storeyPlacementId).toBeGreaterThan(0);
  }],
  ['create.effectiveStoreyElevation', ({ store, legacy, storey }) => {
    legacy.setPositionalAttribute(storey, 9, 12);
    expect(effectiveStoreyElevation(store, legacy, storey)).toBe(12 * (store.lengthUnitScale ?? 1));
  }],
  ['create.deriveAuthoredBaseQuantities', ({ store, legacy, wall }) => {
    expect(deriveAuthoredBaseQuantities(store, legacy, wall).length).toBeGreaterThan(0);
  }],
];

it.each(entries)('#9411 old structural surface supports %s without any new methods', async (_name, check) => {
  await check(await fixture());
});
