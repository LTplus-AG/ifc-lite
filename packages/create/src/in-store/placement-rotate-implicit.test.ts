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

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { firstProjAxis } from '@ifc-lite/data';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import {
  MutablePropertyView,
  StoreEditor,
  recordCompoundMutation,
  undoRecordedMutationOperations,
} from '@ifc-lite/mutations';
import { asExpressIdRef, readAttributes } from './edit/placement-core.js';
import { resolveRotationState, rotateProductYaw } from './edit/placement-rotate.js';
import { transformElementsInStore } from './element-transform-edit.js';

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
 *  - #103: Axis explicit and tilted, RefDirection implicit — `(#70,#71,$)`.
 *    The renderer draws `firstProjAxis(Axis)` for the missing RefDirection
 *    (#5992), here `(0.8,0,-0.6)`, so rotation must not materialise +X.
 *  - #104: Axis +X and RefDirection +Z, both explicit — a vertical
 *    RefDirection, which a yaw about Z cannot turn.
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
#70=IFCCARTESIANPOINT((5.,6.,0.));
#71=IFCDIRECTION((0.6,0.,0.8));
#72=IFCAXIS2PLACEMENT3D(#70,#71,$);
#73=IFCLOCALPLACEMENT($,#72);
#103=IFCWALL('guidD0000000000000000D',$,'WallTiltedAxis',$,$,#73,$,$,.STANDARD.);
#80=IFCCARTESIANPOINT((7.,8.,0.));
#81=IFCDIRECTION((1.,0.,0.));
#82=IFCDIRECTION((0.,0.,1.));
#83=IFCAXIS2PLACEMENT3D(#80,#81,#82);
#84=IFCLOCALPLACEMENT($,#83);
#104=IFCWALL('guidE0000000000000000E',$,'WallVerticalRef',$,$,#84,$,$,.STANDARD.);
ENDSEC;
END-ISO-10303-21;`;

const WALL_IMPLICIT = 100;
const WALL_REF_ONLY = 101;
const WALL_EXPLICIT = 102;
const AXIS_PLACEMENT_IMPLICIT = 41;
const WALL_TILTED_AXIS = 103;
const AXIS_PLACEMENT_TILTED = 72;
const TILTED_AXIS: [number, number, number] = [0.6, 0, 0.8];
const WALL_VERTICAL_REF = 104;

function expectClose(actual: unknown, expected: readonly number[]): void {
  const ratios = actual as number[];
  expect(ratios).toHaveLength(expected.length);
  expected.forEach((value, i) => expect(ratios[i]).toBeCloseTo(value, 12));
}

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

  it('refuses to rotate a vertical RefDirection instead of reporting a no-op as success', async () => {
    const store = await parseFixture();
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);

    const result = rotateProductYaw(store, view, editor, WALL_VERTICAL_REF, Math.PI / 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/vertical/);
    expect(view.getNewEntities()).toEqual([]);
    expect(view.getMutations()).toEqual([]);
  });

  it('refuses a vertical RefDirection through transformElementsInStore before writing anything', async () => {
    // hello-wall's wall #1222 sits on a storey; its frame is turned so Axis
    // is +X and RefDirection is +Z.
    const sample = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url), 'utf8');
    const vertical = sample
      .replace('#1232=IFCDIRECTION((0.,0.,1.));', '#1232=IFCDIRECTION((1.,0.,0.));')
      .replace('#1233=IFCDIRECTION((1.,0.,0.));', '#1233=IFCDIRECTION((0.,0.,1.));');
    expect(vertical).not.toBe(sample);
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(vertical).buffer as ArrayBuffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);

    expect(() => transformElementsInStore({
      dataStore: store, view, editor,
      selected: [1222], op: { kind: 'rotate', pivot: [0, 0], angle: Math.PI / 2 },
    })).toThrow(/vertical/);
    expect(view.getNewEntities()).toEqual([]);
    expect(view.getMutations()).toEqual([]);
  });

  it('materialises the firstProjAxis fill, not +X, when an explicit tilted Axis leaves RefDirection implicit', async () => {
    const store = await parseFixture();
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);
    const fill = firstProjAxis(TILTED_AXIS);
    expectClose(fill, [0.8, 0, -0.6]);

    const before = resolveRotationState(store, view, editor, WALL_TILTED_AXIS);
    expect(before?.refDirectionId).toBeNull();
    expect(before?.axisDirectionId).toBe(71);
    expectClose(before?.refDirection, fill);
    expect(before?.yawZ).toBeCloseTo(0, 12);

    // A zero turn writes the frame the renderer already draws.
    const still = rotateProductYaw(store, view, editor, WALL_TILTED_AXIS, 0);
    if (!still.ok) throw new Error(`rotate refused: ${still.reason}`);
    const stillRef = asExpressIdRef(readAttributes(store, view, editor, AXIS_PLACEMENT_TILTED)?.[2]);
    expectClose(readAttributes(store, view, editor, stillRef!)?.[0], fill);
  });

  it('rotates a wall with a tilted Axis and implicit RefDirection from its fill, and one compound undo restores the original record', async () => {
    const store = await parseFixture();
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);
    const originalAxisAttrs = readAttributes(store, view, editor, AXIS_PLACEMENT_TILTED);

    const result = recordCompoundMutation(view, (draft) =>
      rotateProductYaw(store, draft, new StoreEditor(store, draft), WALL_TILTED_AXIS, Math.PI / 2));
    if (!result.ok) throw new Error(`rotate refused: ${result.reason}`);

    // The fill (0.8,0,-0.6) turned a quarter about Z keeps its slope.
    const axisAttrs = readAttributes(store, view, editor, AXIS_PLACEMENT_TILTED);
    expect(asExpressIdRef(axisAttrs?.[1])).toBe(71);
    const refDirectionId = asExpressIdRef(axisAttrs?.[2]);
    expect(refDirectionId).not.toBeNull();
    expectClose(readAttributes(store, view, editor, refDirectionId!)?.[0], [0, 0.8, -0.6]);
    expect(readAttributes(store, view, editor, 71)?.[0]).toEqual(TILTED_AXIS);
    // Only the RefDirection is created: the explicit Axis is kept as is.
    expect(view.getNewEntities().map((e) => [e.type, e.expressId])).toEqual([['IfcDirection', refDirectionId]]);

    undoRecordedMutationOperations(view, 1, () => {
      throw new Error('rotate must record one compound operation');
    });
    expect(view.getNewEntities()).toEqual([]);
    expect(view.getMutations()).toEqual([]);
    expect(readAttributes(store, view, editor, AXIS_PLACEMENT_TILTED)).toEqual(originalAxisAttrs);
    expect(resolveRotationState(store, view, editor, WALL_TILTED_AXIS)?.refDirectionId).toBeNull();
  });

  it('turns an implicit-RefDirection wall through transformElementsInStore, and one compound undo restores it', async () => {
    // hello-wall's wall #1222 sits on storey #42 through #1235 -> #1234; its
    // placement is rewritten to the implicit form parsed files use.
    const sample = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url), 'utf8');
    const implicit = sample.replace('#1234=IFCAXIS2PLACEMENT3D(#1231,#1232,#1233);', '#1234=IFCAXIS2PLACEMENT3D(#1231,$,$);');
    expect(implicit).not.toBe(sample);
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(implicit).buffer as ArrayBuffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);
    const originalAxisAttrs = readAttributes(store, view, editor, 1234);
    expect(resolveRotationState(store, view, editor, 1222)?.refDirectionId).toBeNull();

    recordCompoundMutation(view, (draft) => transformElementsInStore({
      dataStore: store, view: draft, editor: new StoreEditor(store, draft),
      selected: [1222], op: { kind: 'rotate', pivot: [0, 0], angle: Math.PI / 2 },
    }));

    const turned = resolveRotationState(store, view, editor, 1222);
    expect(turned?.refDirectionId).not.toBeNull();
    expect(turned?.yawZ).toBeCloseTo(Math.PI / 2, 12);
    expectClose(readAttributes(store, view, editor, turned!.axisDirectionId!)?.[0], [0, 0, 1]);

    undoRecordedMutationOperations(view, 1, () => {
      throw new Error('the transform must record one compound operation');
    });
    expect(view.getNewEntities()).toEqual([]);
    expect(view.getMutations()).toEqual([]);
    expect(readAttributes(store, view, editor, 1234)).toEqual(originalAxisAttrs);
  });
});
