/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { DiffEntry } from '@ifc-lite/diff';
import type { FederatedModel } from '../../store/types.js';
import type { CompareRef } from './buildFingerprints.js';
import { describeChange } from './describeChange.js';
import { summarizeGeometryChange, type WorldAabb } from './geometrySummary.js';

// `summarizeGeometryChange` requires the world brand (#2659): these fixtures
// are authored directly in the absolute world frame.
const box = (min: [number, number, number], max: [number, number, number]): WorldAabb =>
  ({ frame: 'world', min, max });

describe('summarizeGeometryChange (#1197)', () => {
  it('reports no move and no reshape for an identical bounding box', () => {
    // The wall that "moved 1.09 m" had an identical bbox between revisions — a
    // re-tessellation dragged the old *vertex-weighted* centroid, not the box.
    const b = box([0, 0, 0], [3, 0.3, 2.7]);
    const summary = summarizeGeometryChange(b, box([...b.min] as [number, number, number], [...b.max] as [number, number, number]));
    assert.ok(summary);
    assert.strictEqual(summary!.movedDistance, 0, 'identical box must not read as moved');
    assert.strictEqual(summary!.reshaped, false);
  });

  it('reports a real translation as a move (box centre shifts)', () => {
    const a = box([0, 0, 0], [3, 0.3, 2.7]);
    const b = box([1, 0, 0], [4, 0.3, 2.7]); // +1 in x
    const summary = summarizeGeometryChange(a, b)!;
    assert.ok(Math.abs(summary.movedDistance - 1) < 1e-6, `expected ~1 m, got ${summary.movedDistance}`);
    assert.strictEqual(summary.reshaped, false);
  });

  it('snaps sub-tolerance jitter to zero (float noise is not a move)', () => {
    const a = box([0, 0, 0], [3, 0.3, 2.7]);
    const b = box([0.0005, 0, 0], [3.0005, 0.3, 2.7]); // 0.5 mm < MOVE_EPS
    const summary = summarizeGeometryChange(a, b)!;
    assert.strictEqual(summary.movedDistance, 0);
    assert.strictEqual(summary.reshaped, false);
  });

  it('detects a reshape when the box size changes', () => {
    const a = box([0, 0, 0], [3, 0.3, 2.7]);
    const b = box([0, 0, 0], [3.5, 0.3, 2.7]); // grew 0.5 m in x
    const summary = summarizeGeometryChange(a, b)!;
    assert.strictEqual(summary.reshaped, true);
    // Growing only in +x shifts the centre by half the growth — that is a
    // reshape, reported alongside any centre move.
    assert.ok(summary.movedDistance > 0);
    assert.ok(Math.abs(summary.sizeDelta.x - 0.5) < 1e-6);
  });

  it('treats a missing side as a (re)shaped change, never a phantom move', () => {
    const summary = summarizeGeometryChange(null, box([0, 0, 0], [1, 1, 1]))!;
    assert.strictEqual(summary.movedDistance, 0);
    assert.strictEqual(summary.reshaped, true);
  });
});

// ── USERDEFINED enum qualifier (#1401) ────────────────────────────────
// Version Compare used to render a removed/changed `.USERDEFINED.` enum as the
// bare, meaningless token "USERDEFINED". The real user-defined label lives in a
// companion attribute (ObjectType on occurrences, ElementType on type objects),
// so the display string must read "USERDEFINED (origin)". The raw comparison
// key is unchanged — only the presentation gains the qualifier.

/** Wrap one STEP body line in a minimal IFC4 envelope. */
function ifc4(body: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

async function storeFromStep(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  const parser = new IfcParser();
  // disableWorkerScan keeps the scan in-process (no Worker in node test).
  return parser.parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A two-model compare entry for the same element (local id 1) across A and B. */
function modifiedEntry(ifcType: string): DiffEntry<CompareRef> {
  const ref = (modelId: string): CompareRef => ({ modelId, localId: 1, globalId: 1 });
  return {
    key: 'element-key',
    state: 'modified',
    changeKinds: ['data'],
    base: { key: 'element-key', ifcType, dataHash: 'a', ref: ref('A') },
    head: { key: 'element-key', ifcType, dataHash: 'b', ref: ref('B') },
  };
}

function modelsFor(aStore: IfcDataStore, bStore: IfcDataStore): ReadonlyMap<string, FederatedModel> {
  return new Map<string, FederatedModel>([
    ['A', { ifcDataStore: aStore, geometryResult: null } as FederatedModel],
    ['B', { ifcDataStore: bStore, geometryResult: null } as FederatedModel],
  ]);
}

describe('describeChange — USERDEFINED enum qualifier (#1401)', () => {
  it('expands an occurrence PredefinedType=USERDEFINED with its ObjectType companion', async () => {
    // IfcWall attrs: [GlobalId, OwnerHistory, Name, Description, ObjectType,
    // ObjectPlacement, Representation, Tag, PredefinedType]. ObjectType="origin".
    const aStore = await storeFromStep(
      "#1=IFCWALL('1wall_a_guid_aaaaaaaaa',$,'Wall',$,'origin',$,$,$,.USERDEFINED.);",
    );
    const bStore = await storeFromStep(
      "#1=IFCWALL('1wall_b_guid_aaaaaaaaa',$,'Wall',$,'origin',$,$,$,.NOTDEFINED.);",
    );

    const detail = describeChange(modifiedEntry('IfcWall'), modelsFor(aStore, bStore));
    assert.ok(detail, 'expected a change detail for a modified entry');

    const predefined = detail!.data.find((d) => d.name === 'PredefinedType');
    assert.ok(predefined, 'expected a PredefinedType delta');
    assert.strictEqual(predefined!.before, 'USERDEFINED (origin)');
    // The non-USERDEFINED side stays a bare token (no spurious qualifier).
    assert.strictEqual(predefined!.after, 'NOTDEFINED');
  });

  it('keeps the bare token when the change is a removal but still qualifies the before side', async () => {
    // B drops PredefinedType entirely (8-attr wall) → the delta is a removal,
    // and the surviving A-side value must still read "USERDEFINED (origin)".
    const aStore = await storeFromStep(
      "#1=IFCWALL('1wall_c_guid_aaaaaaaaa',$,'Wall',$,'origin',$,$,$,.USERDEFINED.);",
    );
    const bStore = await storeFromStep(
      "#1=IFCWALL('1wall_d_guid_aaaaaaaaa',$,'Wall',$,'origin',$,$,$);",
    );

    const detail = describeChange(modifiedEntry('IfcWall'), modelsFor(aStore, bStore));
    const predefined = detail!.data.find((d) => d.name === 'PredefinedType');
    assert.ok(predefined, 'expected a PredefinedType delta');
    assert.strictEqual(predefined!.kind, 'removed');
    assert.strictEqual(predefined!.before, 'USERDEFINED (origin)');
  });

  it('uses the ElementType companion for type objects (IfcWallType)', async () => {
    // IfcWallType attrs: [GlobalId, OwnerHistory, Name, Description,
    // ApplicableOccurrence, HasPropertySets, RepresentationMaps, Tag,
    // ElementType, PredefinedType]. ElementType="origin".
    const aStore = await storeFromStep(
      "#1=IFCWALLTYPE('1type_a_guid_aaaaaaaaa',$,'Wall Type',$,$,$,$,$,'origin',.USERDEFINED.);",
    );
    const bStore = await storeFromStep(
      "#1=IFCWALLTYPE('1type_b_guid_aaaaaaaaa',$,'Wall Type',$,$,$,$,$,'origin',.NOTDEFINED.);",
    );

    const detail = describeChange(modifiedEntry('IfcWallType'), modelsFor(aStore, bStore));
    const predefined = detail!.data.find((d) => d.name === 'PredefinedType');
    assert.ok(predefined, 'expected a PredefinedType delta');
    assert.strictEqual(predefined!.before, 'USERDEFINED (origin)');
  });
});

describe('describeChange - resolved material', () => {
  /** A proxy whose material arrives through the layer-set-usage indirection.
   *  `base` shifts every express id, modelling a re-save's renumbering. */
  function layeredProxy(materialName: string, base: number): string {
    const n = (offset: number) => `#${base + offset}`;
    return [
      `${n(1)}=IFCBUILDINGELEMENTPROXY('0proxyproxyproxyproxy',$,'road - roadside verge - soil',$,$,$,$,$,.NOTDEFINED.);`,
      `${n(2)}=IFCMATERIAL('${materialName}',$,$);`,
      `${n(3)}=IFCMATERIALLAYER(${n(2)},0.3,$,$,$,$,$);`,
      `${n(4)}=IFCMATERIALLAYERSET((${n(3)}),'Verge build-up',$);`,
      `${n(5)}=IFCMATERIALLAYERSETUSAGE(${n(4)},.AXIS2.,.POSITIVE.,0.,$);`,
      `${n(6)}=IFCRELASSOCIATESMATERIAL('0relmatrelmatrelmatr',$,$,$,(${n(1)}),${n(5)});`,
    ].join('\n');
  }

  /** The entry the panel describes; local id 1 is the proxy in `base` 0. */
  function entryFor(baseLocalId: number, headLocalId: number): DiffEntry<CompareRef> {
    const entry = modifiedEntry('IfcBuildingElementProxy');
    entry.base!.ref = { modelId: 'A', localId: baseLocalId, globalId: baseLocalId };
    entry.head!.ref = { modelId: 'B', localId: headLocalId, globalId: headLocalId };
    return entry;
  }

  it('names the material on both sides of a re-specification', async () => {
    const aStore = await storeFromStep(layeredProxy('Soil1', 0));
    const bStore = await storeFromStep(layeredProxy('topsoil', 0));
    const detail = describeChange(entryFor(1, 1), modelsFor(aStore, bStore));
    const material = detail!.data.find((d) => d.name === 'Material');
    assert.ok(material, 'expected a Material delta');
    assert.strictEqual(material!.before, 'Soil1');
    assert.strictEqual(material!.after, 'topsoil');
    assert.strictEqual(material!.kind, 'changed');
  });

  it('emits NOTHING when only the material entity was renumbered', async () => {
    // The control, at the display layer too: a re-save must not produce a row.
    const aStore = await storeFromStep(layeredProxy('Soil1', 0));
    const bStore = await storeFromStep(layeredProxy('Soil1', 500));
    const detail = describeChange(entryFor(1, 501), modelsFor(aStore, bStore));
    assert.strictEqual(detail!.data.find((d) => d.name === 'Material'), undefined);
  });

  it('reports gaining a material as an addition, not a change from blank', async () => {
    const aStore = await storeFromStep(
      "#1=IFCBUILDINGELEMENTPROXY('0proxyproxyproxyproxy',$,'road - roadside verge - soil',$,$,$,$,$,.NOTDEFINED.);",
    );
    const bStore = await storeFromStep(layeredProxy('topsoil', 0));
    const detail = describeChange(entryFor(1, 1), modelsFor(aStore, bStore));
    const material = detail!.data.find((d) => d.name === 'Material');
    assert.ok(material);
    assert.strictEqual(material!.kind, 'added');
    assert.strictEqual(material!.before, undefined);
    assert.strictEqual(material!.after, 'topsoil');
  });
});

describe('describeChange - a meshed element moved under the wasm local frame (#2529)', () => {
  it('reports the move when the translation is carried only by MeshData.origin', async () => {
    // Local-frame contract (rust/geometry/src/router/transforms/mod.rs, default
    // ON for wasm): world vertex = origin + position, and origin is the
    // element's AABB centre, so it follows the element. A pure translation
    // leaves `positions` byte-identical - the panel used to answer
    // "movedDistance 0, reshaped false" for an element that moved 40 m.
    const cube = (origin: [number, number, number]) => ({
      expressId: 1,
      positions: new Float32Array([-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
      origin,
    });
    const entry = modifiedEntry('IfcWall');
    entry.changeKinds = ['geometry'];
    const models = new Map<string, FederatedModel>([
      ['A', { geometryResult: { meshes: [cube([10, 2, 3])] } } as unknown as FederatedModel],
      ['B', { geometryResult: { meshes: [cube([50, 2, 3])] } } as unknown as FederatedModel],
    ]);
    const detail = describeChange(entry, models);
    assert.ok(detail?.geometry, 'a geometry change must be described');
    assert.ok(
      Math.abs(detail!.geometry!.movedDistance - 40) < 1e-6,
      `element moved 40 m via origin only; got ${detail!.geometry!.movedDistance}`,
    );
    assert.strictEqual(detail!.geometry!.reshaped, false, 'a pure translation is not a reshape');
  });
});

describe('describeChange - a geometry-less product that was re-georeferenced', () => {
  /** A site under a two-link placement chain; `parentY`/`childY` split its
   *  world Y between the root link and its own. Representation is `$`, so it
   *  produces no mesh and `meshBounds` finds nothing on either side. */
  function sited(guid: string, parentY: number, childY: number): string {
    return [
      `#1=IFCSITE('${guid}',$,'environment - site',$,$,#23,$,$,.ELEMENT.,$,$,$,$,$);`,
      `#10=IFCCARTESIANPOINT((0.,${parentY.toFixed(1)},0.));`,
      `#11=IFCCARTESIANPOINT((0.,${childY.toFixed(1)},0.));`,
      '#20=IFCAXIS2PLACEMENT3D(#10,$,$);',
      '#21=IFCAXIS2PLACEMENT3D(#11,$,$);',
      '#22=IFCLOCALPLACEMENT($,#20);',
      '#23=IFCLOCALPLACEMENT(#22,#21);',
    ].join('\n');
  }

  function geometryEntry(): DiffEntry<CompareRef> {
    const entry = modifiedEntry('IfcSite');
    entry.changeKinds = ['geometry'];
    // What buildFingerprints records for a geometry-less product — and the
    // gate on the placement path: only a pair that is geometry-less on BOTH
    // sides may be described by its placement.
    entry.base!.ref = { modelId: 'A', localId: 1, globalId: 1, meshed: false };
    entry.head!.ref = { modelId: 'B', localId: 1, globalId: 1, meshed: false };
    return entry;
  }

  it('reports the composed distance moved, not a phantom reshape', async () => {
    // GAP 5 in reverse. With no mesh on either side `meshBounds` returns null
    // twice, and `summarizeGeometryChange(null, null)` answers "reshaped" — the
    // exact false positive the field report called out. A geometry-less product
    // never reshapes; the only geometric thing it can do is move, and the
    // composed placement is what says how far.
    const aStore = await storeFromStep(sited('23sFQGRy90RxVbRHD9iSE2', 40, 0));
    const bStore = await storeFromStep(sited('23sFQGRy90RxVbRHD9iSE2', 0, 0));
    const detail = describeChange(geometryEntry(), modelsFor(aStore, bStore));
    assert.ok(detail?.geometry, 'a geometry change must be described');
    assert.strictEqual(detail!.geometry!.reshaped, false, 'a placement move is not a reshape');
    assert.ok(
      Math.abs(detail!.geometry!.movedDistance - 40) < 1e-6,
      `expected ~40 m, got ${detail!.geometry!.movedDistance}`,
    );
    // Display convention: y is plan, z is up. The move was along IFC +Y.
    assert.ok(Math.abs(detail!.geometry!.delta.y + 40) < 1e-6, 'plan delta');
    assert.strictEqual(detail!.geometry!.delta.z, 0, 'nothing moved vertically');
  });

  it('converts the file unit to metres, so a millimetre model does not read as 40 km', async () => {
    // The composed transform is in the file's own length unit. Without
    // `lengthUnitScale` the panel would print a 40 m re-georeferencing as
    // 40000 m.
    const mm = [
      '#100=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
      '#101=IFCUNITASSIGNMENT((#100));',
      "#102=IFCPROJECT('0projectprojectproject',$,'P',$,$,$,$,$,#101);",
    ].join('\n');
    const aStore = await storeFromStep(`${sited('23sFQGRy90RxVbRHD9iSE2', 40000, 0)}\n${mm}`);
    const bStore = await storeFromStep(`${sited('23sFQGRy90RxVbRHD9iSE2', 0, 0)}\n${mm}`);
    const detail = describeChange(geometryEntry(), modelsFor(aStore, bStore));
    assert.ok(detail?.geometry);
    assert.ok(
      Math.abs(detail!.geometry!.movedDistance - 40) < 1e-6,
      `expected 40 m from 40000 mm, got ${detail!.geometry!.movedDistance}`,
    );
  });

  it('reports no geometry change, not a phantom reshape, when the placement itself cannot be composed', async () => {
    // Both sides are geometry-less (meshed: false) but their placement is an
    // `IfcGridPlacement`, which `composeWorldPlacement` whitelists out and
    // abstains on (worldPlacement.ts: only IfcLocalPlacement is composed).
    // `placementMoveSummary` therefore also abstains (null), and falling
    // through to `summarizeGeometryChange(null, null)` would answer
    // "Reshaped" — the exact false positive this path exists to avoid,
    // reached via abstention instead of a meshed mismatch.
    const grid = [
      "#1=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'environment - site',$,$,#30,$,$,.ELEMENT.,$,$,$,$,$);",
      '#30=IFCGRIDPLACEMENT($,$);',
    ].join('\n');
    const aStore = await storeFromStep(grid);
    const bStore = await storeFromStep(grid);
    const detail = describeChange(geometryEntry(), modelsFor(aStore, bStore));
    assert.strictEqual(detail!.geometry, null, 'no trustworthy geometry signal, so no summary at all');
  });

  it('keeps a GPU-instanced element off the placement path (meshed, but no flat mesh)', async () => {
    // An instanced-only entity (#924) carries a real WASM hash folded from
    // `instancedGeometryHashes`, but appears in neither side's flat
    // `geometryResult.meshes` — so "no box on either side" does NOT mean
    // "geometry-less product". Its `ref.meshed` says so, and the placement
    // branch must respect it: an instanced element reshaped in place has an
    // UNCHANGED placement, and describing it by placement would report "moved
    // 0, not reshaped" for a real mesh change.
    const aStore = await storeFromStep(sited('23sFQGRy90RxVbRHD9iSE2', 40, 0));
    const bStore = await storeFromStep(sited('23sFQGRy90RxVbRHD9iSE2', 40, 0));
    const entry = geometryEntry();
    entry.base!.ref = { modelId: 'A', localId: 1, globalId: 1, meshed: true };
    entry.head!.ref = { modelId: 'B', localId: 1, globalId: 1, meshed: true };
    const detail = describeChange(entry, modelsFor(aStore, bStore));
    // Falls through to the box comparison, whose missing-side answer is
    // "reshaped" — the honest reading for a meshed entity we cannot bound.
    assert.strictEqual(detail!.geometry!.reshaped, true);
    assert.strictEqual(detail!.geometry!.movedDistance, 0);
  });

  it('still reports a reshape when a MESHED element lost its geometry', async () => {
    // Bounding control: the placement path must only take over when neither
    // side produced a mesh. A meshed element whose geometry vanished is a real
    // one-sided change and must keep reading as reshaped.
    const aStore = await storeFromStep(sited('23sFQGRy90RxVbRHD9iSE2', 40, 0));
    const bStore = await storeFromStep(sited('23sFQGRy90RxVbRHD9iSE2', 40, 0));
    const models = new Map<string, FederatedModel>([
      ['A', {
        ifcDataStore: aStore,
        geometryResult: { meshes: [{ expressId: 1, positions: new Float32Array([0, 0, 0, 1, 1, 1]) }] },
      } as unknown as FederatedModel],
      ['B', { ifcDataStore: bStore, geometryResult: null } as FederatedModel],
    ]);
    // The base ref must SAY meshed, or the fixture is not the meshed element
    // the test name claims and the assertion would pass through the box-
    // presence branch alone.
    const entry = geometryEntry();
    entry.base!.ref = { modelId: 'A', localId: 1, globalId: 1, meshed: true };
    const detail = describeChange(entry, models);
    assert.strictEqual(detail!.geometry!.reshaped, true);
  });
});
