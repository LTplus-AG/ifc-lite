/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for #8446: `rotateProductYaw` refused any parsed element
 * whose `IfcAxis2Placement3D` leaves `RefDirection` implicit
 * (`IFCAXIS2PLACEMENT3D(#p,$,$)`), the form real exporters emit routinely,
 * while translating the same element worked. The fix materialises the
 * implicit `Axis` / `RefDirection` defaults as explicit `IfcDirection`
 * records inside the caller's atomic edit, so one compound undo restores
 * the original record with nothing orphaned.
 *
 * Fixture is a real parsed store (`IfcParser().parseColumnar`) over inline
 * STEP, following the pattern of `apply-style.test.ts`: placement reads of
 * source-buffer entities go through `EntityExtractor(store.source)`, which
 * a synthetic store shape cannot serve.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import {
  MutablePropertyView,
  StoreEditor,
  recordCompoundMutation,
  undoRecordedMutationOperations,
} from '@ifc-lite/mutations';
import {
  asExpressIdRef,
  readAttributes,
  resolveRotationState,
  rotateProductYaw,
} from './edit/placement-core.js';

const BOILERPLATE = `#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#7),#9);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#8=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#7,$,.MODEL_VIEW.,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);`;

/**
 * Three walls, one per direction-slot shape:
 *  - #100: Axis and RefDirection both implicit — `(#40,$,$)`, the #8446 case.
 *  - #101: RefDirection explicit, Axis implicit — rotated in place before #8446.
 *  - #102: both explicit — rotated in place before #8446.
 */
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${BOILERPLATE}
#40=IFCCARTESIANPOINT((1.,2.,0.));
#41=IFCAXIS2PLACEMENT3D(#40,$,$);
#42=IFCLOCALPLACEMENT($,#41);
#100=IFCWALL('guidA0000000000000000A',$,'WallImplicit',$,$,#42,$,$,.STANDARD.);
#50=IFCCARTESIANPOINT((3.,4.,0.));
#51=IFCDIRECTION((1.,0.,0.));
#52=IFCAXIS2PLACEMENT3D(#50,$,#51);
#53=IFCLOCALPLACEMENT($,#52);
#101=IFCWALL('guidB0000000000000000B',$,'WallRefOnly',$,$,#53,$,$,.STANDARD.);
#61=IFCDIRECTION((0.,0.,1.));
#63=IFCDIRECTION((1.,0.,0.));
#64=IFCAXIS2PLACEMENT3D(#50,#61,#63);
#65=IFCLOCALPLACEMENT($,#64);
#102=IFCWALL('guidC0000000000000000C',$,'WallExplicit',$,$,#65,$,$,.STANDARD.);
ENDSEC;
END-ISO-10303-21;`;

const WALL_IMPLICIT = 100;
const WALL_REF_ONLY = 101;
const WALL_EXPLICIT = 102;
const AXIS_PLACEMENT_IMPLICIT = 41;

async function parseFixture(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(
    new TextEncoder().encode(MODEL).buffer as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

describe('#8446 rotateProductYaw with implicit placement directions', () => {
  it('rotates a wall whose axis placement leaves Axis and RefDirection implicit, and one compound undo restores the original record', async () => {
    const store = await parseFixture();
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);

    const before = resolveRotationState(store, view, editor, WALL_IMPLICIT);
    expect(before?.refDirectionId).toBeNull();
    expect(before?.refDirection).toEqual([1, 0, 0]);
    const originalAxisAttrs = readAttributes(store, view, editor, AXIS_PLACEMENT_IMPLICIT);
    expect(view.getNewEntities()).toEqual([]);

    const result = recordCompoundMutation(view, (draft) =>
      rotateProductYaw(store, draft, new StoreEditor(store, draft), WALL_IMPLICIT, Math.PI / 2));
    if (!result.ok) throw new Error(`rotate refused: ${result.reason}`);
    expect(result.newYawZ).toBeCloseTo(Math.PI / 2, 12);
    expect(result.newRefDirection[0]).toBeCloseTo(0, 12);
    expect(result.newRefDirection[1]).toBeCloseTo(1, 12);
    expect(result.newRefDirection[2]).toBeCloseTo(0, 12);

    // Both implicit slots are now explicit IfcDirection records carrying the
    // STEP defaults, rotated for RefDirection — and they are exactly the new
    // entities, so nothing is orphaned.
    const axisAttrs = readAttributes(store, view, editor, AXIS_PLACEMENT_IMPLICIT);
    const axisDirectionId = asExpressIdRef(axisAttrs?.[1]);
    const refDirectionId = asExpressIdRef(axisAttrs?.[2]);
    expect(axisDirectionId).not.toBeNull();
    expect(refDirectionId).not.toBeNull();
    expect(readAttributes(store, view, editor, axisDirectionId!)?.[0]).toEqual([0, 0, 1]);
    const refRatios = readAttributes(store, view, editor, refDirectionId!)?.[0] as number[];
    expect(refRatios[0]).toBeCloseTo(0, 12);
    expect(refRatios[1]).toBeCloseTo(1, 12);
    expect(refRatios[2]).toBeCloseTo(0, 12);
    const created = view.getNewEntities();
    expect(created.map((e) => e.type)).toEqual(['IfcDirection', 'IfcDirection']);
    expect(new Set(created.map((e) => e.expressId))).toEqual(new Set([axisDirectionId, refDirectionId]));

    const after = resolveRotationState(store, view, editor, WALL_IMPLICIT);
    expect(after?.refDirectionId).toBe(refDirectionId);
    expect(after?.yawZ).toBeCloseTo(Math.PI / 2, 12);

    // One undo step restores the original record: no created entities, no
    // journal entries, and the axis placement reads back exactly as parsed.
    undoRecordedMutationOperations(view, 1, () => {
      throw new Error('rotate must record one compound operation');
    });
    expect(view.getNewEntities()).toEqual([]);
    expect(view.getMutations()).toEqual([]);
    expect(readAttributes(store, view, editor, AXIS_PLACEMENT_IMPLICIT)).toEqual(originalAxisAttrs);
    expect(resolveRotationState(store, view, editor, WALL_IMPLICIT)?.refDirectionId).toBeNull();
  });

  it('refuses a non-finite yaw on an implicit placement without creating any entity', async () => {
    const store = await parseFixture();
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);

    const result = rotateProductYaw(store, view, editor, WALL_IMPLICIT, Number.NaN);
    expect(result.ok).toBe(false);
    expect(view.getNewEntities()).toEqual([]);
    expect(view.getMutations()).toEqual([]);
  });

  it('still rotates an explicit RefDirection in place and materialises nothing', async () => {
    const store = await parseFixture();
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);

    const result = rotateProductYaw(store, view, editor, WALL_REF_ONLY, Math.PI / 2);
    if (!result.ok) throw new Error(`rotate refused: ${result.reason}`);
    expect(view.getNewEntities()).toEqual([]);
    const state = resolveRotationState(store, view, editor, WALL_REF_ONLY);
    expect(state?.refDirectionId).toBe(51);
    expect(state?.yawZ).toBeCloseTo(Math.PI / 2, 12);
    // The Axis slot stays implicit: only the RefDirection refusal was lifted.
    expect(readAttributes(store, view, editor, 52)?.[1]).toBeNull();
  });

  it('still rotates a fully explicit placement in place and materialises nothing', async () => {
    const store = await parseFixture();
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);

    const result = rotateProductYaw(store, view, editor, WALL_EXPLICIT, -Math.PI / 2);
    if (!result.ok) throw new Error(`rotate refused: ${result.reason}`);
    expect(view.getNewEntities()).toEqual([]);
    const state = resolveRotationState(store, view, editor, WALL_EXPLICIT);
    expect(state?.refDirectionId).toBe(63);
    expect(state?.yawZ).toBeCloseTo(-Math.PI / 2, 12);
    expect(readAttributes(store, view, editor, 61)?.[0]).toEqual([0, 0, 1]);
  });
});
