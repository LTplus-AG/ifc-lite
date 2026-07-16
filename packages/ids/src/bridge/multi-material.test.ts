/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS material facet vs multiple IfcRelAssociatesMaterial (#1755 follow-up).
 *
 * An element may carry several material associations. The accessor previously
 * surfaced only the single map winner, so an IDS material requirement
 * satisfied by the element's OTHER association false-failed. getMaterials now
 * flattens every association.
 *
 * Full-pipeline store (scan → parseLite) so the relationship graph carries the
 * real AssociatesMaterial edges.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import type { EntityRef } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';

async function parse(ifc: string) {
  const source = new TextEncoder().encode(ifc);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: EntityRef[] = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
}

// Wall #100: primary association = layer set (Brick), SECOND association =
// plain IfcMaterial 'Fireproofing' via a later rel.
const IFC = `#100=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,$);
#300=IFCMATERIAL('Brick',$,$);
#301=IFCMATERIAL('Fireproofing',$,$);
#310=IFCMATERIALLAYER(#300,0.2,$,'Core',$,$,$);
#312=IFCMATERIALLAYERSET((#310),'Wall Buildup',$);
#330=IFCRELASSOCIATESMATERIAL('0RelMat000000000000001',$,$,$,(#100),#312);
#331=IFCRELASSOCIATESMATERIAL('0RelMat000000000000002',$,$,$,(#100),#301);`;

describe('IDS getMaterials — multiple associations', () => {
  it('surfaces material names from EVERY IfcRelAssociatesMaterial', async () => {
    const store = await parse(IFC);
    const accessor = createDataAccessor(store);
    const names = accessor.getMaterials!(100).map((m) => m.name);

    // First association (layer set) fans out to its member material...
    expect(names).toContain('Brick');
    // ...and the SECOND association must be visible too — an IDS requirement
    // of material 'Fireproofing' previously false-failed here.
    expect(names).toContain('Fireproofing');
  });
});
