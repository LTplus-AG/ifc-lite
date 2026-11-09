/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, snapshotOverlay, restoreOverlay } from '@ifc-lite/mutations';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { StepExporter } from './step-exporter.js';

const source = readFileSync(new URL('../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url));
const identity = { sourceContentHash: 'sha256:' + createHash('sha256').update(source).digest('hex'), schema: 'IFC4' };
function liveView(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'snapshot-model');
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  return view;
}
function exported(store: IfcDataStore, view: MutablePropertyView): string {
  return new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-11-09T00:00:00' }).content);
}

it('#8453 restores the real parsed sample to byte-identical STEP, then supports new edits and class/reference queries', async () => {
  const bytes = Uint8Array.from(source);
  const store = await new IfcParser().parseColumnar(bytes.buffer);
  const view = liveView(store), editor = new StoreEditor(store, view);
  const wall = store.entityIndex.byType.get('IFCWALL')![0];
  expect(wall).toBeGreaterThan(0);
  editor.setPositionalAttribute(wall, 2, 'Snapshot wall');
  view.setProperty(wall, 'Pset:Persistence', 'Fire:Rating', 'REI60', PropertyValueType.String, undefined, true);
  view.setQuantity(wall, 'Qto:Persistence', 'Length:A', 2.75, QuantityType.Length);
  const point = editor.addEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId;
  const placement = editor.addEntity('IfcAxis2Placement3D', ['#' + point, null, null]).expressId;
  const before = exported(store, view);
  const copy = liveView(store);
  restoreOverlay(copy, snapshotOverlay(view, identity), identity);
  expect(exported(store, copy)).toBe(before);
  expect(Array.from(copy.getNewEntitiesOfType('IFCCARTESIANPOINT'), row => row.expressId)).toEqual([point]);
  expect(Array.from(copy.getNewEntitiesReferencing(point), row => row.expressId)).toContain(placement);
  expect(copy.getPropertyValue(wall, 'Pset:Persistence', 'Fire:Rating')).toBe('REI60');
  const next = new StoreEditor(store, copy).addEntity('IfcColourRgb', [null, 0.25, 0.5, 0.75]).expressId;
  expect(next).toBeGreaterThan(placement);
  const after = exported(store, copy);
  expect(after).toContain('IFCCOLOURRGB($,0.25,0.5,0.75)');
  const reparsed = await new IfcParser().parseColumnar(new TextEncoder().encode(after).buffer);
  expect(reparsed.getEntity(wall)?.attributes[2]).toContain('Snapshot wall');
  expect(reparsed.entityIndex.byType.get('IFCCOLOURRGB')).toContain(next);
});

it('#8453 restoring a forgotten entity carries its property edits back into real IFC export', async () => {
  const store = await new IfcParser().parseColumnar(Uint8Array.from(source).buffer);
  const view = liveView(store), editor = new StoreEditor(store, view);
  const created = editor.addEntity('IfcWall', ['00000000000000000000AA', null, 'Recovered wall', null, null, null, null, null, '.NOTDEFINED.']);
  view.setProperty(created.expressId, 'Recovered:Set', 'Recovered:Value', 'retained');
  const parked = structuredClone(view.getNewEntity(created.expressId)!);
  const before = exported(store, view);
  view.deleteEntity(created.expressId);
  const copy = liveView(store);
  restoreOverlay(copy, snapshotOverlay(view, identity), identity);
  expect(exported(store, copy)).not.toContain('Recovered wall');
  copy.restoreNewEntity(parked);
  expect(exported(store, copy)).toBe(before);
  const text = exported(store, copy);
  expect(text).toContain('Recovered:Set');
  expect(text).toContain('Recovered:Value');
});
