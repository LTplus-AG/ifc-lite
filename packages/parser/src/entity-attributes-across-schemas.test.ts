/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `extractAllEntityAttributes` names attributes across the bundled schema union,
 * not through the IFC4 codegen pin alone.
 *
 * The pin answers an **empty** attribute list for the 251 classes it does not
 * carry — the IFC2X3 ones IFC4 dropped and the whole IFC4X3 infrastructure
 * vocabulary. Empty, not wrong: every caller that looks an attribute up by name
 * finds nothing and cannot distinguish that from an unset slot. The three
 * callers that hurt are the model-diff fingerprint adapters, the IDS
 * `PredefinedType` facet and the viewer's PredefinedType display, all of which
 * silently answered "no PredefinedType" for every IFC4.3 infrastructure element.
 *
 * Both halves are asserted, because the fix is only safe if the second holds:
 * the union must ADD classes without moving the answer for a class the pin
 * already knew — a diff fingerprint is derived from these names, so a changed
 * answer on an IFC4 class would move every hash in every stored identity map.
 */

import { describe, expect, it } from 'vitest';
import { extractAllEntityAttributes } from './columnar-parser.js';
import { IfcParser } from './index.js';

const IFC4X3_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3'));
ENDSEC;
DATA;
#1= IFCPROJECT('0PROJ00000000000000000',$,'Proj',$,$,$,$,$,$);
#50= IFCCOURSE('0COUR00000000000000000',$,'Base course',$,$,$,$,'c1',.PAVING.);
#51= IFCSIGNAL('0SIGN00000000000000000',$,'Signal',$,$,$,$,'s1',.VISUAL.);
#52= IFCBUILDINGELEMENTPROXY('0PROX00000000000000000',$,'Marker',$,$,$,$,'x1',.ELEMENT.);
ENDSEC;
END-ISO-10303-21;
`;

async function attributesById(): Promise<Map<number, Map<string, unknown>>> {
  const bytes = new TextEncoder().encode(IFC4X3_MODEL);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
  const byId = new Map<number, Map<string, unknown>>();
  for (const id of [50, 51, 52]) {
    byId.set(
      id,
      new Map(extractAllEntityAttributes(store, id).map((a) => [a.name, a.value])),
    );
  }
  return byId;
}

describe('extractAllEntityAttributes across the bundled schema union', () => {
  it('names PredefinedType on IFC4X3-only classes the IFC4 pin does not carry', async () => {
    const byId = await attributesById();

    // IfcCourse and IfcSignal exist only in IFC4X3. Before the union lookup
    // these entities produced NO attributes at all, so `PredefinedType` was
    // absent and a diff could not see it change.
    expect(byId.get(50)?.get('PredefinedType')).toBe('PAVING');
    expect(byId.get(51)?.get('PredefinedType')).toBe('VISUAL');
  });

  it('still names Name and Tag on those classes, at the right positions', async () => {
    const byId = await attributesById();

    expect(byId.get(50)?.get('Name')).toBe('Base course');
    expect(byId.get(50)?.get('Tag')).toBe('c1');
  });

  it('leaves a pinned IFC4 class answering exactly as before', async () => {
    const byId = await attributesById();

    // `IfcBuildingElementProxy` is in the pin, so the union must not be
    // consulted at all and this answer must be the pre-existing one.
    expect(byId.get(52)?.get('PredefinedType')).toBe('ELEMENT');
    expect(byId.get(52)?.get('Name')).toBe('Marker');
    expect(byId.get(52)?.get('Tag')).toBe('x1');
  });
});
