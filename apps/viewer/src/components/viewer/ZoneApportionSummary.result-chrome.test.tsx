/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { Scene } from '../../../../../packages/renderer/src/scene';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { seedZoneExport } from '@/test/zone-export-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { cleanup, click, render } from '@/test/render';
import { useViewerStore, type FederatedModel } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { computeZoneApportionmentForElement, computeZoneApportionmentNow, straddlerIdsFor } from '@/hooks/useZoneApportionment';
import { recomputeZoneAssignmentsNow } from '@/hooks/useZoneAssignmentSync';
import { zoneSetRevision, type ZoneSet } from '@/lib/zones';
import { ZoneApportionSummary } from './ZoneApportionSummary';
import { ZonesPanel } from './ZonesPanel';

// #7204: real committed Bonsai IFC, canonical WASM mesh/proved volume and CPU Scene.
// Only the browser GPU host's scene-access boundary is controlled; no rendered result is claimed.
function installScene(meshes: readonly MeshData[]) {
  const scene = new Scene();
  for (const mesh of meshes) scene.addMeshData(mesh);
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  return scene;
}
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.getState().clearAllModels(); });

async function seed(federated: boolean | number = false) {
  const f = await seedZoneExport();
  useViewerStore.getState().clearAllModels();
  const maxExpressId = Math.max(...f.store.entities.expressId);
  const count = typeof federated === 'number' ? federated : federated ? 2 : 1;
  const names = Array.from({ length: count }, (_, index) => index === 0 ? 'Bonsai A.ifc' : index === 1 ? 'Bonsai B.ifc' : `Bonsai ${index + 1}.ifc`);
  const offsets = names.map(name => useViewerStore.getState().registerModelOffset(name, maxExpressId));
  const models = new Map<string, FederatedModel>(names.map((name, index) => [name,
    { ...fixtureModel(name, { idOffset: offsets[index] }), name, maxExpressId, ifcDataStore: f.store, geometryResult: null }]));
  useViewerStore.setState({ models, activeModelId: names[0], ifcDataStore: f.store, geometryResult: null,
    mutationViews: new Map(), zoneSets: [f.zoneSet], zoneApportionment: new Map() });
  const meshes = names.flatMap(name => f.meshes.map(mesh => ({ ...mesh,
    expressId: useViewerStore.getState().toGlobalId(name, mesh.expressId) })));
  for (const [name, model] of models) model.geometryResult = { ...f.geometry,
    meshes: meshes.filter(mesh => useViewerStore.getState().resolveGlobalIdFromModels(mesh.expressId)?.modelId === name) };
  const ids = names.map(name => useViewerStore.getState().toGlobalId(name, f.wall.expressId));
  useViewerStore.setState({ models: new Map(models), zoneAssignments: new Map() });
  const scene = installScene(meshes);
  const bounds = scene.getEntityBoundingBox(ids[0]); assert.ok(bounds);
  const cut = bounds.min.x + (bounds.max.x - bounds.min.x) * 0.1;
  const centerY = (bounds.min.y + bounds.max.y) / 2, centerZ = (bounds.min.z + bounds.max.z) / 2;
  const zoneSet: ZoneSet = { ...f.zoneSet, zones: [
    { id: 'left', name: 'Left cut', center: [(bounds.min.x + cut) / 2, centerY, centerZ],
      size: [cut - bounds.min.x, bounds.max.y - bounds.min.y + 1, bounds.max.z - bounds.min.z], rotationY: 0 },
    { id: 'right', name: 'Right cut', center: [(cut + bounds.max.x) / 2, centerY, centerZ],
      size: [bounds.max.x - cut, bounds.max.y - bounds.min.y + 1, bounds.max.z - bounds.min.z], rotationY: 0 },
  ] };
  useViewerStore.setState({ zoneSets: [zoneSet] });
  recomputeZoneAssignmentsNow();
  assert.deepEqual(straddlerIdsFor(zoneSet.id).sort((a, b) => a - b), [...ids].sort((a, b) => a - b), 'real native AABB classifier identifies exactly the authored boundary-crossing wall in each model');
  return { ...f, zoneSet, names, ids, meshes, guid: f.store.entities.getGlobalId(f.wall.expressId) };
}
function region(ui: HTMLElement) {
  const value = ui.querySelector('section[aria-label="Volume splits · Native Bonsai sections results"]');
  assert.ok(value, 'actual native apportionment mounts shared source/coverage/action/evidence regions');
  return value;
}
function stored(set: ZoneSet) { const entry = useViewerStore.getState().zoneApportionment.get(set.id); assert.ok(entry); return entry; }

test('#7204 whole-pass native split button publishes captured source, actual counts and proved-volume conservation', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed();
  const ui = render(<ZonesPanel />);
  const button = [...ui.querySelectorAll('button')].find(item => item.textContent?.includes('Split volumes (1 boundary-crossing element)'));
  assert.ok(button); click(button);
  const entry = stored(f.zoneSet); const result = entry.byElement.get(f.ids[0]); assert.ok(result);
  assert.equal(result.shares.length, 2, 'the native classified wall crosses both actual cut zones');
  assert.ok(Math.abs(result.wholeVolumeM3 - (f.wall.geometryVolume ?? NaN)) < 1e-5, 'independent native mesher proof agrees with clipper whole volume');
  assert.ok(Math.abs(result.shares.reduce((n, share) => n + share.volumeM3, result.outsideVolumeM3) - result.wholeVolumeM3) < 1e-5, 'native shares plus outside conserve the proved authored wall');
  const view = region(ui);
  assert.ok(view.querySelector('[data-status="complete"]'));
  assert.match(view.textContent ?? '', /1 proved splits \/ 1 cached entity outcomes/);
  assert.match(view.textContent ?? '', /Bonsai A\.ifc/);
  assert.match(view.textContent ?? '', new RegExp(f.guid));
  assert.match(view.textContent ?? '', /IfcWall/);
  assert.ok(view.querySelector('fieldset[aria-label="Result actions"]'), 'existing native split button is the named action');
});

test('#7204 native federation counts only processed source entities and preserves model-qualified GUID evidence', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(true);
  const entry = computeZoneApportionmentNow(f.zoneSet);
  assert.equal(entry.byElement.size, 2); assert.equal(entry.refused.size, 0);
  for (const id of f.ids) assert.ok(Math.abs((entry.byElement.get(id)?.wholeVolumeM3 ?? NaN) - (f.wall.geometryVolume ?? NaN)) < 1e-5);
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />); const view = region(ui);
  assert.match(view.textContent ?? '', /2 proved splits \/ 2 cached entity outcomes/);
  const evidence = view.querySelector('ul[aria-label="Cached split source entities"]'); assert.ok(evidence);
  assert.equal(evidence.children.length, 2);
  for (const name of f.names) assert.ok([...evidence.children].some(row => row.textContent?.includes(name) && row.textContent.includes(f.guid)));
});

test('#7204 per-element native cache is partial whole-set coverage and does not name unprocessed peer models', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(true); const result = computeZoneApportionmentForElement(f.zoneSet, f.ids[0]);
  assert.ok(result.apportionment);
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />); const view = region(ui);
  assert.ok(view.querySelector('[data-status="partial"]'));
  assert.match(view.textContent ?? '', /1 proved splits \/ 1 cached entity outcomes/);
  assert.match(view.textContent ?? '', /Per-element cache updates/);
  assert.match(view.textContent ?? '', /Bonsai A\.ifc/);
  assert.doesNotMatch(view.textContent ?? '', /Bonsai B\.ifc/);
});

test('#7204 bounded source evidence never changes the actual full native processed population', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(21); const entry = computeZoneApportionmentNow(f.zoneSet);
  assert.equal(entry.byElement.size, 21);
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />); const view = region(ui);
  assert.ok(view.querySelector('[data-status="complete"]'));
  assert.match(view.textContent ?? '', /21 proved splits \/ 21 cached entity outcomes/);
  assert.match(view.textContent ?? '', /Showing 20 of 21 cached entity sources/);
  assert.equal(view.querySelector('ul[aria-label="Cached split source entities"]')?.children.length, 20);
});

test('#7204 merging a new native element cannot freshen older rows or rename their captured source', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(true); computeZoneApportionmentNow(f.zoneSet);
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />);
  await act(async () => {
    useViewerStore.getState().setModelName(f.names[0], 'Renamed after the run.ifc');
    // Stated native freshness invariant: a new geometry content revision invalidates older measurements.
    useViewerStore.setState({ geometryContentVersion: useViewerStore.getState().geometryContentVersion + 1 });
    computeZoneApportionmentForElement(f.zoneSet, f.ids[1]);
  });
  const view = region(ui);
  assert.ok(view.querySelector('[data-status="stale"]'), 'retained first row still has the older native revision');
  assert.match(view.textContent ?? '', /Bonsai A\.ifc/);
  assert.doesNotMatch(view.textContent ?? '', /Renamed after the run/);
  assert.match(view.textContent ?? '', /2 proved splits \/ 2 cached entity outcomes/);
});

test('#7204 an unrecorded native cache stays unknown through a per-element update of another row', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(true); const actual = computeZoneApportionmentNow(f.zoneSet);
  useViewerStore.setState({ zoneApportionment: new Map([[f.zoneSet.id, { ...actual }]]) });
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />);
  assert.ok(region(ui).querySelector('[data-status="uncertain"]'));
  assert.doesNotMatch(region(ui).textContent ?? '', /Bonsai A\.ifc|Bonsai B\.ifc/);
  await act(async () => { computeZoneApportionmentForElement(f.zoneSet, f.ids[1]); });
  const view = region(ui);
  assert.ok(view.querySelector('[data-status="uncertain"]'));
  assert.match(view.textContent ?? '', /Bonsai B\.ifc/);
  assert.doesNotMatch(view.textContent ?? '', /Bonsai A\.ifc/);
  assert.match(view.textContent ?? '', /Unknown model source/);
  assert.match(view.textContent ?? '', /2 proved splits \/ 2 cached entity outcomes/);
});

test('#7204 unknown older origins do not hide known-row geometry staleness', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(true); const actual = computeZoneApportionmentNow(f.zoneSet);
  useViewerStore.setState({ zoneApportionment: new Map([[f.zoneSet.id, { ...actual }]]) });
  computeZoneApportionmentForElement(f.zoneSet, f.ids[1]);
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />);
  await act(async () => { useViewerStore.setState({ geometryContentVersion: useViewerStore.getState().geometryContentVersion + 1 }); });
  const view = region(ui);
  assert.ok(view.querySelector('[data-status="uncertain"]'), 'the retained unrecorded row still has unknown origin');
  assert.match(view.textContent ?? '', /Cached source history is unavailable/);
  assert.match(view.textContent ?? '', /Cached split evidence is older than the current model state/, 'known captured geometry staleness remains explicit beside unknown-origin coverage');
  assert.match(view.textContent ?? '', /2 proved splits \/ 2 cached entity outcomes/);
});

test('#7204 native geometry without its IFC table preserves measurements and discloses unavailable identity', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(); useViewerStore.getState().updateModel(f.names[0], { ifcDataStore: null });
  const entry = computeZoneApportionmentNow(f.zoneSet); assert.equal(entry.byElement.size, 1);
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />); const view = region(ui);
  assert.ok(view.querySelector('[data-status="partial"]'));
  assert.match(view.textContent ?? '', /1 cached entity identities are unavailable/);
  assert.doesNotMatch(view.textContent ?? '', new RegExp(f.guid));
  assert.match(view.textContent ?? '', /1 proved splits \/ 1 cached entity outcomes/);
});

test('#7204 missing native CPU geometry is a refused cached entity, never no findings', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(); installScene([]);
  const entry = computeZoneApportionmentNow(f.zoneSet); assert.equal(entry.refused.get(f.ids[0]), 'no-geometry');
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />); const view = region(ui);
  assert.ok(view.querySelector('[data-result-state="partial"]'));
  assert.match(view.textContent ?? '', /0 proved splits \/ 1 cached entity outcomes/);
  assert.match(view.textContent ?? '', /1 skipped \(no geometry loaded\)/);
  assert.equal(Boolean(view.querySelector('[data-result-state="no-findings"]')), false);
});

test('#7204 native alignment refusal retains its distinct coverage reason', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(); useViewerStore.getState().updateModel(f.names[0], { federationAlignmentStatus: 'same-crs' });
  const entry = computeZoneApportionmentNow(f.zoneSet); assert.equal(entry.refused.get(f.ids[0]), 'rescaled-by-alignment');
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />); const view = region(ui);
  assert.ok(view.querySelector('[data-status="partial"]'));
  assert.match(view.textContent ?? '', /model rescaled by federation alignment/);
  assert.doesNotMatch(view.textContent ?? '', /mesh not a proven closed solid/);
});

test('#7204 revised native zone geometry hides the old cache and keeps the split control available', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(); computeZoneApportionmentNow(f.zoneSet);
  const revised: ZoneSet = { ...f.zoneSet, zones: f.zoneSet.zones.map(zone => ({ ...zone, center: [1000, 0, 0] })) };
  assert.notEqual(zoneSetRevision(revised), zoneSetRevision(f.zoneSet));
  const ui = render(<ZoneApportionSummary zoneSet={revised} />); const view = region(ui);
  assert.match(view.textContent ?? '', /No split result computed for this zone geometry/);
  assert.doesNotMatch(view.textContent ?? '', /1 proved splits/);
  const button = view.querySelector('button'); assert.ok(button); assert.equal(button.disabled, false);
});

test('#7204 native report remount preserves captured source even after a model rename', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(); computeZoneApportionmentNow(f.zoneSet);
  render(<ZoneApportionSummary zoneSet={f.zoneSet} />); cleanup();
  useViewerStore.getState().setModelName(f.names[0], 'Later model name.ifc');
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />); const view = region(ui);
  assert.match(view.textContent ?? '', /Bonsai A\.ifc/); assert.doesNotMatch(view.textContent ?? '', /Later model name/);
  assert.match(view.textContent ?? '', new RegExp(f.guid));
});

test('#7204 actual legacy single-model native split uses its retained source and GUID', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(); useViewerStore.setState({ models: new Map(), ifcDataStore: f.store, geometryResult: f.geometry });
  const entry = computeZoneApportionmentNow(f.zoneSet); assert.equal(entry.byElement.size, 1);
  const ui = render(<ZoneApportionSummary zoneSet={f.zoneSet} />); const view = region(ui);
  assert.ok(view.querySelector('[data-status="complete"]'));
  assert.match(view.textContent ?? '', /Single-model source/);
  assert.match(view.textContent ?? '', new RegExp(f.guid));
});

test('#7204 unrun and an explicitly evaluated empty native pass remain distinct', async t => {
  if (!ensureWasm(t)) return;
  const f = await seed(); const emptySet: ZoneSet = { ...f.zoneSet, zones: [] };
  useViewerStore.setState({ zoneSets: [emptySet] }); recomputeZoneAssignmentsNow();
  const ui = render(<ZoneApportionSummary zoneSet={emptySet} />);
  assert.match(region(ui).textContent ?? '', /No split result computed/);
  assert.equal(Boolean(region(ui).querySelector('[data-result-state="no-population"]')), false);
  const button = region(ui).querySelector('button'); assert.ok(button); assert.equal(button.disabled, true);
  await act(async () => { computeZoneApportionmentNow(emptySet); });
  assert.ok(region(ui).querySelector('[data-result-state="no-population"]'), 'native computed population was explicitly empty');
  assert.match(region(ui).textContent ?? '', /0 proved splits \/ 0 cached entity outcomes/);
});
