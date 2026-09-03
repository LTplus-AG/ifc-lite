/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.mutate.*` through the headless CLI context, asserted on the EXPORTED
 * STEP rather than on the overlay.
 *
 * The bug these cover did not throw and did not lose a return value: the
 * adapter answered every call with a no-op, so a script reported the edits it
 * had "made" and `bim.export.ifc` handed back the input unchanged. Reading the
 * mutation view back would have passed just as happily against the broken
 * adapter, so every assertion here goes through the export.
 */

import { describe, expect, it } from 'vitest';
import { exportStep, ifcFile, loadInlineModel } from './headless-test-helpers.js';

const MODEL = ifcFile(`#70= IFCWALL('WALL00000000000000000X',$,'Original Name',$,$,$,$,'tag',$);
#100= IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('W-01'),$);
#101= IFCPROPERTYSINGLEVALUE('Sibling',$,IFCLABEL('keep me'),$);
#102= IFCPROPERTYSET('PSET00000000000000000X',$,'Pset_WallCommon',$,(#100,#101));
#103= IFCRELDEFINESBYPROPERTIES('RELP00000000000000000X',$,$,$,(#70),#102);`);

async function loadModel() {
  const bim = await loadInlineModel(MODEL, 'mutate');
  const wall = bim.query().byType('IfcWall').first();
  if (!wall) throw new Error('fixture has no IfcWall');
  return { bim, wall };
}

describe('bim.mutate through the headless context', () => {
  it('persists setAttribute into the exported STEP', async () => {
    const { bim, wall } = await loadModel();
    bim.mutate.setAttribute(wall.ref, 'Name', 'Renamed Wall');

    const step = exportStep(bim);
    expect(step).toContain("'Renamed Wall'");
    expect(step).not.toContain("'Original Name'");
  });

  it('leaves the export untouched when nothing was mutated', async () => {
    // Guards the assertion above: it has to be the mutation that changes the
    // output, not the re-export.
    const { bim } = await loadModel();
    expect(exportStep(bim)).toContain("'Original Name'");
  });

  it('persists a new property set and keeps the siblings of an edited one', async () => {
    const { bim, wall } = await loadModel();
    bim.mutate.setProperty(wall.ref, 'Pset_FireRating', 'FireRating', 'EI 60');
    bim.mutate.setProperty(wall.ref, 'Pset_WallCommon', 'Reference', 'Generic');

    const step = exportStep(bim);
    expect(step).toContain("'Pset_FireRating'");
    expect(step).toContain("IFCLABEL('EI 60')");
    expect(step).toContain("'Generic'");
    expect(step).not.toContain("'W-01'");
    // The overlay re-emits the whole set, so a sibling that was never touched
    // has to survive the rewrite.
    expect(step).toContain("'keep me'");
  });

  it('writes a boolean as IFCBOOLEAN and an integer as IFCINTEGER, not as labels', async () => {
    // MutablePropertyView.setProperty defaults to PropertyValueType.String, so
    // an adapter that forwards the raw value writes IFCLABEL('true') here.
    const { bim, wall } = await loadModel();
    bim.mutate.setProperty(wall.ref, 'Pset_FireRating', 'FireCompartmentation', true);
    bim.mutate.setProperty(wall.ref, 'Pset_FireRating', 'Storeys', 3);
    bim.mutate.setProperty(wall.ref, 'Pset_FireRating', 'Ratio', 1.5);

    const step = exportStep(bim);
    expect(step).toContain('IFCBOOLEAN(.T.)');
    expect(step).toContain('IFCINTEGER(3)');
    expect(step).toContain('IFCREAL(1.5)');
    expect(step).not.toContain("IFCLABEL('true')");
  });

  it('persists deleteProperty', async () => {
    const { bim, wall } = await loadModel();
    bim.mutate.deleteProperty(wall.ref, 'Pset_WallCommon', 'Reference');

    const step = exportStep(bim);
    expect(step).not.toContain("'W-01'");
    expect(step).toContain("'keep me'");
  });

  // #3764's guard, and the trap in it. Refusing a write to an entity the model
  // does not hold is only correct if "the model" means the EFFECTIVE model:
  // `StoreEditor.addEntity` keeps created ids out of `store.entityIndex.byId`
  // on purpose (that index may be a `CompactEntityIndex` over immutable typed
  // arrays), so a guard that asks the base index alone rejects the ids the
  // session itself just handed out — which is the ordinary create-then-decorate
  // script, not an edge case.
  it('accepts a write to an entity created earlier in the same session', async () => {
    const { bim } = await loadModel();
    const ref = bim.store.addEntity('default', {
      type: 'IfcWall',
      attributes: ["2N1x3zzzzzzzzzzzzzzzzz", null, "'Fresh Wall'", null, null, null, null, null, null],
    });

    bim.mutate.setProperty(ref, 'Pset_FireRating', 'FireRating', 'EI 90');
    bim.mutate.setAttribute(ref, 'Name', 'Renamed Fresh Wall');

    // Asserted on the export, like every other case here: the point is that
    // the write both survives the guard and reaches the file.
    const step = exportStep(bim);
    expect(step).toContain("IFCLABEL('EI 90')");
    expect(step).toContain("'Renamed Fresh Wall'");
  });

  it('refuses a create under a model id the backend does not answer for', async () => {
    // The ref-minting side of the same guard. `bim.store.addEntity` used to echo
    // the caller's model id back verbatim, so a create under any other spelling
    // handed out a ref that `bim.mutate.*` then refused, with the entity already
    // in the overlay and in the export. docs/guide/mutations.md teaches 'arch'
    // for exactly this call, so that is the id the mistake arrives under.
    const { bim } = await loadModel();
    const wallDef = {
      type: 'IfcWall',
      attributes: ["2N1x3zzzzzzzzzzzzzzzzz", null, "'Arch Wall'", null, null, null, null, null, null],
    };

    expect(() => bim.store.addEntity('arch', wallDef)).toThrow(/Unknown modelId 'arch'/);
    // Nothing was created under the rejected id: the assert runs before the
    // StoreEditor is touched, so a refused create is not a half-done one.
    expect(exportStep(bim)).not.toContain("'Arch Wall'");
  });

  it('accepts a create under the file-name spelling and the ref it returns', async () => {
    // The other spelling `assertModel` admits. Its whole point is that the ref
    // comes back usable: create, then decorate, then export.
    const { bim } = await loadModel();
    const ref = bim.store.addEntity('model.ifc', {
      type: 'IfcWall',
      attributes: ["2N1x3zzzzzzzzzzzzzzzzz", null, "'Named Wall'", null, null, null, null, null, null],
    });

    expect(ref.modelId).toBe('model.ifc');
    bim.mutate.setProperty(ref, 'Pset_FireRating', 'FireRating', 'EI 30');
    expect(exportStep(bim)).toContain("IFCLABEL('EI 30')");
  });

  it('refuses a write to an entity removed earlier in the same session', async () => {
    // The other direction of the same asymmetry, and the reason the base index
    // is not the answer either: a tombstoned SOURCE entity is still in
    // `entityIndex.byId`, and is exported nowhere, so a write to it is dropped
    // exactly like a phantom one.
    const { bim, wall } = await loadModel();
    bim.store.removeEntity(wall.ref);

    expect(() => bim.mutate.setProperty(wall.ref, 'Pset_FireRating', 'FireRating', 'EI 90'))
      .toThrow(/no entity #70 in model 'default'/);
    expect(exportStep(bim)).not.toContain('EI 90');
  });

  it('refuses a write to an entity created and then removed in the same session', async () => {
    // A created-then-deleted id is absent from the base index AND from
    // `getNewEntities` — it is exported nowhere, so the same answer is right
    // for a reference the session itself handed out minutes earlier.
    const { bim } = await loadModel();
    const ref = bim.store.addEntity('default', {
      type: 'IfcWall',
      attributes: ["2N1x3zzzzzzzzzzzzzzzzz", null, "'Doomed Wall'", null, null, null, null, null, null],
    });
    bim.store.removeEntity(ref);

    expect(() => bim.mutate.setProperty(ref, 'Pset_FireRating', 'FireRating', 'EI 90'))
      .toThrow(/no entity #/);
  });

  it('refuses every write method for an id that is not in the model', async () => {
    const { bim } = await loadModel();
    const phantom = { modelId: 'default', expressId: 999999 };

    expect(() => bim.mutate.setProperty(phantom, 'Pset_Bogus', 'Foo', 'bar'))
      .toThrow(/setProperty: no entity #999999 in model 'default'/);
    expect(() => bim.mutate.setAttribute(phantom, 'Name', 'Ghost'))
      .toThrow(/setAttribute: no entity #999999 in model 'default'/);
    expect(() => bim.mutate.deleteProperty(phantom, 'Pset_WallCommon', 'Reference'))
      .toThrow(/deleteProperty: no entity #999999 in model 'default'/);

    // The export is the reason the throw has to be there: nothing about the
    // phantom write ever reached it, and before #3764 nothing said so.
    const step = exportStep(bim);
    expect(step).not.toContain("'Ghost'");
    expect(step).toContain("'W-01'");
  });

  it('refuses a real express id carried on an unknown model id', async () => {
    // `bim.mutate.*` forwards only `ref.expressId` into this backend's one
    // overlay, so an unchecked model id does not miss — it edits this model's
    // #70 while the caller believes it addressed another file.
    const { bim, wall } = await loadModel();

    expect(() => bim.mutate.setAttribute(
      { modelId: 'some-other-model', expressId: wall.ref.expressId }, 'Name', 'Wrong Model',
    )).toThrow(/no entity #\d+ in model 'some-other-model'/);
    expect(exportStep(bim)).toContain("'Original Name'");
  });

  it('accepts a batch and reports that there is nothing to undo', async () => {
    const { bim, wall } = await loadModel();
    bim.mutate.batch('rename', () => {
      bim.mutate.setAttribute(wall.ref, 'Name', 'Batched');
    });

    expect(exportStep(bim)).toContain("'Batched'");
    // No mutation history in a headless session; false is the honest answer.
    expect(bim.mutate.undo('default')).toBe(false);
    expect(bim.mutate.redo('default')).toBe(false);
  });
});
