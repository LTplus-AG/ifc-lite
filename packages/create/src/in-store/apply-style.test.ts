/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `applyStylesInStore` has no coverage at all. It is the sole caller of
 * `emitSurfaceStyle`, so exercising it also exercises that helper's colour
 * clamp / transparency rounding / IFC2X3 wrapper branches, which likewise
 * have no direct tests.
 *
 * Fixture is a real parsed store (`IfcParser().parseColumnar`) rather than a
 * synthetic `MutationStoreShape`: `applyStylesInStore` reads pre-existing
 * source entities through `EntityExtractor(store.source)`, which a
 * `MutationStoreShape`-only fixture (the pattern used by `wall.test.ts` etc.)
 * cannot serve.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { applyStylesInStore } from './apply-style.js';

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
 * One product (#100) with a direct (non-mapped) representation chain down to
 * leaf item #112, which already carries a styled item (#150 -> #151..#153).
 * #101 has no Representation at all; #102 has one whose Items list is empty.
 * #103/#104 are two occurrences that share one mapped representation's leaf
 * item (#122) via two distinct IfcMappedItem instances (#123, #127) — the
 * realistic "type occurrences share one map" shape.
 */
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${BOILERPLATE}
#100=IFCWALL('guidA0000000000000000A',$,'WallA',$,$,#20,#110,$,.STANDARD.);
#110=IFCPRODUCTDEFINITIONSHAPE($,$,(#111));
#111=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#112));
#112=IFCEXTRUDEDAREASOLID($,$,$,1.);

#150=IFCSTYLEDITEM(#112,(#151),$);
#151=IFCSURFACESTYLE($,.BOTH.,(#152));
#152=IFCSURFACESTYLESHADING(#153,0.);
#153=IFCCOLOURRGB($,0.5,0.5,0.5);

#101=IFCWALL('guidB0000000000000000B',$,'WallB',$,$,#20,$,$,.STANDARD.);

#102=IFCWALL('guidC0000000000000000C',$,'WallC',$,$,#20,#113,$,.STANDARD.);
#113=IFCPRODUCTDEFINITIONSHAPE($,$,(#114));
#114=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',());

#120=IFCREPRESENTATIONMAP(#6,#121);
#121=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#122));
#122=IFCEXTRUDEDAREASOLID($,$,$,1.);

#123=IFCMAPPEDITEM(#120,#124);
#124=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#5,1.,$);
#125=IFCPRODUCTDEFINITIONSHAPE($,$,(#126));
#126=IFCSHAPEREPRESENTATION(#7,'Body','MappedRepresentation',(#123));
#103=IFCWALL('guidD0000000000000000D',$,'WallD1',$,$,#20,#125,$,.STANDARD.);

#127=IFCMAPPEDITEM(#120,#128);
#128=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#5,1.,$);
#129=IFCPRODUCTDEFINITIONSHAPE($,$,(#130));
#130=IFCSHAPEREPRESENTATION(#7,'Body','MappedRepresentation',(#127));
#104=IFCWALL('guidE0000000000000000E',$,'WallD2',$,$,#20,#129,$,.STANDARD.);
ENDSEC;
END-ISO-10303-21;`;

async function parseFixture(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(
    new TextEncoder().encode(MODEL).buffer as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

function makeEditor(store: IfcDataStore): StoreEditor {
  const view = new MutablePropertyView(null, 'm1');
  return new StoreEditor(store, view);
}

function byId(editor: StoreEditor) {
  return new Map(editor.getNewEntities().map((e) => [e.expressId, e]));
}

describe('applyStylesInStore', () => {
  it('colours a direct (non-mapped) leaf item and replaces its existing style by default', async () => {
    const store = await parseFixture();
    // Built inline rather than via makeEditor because the tombstone assertion
    // below needs the view: `isDeleted` lives on MutablePropertyView, and
    // StoreEditor does not re-expose it.
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const [result] = applyStylesInStore(editor, store, [
      { products: [100], color: { red: 1, green: 0, blue: 0, alpha: 1 } },
    ]);

    expect(result.productsWithoutGeometry).toEqual([]);
    expect(result.styledItemIds).toHaveLength(1);
    expect(result.replacedStyledItemIds).toEqual([150]);
    expect(result.keptExistingItemIds).toEqual([]);
    expect(result.surfaceStyleId).not.toBeNull();

    const entities = byId(editor);
    const styledItem = entities.get(result.styledItemIds[0]!);
    expect(styledItem?.type).toBe('IfcStyledItem');
    expect(styledItem?.attributes[0]).toBe('#112');
    // Styles, on the DEFAULT (IFC4) path, references the IfcSurfaceStyle
    // directly. IFC2X3 instead wraps it in an IfcPresentationStyleAssignment,
    // and nothing here asserted which of the two we emitted -- forcing the
    // wrapper on unconditionally left the suite fully green.
    expect(styledItem?.attributes[1]).toEqual([`#${result.surfaceStyleId}`]);

    const style = entities.get(result.surfaceStyleId!);
    expect(style?.type).toBe('IfcSurfaceStyle');
    const shadingRef = (style?.attributes[2] as string[])[0]!;
    const shading = entities.get(Number(shadingRef.replace('#', '')));
    expect(shading?.attributes[1]).toEqual({ real: 0 }); // transparency = 1 - alpha(1)

    const colourRef = shading?.attributes[0] as string;
    const colour = entities.get(Number(colourRef.replace('#', '')));
    expect(colour?.attributes).toEqual([null, { real: 1 }, { real: 0 }, { real: 0 }]);

    // The old chain (#151/#152/#153) is untouched — only the styled item is
    // tombstoned, per the documented "detached, not deleted" contract.
    // `getNewEntity` reads the newEntities map, and #150 is a SOURCE entity
    // that was never added to it -- so it returned null whether or not the
    // removal happened, and the assertion could not fail. `isDeleted` reads
    // the tombstone itself.
    expect(view.isDeleted(150)).toBe(true);
  });

  it('leaves an already-styled item alone when replaceExisting is false (the do-nothing path)', async () => {
    const store = await parseFixture();
    const editor = makeEditor(store);

    const [result] = applyStylesInStore(editor, store, [
      { products: [100], color: { red: 0, green: 1, blue: 0 } },
    ], { replaceExisting: false });

    expect(result.keptExistingItemIds).toEqual([112]);
    expect(result.styledItemIds).toEqual([]);
    expect(result.replacedStyledItemIds).toEqual([]);
    // Nothing needed styling, so no orphan IfcSurfaceStyle/colour chain.
    expect(result.surfaceStyleId).toBeNull();
    expect(editor.getNewEntities()).toHaveLength(0);
  });

  it('creates no entities at all for a batch that reaches no geometry', async () => {
    const store = await parseFixture();
    const editor = makeEditor(store);

    const [result] = applyStylesInStore(editor, store, [
      { products: [101, 102], color: { red: 1, green: 1, blue: 1 } },
    ]);

    expect(result.productsWithoutGeometry).toEqual([101, 102]);
    expect(result.surfaceStyleId).toBeNull();
    expect(result.styledItemIds).toEqual([]);
    expect(editor.getNewEntities()).toHaveLength(0);
  });

  it('follows IfcMappedItem to style shared geometry once for every occurrence (default)', async () => {
    const store = await parseFixture();
    const editor = makeEditor(store);

    const [result] = applyStylesInStore(editor, store, [
      { products: [103, 104], color: { red: 0, green: 0, blue: 1 } },
    ]);

    expect(result.productsWithoutGeometry).toEqual([]);
    expect(result.styledItemIds).toHaveLength(1);
    const styledItem = byId(editor).get(result.styledItemIds[0]!);
    expect(styledItem?.attributes[0]).toBe('#122'); // the shared leaf, not either mapped item
  });

  it('styles each IfcMappedItem separately when followMappedItems is false', async () => {
    const store = await parseFixture();
    const editor = makeEditor(store);

    const [result] = applyStylesInStore(editor, store, [
      { products: [103, 104], color: { red: 0, green: 0, blue: 1 } },
    ], { followMappedItems: false });

    expect(result.styledItemIds).toHaveLength(2);
    const targets = byId(editor)
      .get(result.styledItemIds[0]!) && result.styledItemIds
      .map((id) => byId(editor).get(id)?.attributes[0]);
    expect(new Set(targets)).toEqual(new Set(['#123', '#127']));
  });

  it('builds the IFC2X3 IfcPresentationStyleAssignment wrapper when the target schema is IFC2X3', async () => {
    const store = await parseFixture();
    const editor = makeEditor(store);

    const [result] = applyStylesInStore(editor, store, [
      { products: [100], color: { red: 1, green: 1, blue: 0 } },
    ], { schema: 'IFC2X3' });

    const entities = byId(editor);
    const styledItem = entities.get(result.styledItemIds[0]!);
    const stylesRef = (styledItem?.attributes[1] as string[])[0]!;
    const assignment = entities.get(Number(stylesRef.replace('#', '')));
    expect(assignment?.type).toBe('IfcPresentationStyleAssignment');
    expect(assignment?.attributes[0]).toEqual([`#${result.surfaceStyleId}`]);
  });

  it('garbage-collects a fully-replaced style chain across two calls', async () => {
    const store = await parseFixture();
    const editor = makeEditor(store);

    const [first] = applyStylesInStore(editor, store, [
      { products: [100], color: { red: 1, green: 0, blue: 0 } },
    ]);
    const firstStyleId = first.surfaceStyleId!;
    expect(editor.getNewEntity(firstStyleId)).not.toBeNull();

    // Restyle the same geometry: the first call's IfcStyledItem is
    // tombstoned, so its whole colour chain should be swept too.
    applyStylesInStore(editor, store, [
      { products: [100], color: { red: 0, green: 0, blue: 1 } },
    ]);

    expect(editor.getNewEntity(first.styledItemIds[0]!)).toBeNull();
    expect(editor.getNewEntity(firstStyleId)).toBeNull();
  });

  it('reconciles two batches in one call so the losing batch reports no surviving style', async () => {
    const store = await parseFixture();
    const editor = makeEditor(store);

    const [batchRed, batchBlue] = applyStylesInStore(editor, store, [
      { products: [100], color: { red: 1, green: 0, blue: 0 } },
      { products: [100], color: { red: 0, green: 0, blue: 1 } },
    ]);

    // Both batches target the same product/leaf item; the later batch wins.
    expect(batchRed!.styledItemIds).toEqual([]);
    expect(batchRed!.surfaceStyleId).toBeNull();
    expect(batchBlue!.styledItemIds).toHaveLength(1);
    expect(batchBlue!.surfaceStyleId).not.toBeNull();

    const styledItem = byId(editor).get(batchBlue!.styledItemIds[0]!);
    expect(styledItem?.attributes[0]).toBe('#112');
  });

  it('clamps out-of-range channels and rounds transparency at the alpha=0 boundary', async () => {
    const store = await parseFixture();
    const editor = makeEditor(store);

    const [result] = applyStylesInStore(editor, store, [
      { products: [100], color: { red: 2, green: -1, blue: 0.5, alpha: 0 } },
    ]);

    const entities = byId(editor);
    const style = entities.get(result.surfaceStyleId!);
    const shadingRef = (style?.attributes[2] as string[])[0]!;
    const shading = entities.get(Number(shadingRef.replace('#', '')));
    expect(shading?.attributes[1]).toEqual({ real: 1 }); // transparency = 1 - alpha(0)

    const colourRef = shading?.attributes[0] as string;
    const colour = entities.get(Number(colourRef.replace('#', '')));
    expect(colour?.attributes).toEqual([null, { real: 1 }, { real: 0 }, { real: 0.5 }]);
  });
});
