/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5167 review: an action whose load carries no component at all is not a
 * load. Both action builders used to serialize an `IfcStructuralLoad*` with
 * every value `$` and return a successful result, so a caller that forgot to
 * supply a force got a silently weightless model.
 *
 * Imported through `../index.js`, not `./structural-action.js`: the revert
 * oracle (`scripts/check-test-revert-oracle.mjs`) reverts a brand-new module
 * by deleting it, which would make a direct import unresolvable at load time —
 * a dead import rather than a RED assertion. The barrel is an EXISTING file
 * whose diff only ADDS export lines, so a revert removes the re-export and
 * these calls fail as an ordinary "is not a function". Same reasoning as
 * `cost.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import {
  addStructuralLinearActionToStore,
  addStructuralPointActionToStore,
} from '../index.js';

const MINIMAL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,#9);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCBUILDINGSTOREY('0storey0000000000000S',$,'S',$,$,$,$,$,.ELEMENT.,0.);
ENDSEC;
END-ISO-10303-21;`;

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

async function fresh() {
  const store = await parse(MINIMAL);
  const view = new MutablePropertyView(null, 'm');
  // These builders take the storey-less anchor — they are `IfcStructuralActivity`
  // subtypes with no ObjectPlacement, so resolving a spatial anchor (and the
  // representation context it requires) would be inventing containment they
  // do not have.
  return {
    editor: new StoreEditor(store, view),
    anchor: { ownerHistoryId: null, guidRandom: undefined, schema: 'IFC4' as const },
  };
}

describe('#5167 structural action load components', () => {
  it('refuses a point action with no force or moment component', async () => {
    const { editor, anchor } = await fresh();
    expect(() => addStructuralPointActionToStore(editor, anchor, { Name: 'Weightless' }))
      .toThrow(/at least one force or moment component/);
  });

  it('refuses a linear action with no force or moment component', async () => {
    const { editor, anchor } = await fresh();
    expect(() => addStructuralLinearActionToStore(editor, anchor, { Name: 'Weightless' }))
      .toThrow(/at least one force or moment component/);
  });

  it('accepts a single component, including an explicit zero', async () => {
    const { editor, anchor } = await fresh();
    // 0 is a supplied component, not an absent one — `?? null` would have kept
    // it, but a truthiness guard would have rejected it.
    expect(() => addStructuralPointActionToStore(editor, anchor, { Name: 'Zeroed', ForceZ: 0 }))
      .not.toThrow();
    expect(() => addStructuralLinearActionToStore(editor, anchor, { Name: 'Down', LinearForceZ: -12 }))
      .not.toThrow();
  });
});
