/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Direct coverage for {@link extractPropertyRelFast}, the byte-level scanner
 * behind IfcRelDefinesByProperties / IfcRelAssociates{Material,Classification,
 * Document} extraction. Previously untested.
 */

import { describe, expect, it } from 'vitest';
import { extractPropertyRelFast, extractRelFast } from '../src/columnar-parser-relationships.js';

function toBuf(step: string): Uint8Array {
  return new TextEncoder().encode(step);
}

describe('extractPropertyRelFast', () => {
  it('reads a single-ref RelatingPropertyDefinition (the common case)', () => {
    const buf = toBuf("#1=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#10,#11),#20);");
    const r = extractPropertyRelFast(buf, 0, buf.length);
    expect(r).toEqual({ relatedObjects: [10, 11], relatingDefs: [20] });
  });

  // RelatingPropertyDefinition is typed IfcPropertySetDefinitionSelect, whose
  // second alternative IfcPropertySetDefinitionSet is `SET [1:?] OF
  // IfcPropertySetDefinition` — schema-legal in both IFC4 and IFC4X3 — and is
  // written as a parenthesised ref list, e.g. `(#20,#21)`, not a bare `#20`.
  it('reads a grouped (SET-valued) RelatingPropertyDefinition instead of dropping the relationship', () => {
    const buf = toBuf("#1=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#10,#11),(#20,#21));");
    const r = extractPropertyRelFast(buf, 0, buf.length);
    expect(r).not.toBeNull();
    expect(r).toEqual({ relatedObjects: [10, 11], relatingDefs: [20, 21] });
  });

  it('reads a single-ref RelatingMaterial (IfcRelAssociatesMaterial)', () => {
    const buf = toBuf('#1=IFCRELASSOCIATESMATERIAL($,$,$,$,(#10),#30);');
    const r = extractPropertyRelFast(buf, 0, buf.length);
    expect(r).toEqual({ relatedObjects: [10], relatingDefs: [30] });
  });

  it('returns null when RelatedObjects is empty', () => {
    const buf = toBuf('#1=IFCRELDEFINESBYPROPERTIES($,$,$,$,(),#20);');
    expect(extractPropertyRelFast(buf, 0, buf.length)).toBeNull();
  });

  it('returns null when RelatingPropertyDefinition is absent ($)', () => {
    const buf = toBuf('#1=IFCRELDEFINESBYPROPERTIES($,$,$,$,(#10),$);');
    expect(extractPropertyRelFast(buf, 0, buf.length)).toBeNull();
  });
});

describe('extractRelFast: IFCRELCONNECTSPORTTOELEMENT / IFCRELCONNECTSPORTS', () => {
  it('reads the two single-ref ends for IfcRelConnectsPortToElement', () => {
    const buf = toBuf("#1=IFCRELCONNECTSPORTTOELEMENT('g',$,$,$,#5,#6);");
    const r = extractRelFast(buf, 0, buf.length, 'IFCRELCONNECTSPORTTOELEMENT');
    expect(r).toEqual({ relatingObject: 5, relatedObjects: [6] });
  });

  it('reads RelatingPort/RelatedPort and ignores the optional trailing RealizingElement', () => {
    const buf = toBuf("#1=IFCRELCONNECTSPORTS('g',$,$,$,#5,#6,#7);");
    const r = extractRelFast(buf, 0, buf.length, 'IFCRELCONNECTSPORTS');
    expect(r).toEqual({ relatingObject: 5, relatedObjects: [6] });
  });
});

describe('extractRelFast: IFCRELCONTAINEDINSPATIALSTRUCTURE', () => {
  it('reads RelatedObjects (list) then RelatingObject (single)', () => {
    const buf = toBuf("#1=IFCRELCONTAINEDINSPATIALSTRUCTURE('g',$,$,$,(#10,#11),#5);");
    const r = extractRelFast(buf, 0, buf.length, 'IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(r).toEqual({ relatingObject: 5, relatedObjects: [10, 11] });
  });
});
