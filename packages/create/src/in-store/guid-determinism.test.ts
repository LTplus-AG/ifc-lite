/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Seeded-GUID determinism for the in-store builders: with a seeded
 * `RandomSource` on the anchor (or duplicate options), two identical build
 * runs must emit identical GlobalIds; without one, the platform CSPRNG
 * path stays random. Counterpart of the `IfcCreator` Timestamp/GuidSource
 * tests in ../ifc-creator.test.ts for the anchored builder path.
 *
 * The last suite closes the loop at the only level that actually matters to
 * a caller: the FINAL exported STEP bytes. Builders that attach psets or
 * qsets (`addSpaceToStore`) park them in the mutation overlay; they only
 * become `IfcPropertySet` / `IfcElementQuantity` / `IfcRelDefinesByProperties`
 * roots inside `StepExporter`, which mints those four GlobalIds itself - so
 * seeding the builders alone left the exported file non-reproducible until
 * `StepExportOptions.guidRandom` existed.
 */

import { describe, expect, it } from 'vitest';
import { isValidIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import type { SpatialAnchor } from './anchor.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore } from './wall.js';
import { addSlabToStore } from './slab.js';
import { addDoorToStore } from './door.js';
import { addSpaceToStore } from './space.js';
import { duplicateInStore, type SourceAttributes } from './duplicate.js';

/** mulberry32 - deterministic `RandomSource` for the tests. */
function seeded(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

function anchorWith(random: RandomSource | undefined): SpatialAnchor {
  return {
    ownerHistoryId: 5,
    bodyContextId: 14,
    axisContextId: 15,
    storeyId: 43,
    storeyPlacementId: 54,
    guidRandom: random,
  };
}

/** Build one wall + slab + door + space and collect every emitted GlobalId, in order. */
function buildRun(random: RandomSource | undefined): string[] {
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(makeStore(60), view);
  const anchor = anchorWith(random);
  addWallToStore(editor, anchor, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
  addSlabToStore(editor, anchor, { Profile: 'rectangle', Position: [0, 0, 0], Width: 5, Depth: 4, Thickness: 0.25 });
  addDoorToStore(editor, anchor, { Position: [1, 0, 0], Width: 0.9, Height: 2.1 });
  addSpaceToStore(editor, anchor, {
    Profile: 'rectangle', Position: [0, 0, 0], Width: 4, Depth: 3, Height: 2.8,
    boundaries: [{ elementId: 43 }],
  });
  return view.getNewEntities()
    .filter((e) => typeof e.attributes[0] === 'string' && isValidIfcGuid(e.attributes[0] as string))
    .map((e) => e.attributes[0] as string);
}

describe('in-store builders with a seeded RandomSource', () => {
  it('two same-seed runs emit identical GlobalIds through every builder', () => {
    const a = buildRun(seeded(42));
    const b = buildRun(seeded(42));
    expect(a.length).toBeGreaterThanOrEqual(8); // 4 elements + their rels + space boundary
    expect(b).toEqual(a);
  });

  it('different seeds diverge', () => {
    const a = buildRun(seeded(42));
    const b = buildRun(seeded(43));
    expect(b).not.toEqual(a);
  });

  it('unseeded runs stay random (CSPRNG default path)', () => {
    const a = buildRun(undefined);
    const b = buildRun(undefined);
    expect(a.length).toBe(b.length);
    expect(b).not.toEqual(a);
  });

  it('duplicateInStore honours options.guidRandom', () => {
    const source: SourceAttributes = {
      type: 'IfcWall',
      attributes: ['2AbCdEfGhIjKlMnOpQrStU', '#5', 'Wall', null, null, '#7', '#8', null],
      placementExpressId: 7,
      parentPlacementId: null,
      sourceLocation: [0, 0, 0],
      representationId: 8,
      ownerHistoryId: 5,
      axisRef: null,
      refDirectionRef: null,
      storeyId: 43,
    };
    const run = (random?: RandomSource): string[] => {
      const view = new MutablePropertyView(null, 'm1');
      const editor = new StoreEditor(makeStore(60), view);
      duplicateInStore(editor, source, { guidRandom: random });
      return view.getNewEntities()
        .filter((e) => typeof e.attributes[0] === 'string' && isValidIfcGuid(e.attributes[0] as string))
        .map((e) => e.attributes[0] as string);
    };
    const a = run(seeded(7));
    const b = run(seeded(7));
    expect(a.length).toBeGreaterThanOrEqual(2); // duplicate root + containment rel
    expect(b).toEqual(a);
    expect(run(seeded(8))).not.toEqual(a);
  });
});

// ============================================================================
// End-to-end: the exported STEP bytes, including StepExporter's own roots
// ============================================================================

/** Minimal IFC4 model with one storey - enough for `resolveSpatialAnchor`. */
const STOREY_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#7),#9);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#8=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#7,$,.MODEL_VIEW.,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
ENDSEC;
END-ISO-10303-21;`;

/**
 * Build a space (which attaches Qto_SpaceBaseQuantities + Pset_SpaceCommon
 * through the overlay) on a freshly parsed store, then export to STEP.
 * `random`/`timeStamp` are the determinism pins under test.
 */
async function exportSpaceModel(random: RandomSource | undefined, timeStamp: string | undefined): Promise<string> {
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(STOREY_MODEL).buffer as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, 'm1');
  view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(store, entityId));
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 30);
  anchor.guidRandom = random;
  addSpaceToStore(editor, anchor, {
    Profile: 'rectangle', Position: [0, 0, 0], Width: 4, Depth: 3, Height: 2.8, Name: 'Room 1',
  });
  const result = new StepExporter(store, view).export({
    schema: 'IFC4',
    applyMutations: true,
    guidRandom: random,
    timeStamp,
  });
  return new TextDecoder().decode(result.content);
}

describe('seeded in-store build -> StepExporter, final STEP bytes', () => {
  const TS = '20240101T000000';

  it('emits the four StepExporter-synthesized roots (pset, qset, two rels)', async () => {
    const out = await exportSpaceModel(seeded(11), TS);
    // These GlobalIds are minted by StepExporter, not by the builder: the
    // overlay only carries the pset/qset payloads.
    expect(out).toMatch(/=IFCPROPERTYSET\('.{22}',.+,'Pset_SpaceCommon'/);
    expect(out).toMatch(/=IFCELEMENTQUANTITY\('.{22}',.+,'Qto_SpaceBaseQuantities'/);
    expect((out.match(/=IFCRELDEFINESBYPROPERTIES\('.{22}'/g) ?? []).length).toBe(2);
  });

  it('same seed twice => byte-identical exported file', async () => {
    const a = await exportSpaceModel(seeded(11), TS);
    const b = await exportSpaceModel(seeded(11), TS);
    expect(b).toBe(a);
  });

  it('a different seed changes the exported bytes', async () => {
    const a = await exportSpaceModel(seeded(11), TS);
    const b = await exportSpaceModel(seeded(12), TS);
    expect(b).not.toBe(a);
  });

  it('without a seed the synthesized roots stay random (default path unchanged)', async () => {
    const a = await exportSpaceModel(undefined, TS);
    const b = await exportSpaceModel(undefined, TS);
    expect(b).not.toBe(a);
    // The divergence is in the GlobalIds, not the structure: same line count.
    expect(b.split('\n').length).toBe(a.split('\n').length);
  });

  it('an unpinned timeStamp leaves the header instant on the wall clock', async () => {
    const pinned = await exportSpaceModel(seeded(11), TS);
    expect(pinned).toContain(`'${TS}'`);
    const unpinned = await exportSpaceModel(seeded(11), undefined);
    expect(unpinned).not.toContain(`'${TS}'`);
  });
});
