/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcRoot.OwnerHistory` is OPTIONAL from IFC4 onward but MANDATORY in
 * IFC2X3. `resolveSpatialAnchor`'s own comment ("OwnerHistory is OPTIONAL
 * from IFC4 onward") only states the IFC4+ half of that rule, and the
 * lookup itself (`findOwnerHistoryId`) is schema-blind: it returns `null`
 * whenever the store has no `IFCOWNERHISTORY` entity, regardless of schema.
 *
 * For an IFC2X3 store that is missing `IfcOwnerHistory` (a malformed or
 * hand-edited file — real IFC2X3 files virtually always carry one, but
 * nothing here enforces that), every downstream builder
 * (`addWallToStore`, `addBeamToStore`, ...) calls `ownerHistoryRef(null)`,
 * which unconditionally emits `$`. That is a mandatory attribute emitted
 * as `$` in an IFC2X3 file — a malformed file that most parsers still
 * accept silently.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore } from './wall.js';

/** Minimal IFC2X3 model with one storey and NO IfcOwnerHistory entity. */
const IFC2X3_NO_OWNER_HISTORY = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#7),#9);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#8=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#7,$,.MODEL_VIEW.,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
ENDSEC;
END-ISO-10303-21;`;

describe('resolveSpatialAnchor + addWallToStore: IFC2X3 without IfcOwnerHistory', () => {
  it('refuses to resolve an anchor that would make addWallToStore emit a mandatory OwnerHistory as $', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(IFC2X3_NO_OWNER_HISTORY).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );

    // resolveSpatialAnchor must refuse outright rather than silently hand
    // back { schema: 'IFC2X3', ownerHistoryId: null } — a combination every
    // builder would turn into a malformed IFC2X3 element ($ for a mandatory
    // attribute).
    expect(() => resolveSpatialAnchor(store, 30)).toThrow(/OwnerHistory/);
  });

  it('control: IFC4 with no IfcOwnerHistory still resolves fine (OwnerHistory is optional there)', async () => {
    const ifc4NoOwnerHistory = IFC2X3_NO_OWNER_HISTORY.replace("FILE_SCHEMA(('IFC2X3'));", "FILE_SCHEMA(('IFC4'));");
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(ifc4NoOwnerHistory).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );

    const anchor = resolveSpatialAnchor(store, 30);
    expect(anchor.schema).toBe('IFC4');
    expect(anchor.ownerHistoryId).toBeNull();

    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);
    const result = addWallToStore(editor, anchor, {
      Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3,
    });
    const wall = view.getNewEntities().find((e) => e.expressId === result.wallId);
    // Correctly `$` — OwnerHistory is optional from IFC4 onward.
    expect(wall?.attributes[1]).toBeNull();
  });
});
