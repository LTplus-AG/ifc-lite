/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { extractRelFast } from '../src/columnar-parser-relationships.js';

function bytes(step: string): Uint8Array {
  return new TextEncoder().encode(step);
}

function extract(typeUpper: string, step: string) {
  const buf = bytes(step);
  return extractRelFast(buf, 0, buf.length, typeUpper);
}

describe('extractRelFast — connection relationships', () => {
  it('reads RelatingElement / RelatedElement from IfcRelConnectsElements', () => {
    // attrs (0-based): 0 GlobalId, 1 OwnerHistory, 2 Name, 3 Description,
    // 4 ConnectionGeometry, 5 RelatingElement, 6 RelatedElement
    const step = `#1=IFCRELCONNECTSELEMENTS('guid',#2,$,$,$,#10,#20);`;
    const out = extract('IFCRELCONNECTSELEMENTS', step);
    expect(out).toEqual({ relatingObject: 10, relatedObjects: [20] });
  });

  it('reads RelatingStructuralMember / RelatedStructuralConnection from IfcRelConnectsStructuralMember', () => {
    // attrs (0-based): 0-3 inherited, 4 RelatingStructuralMember,
    // 5 RelatedStructuralConnection, 6 AppliedCondition, etc.
    const step = `#1=IFCRELCONNECTSSTRUCTURALMEMBER('guid',#2,$,$,#11,#22,$,$,$,$);`;
    const out = extract('IFCRELCONNECTSSTRUCTURALMEMBER', step);
    expect(out).toEqual({ relatingObject: 11, relatedObjects: [22] });
  });

  it('reads relating/related from IfcRelConnectsWithRealizingElements', () => {
    // Same shape as IfcRelConnectsElements at attrs 4-6, with RealizingElements
    // and ConnectionType after.
    const step = `#1=IFCRELCONNECTSWITHREALIZINGELEMENTS('guid',#2,$,$,$,#33,#44,(#5,#6),'STRUCTURAL');`;
    const out = extract('IFCRELCONNECTSWITHREALIZINGELEMENTS', step);
    expect(out).toEqual({ relatingObject: 33, relatedObjects: [44] });
  });
});
