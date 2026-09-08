/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { EntityExtractor } from './entity-extractor.js';
import { RelationshipExtractor } from './relationship-extractor.js';
import type { EntityRef, IfcEntity } from './types.js';

/** Build one entity map entry by extracting a single STEP record. */
function extract(expressId: number, type: string, record: string): IfcEntity {
  const bytes = new TextEncoder().encode(record);
  const ref: EntityRef = {
    expressId,
    type,
    byteOffset: 0,
    byteLength: bytes.length,
    lineNumber: 1,
  };
  const entity = new EntityExtractor(bytes).extractEntity(ref);
  if (!entity) throw new Error(`failed to extract #${expressId}`);
  return entity;
}

describe('RelationshipExtractor / IfcRelAssociatesMaterial', () => {
  // Schema (IFC4, IFC4_ADD2_TC1.exp):
  //   ENTITY IfcRelAssociates SUBTYPE OF (IfcRelationship);
  //     RelatedObjects : SET [1:?] OF IfcDefinitionSelect;      -- inherited, slot [4]
  //   ENTITY IfcRelAssociatesMaterial SUBTYPE OF (IfcRelAssociates);
  //     RelatingMaterial : IfcMaterialSelect;                    -- own attribute, slot [5]
  //
  // So attribute [4] is the RELATED OBJECTS LIST and [5] is the single
  // RELATING MATERIAL reference — the reverse of IfcRelAggregates, where [4]
  // is the single RelatingObject and [5] is the RelatedObjects list. The
  // extractor's "standard" branch (relatingObject=[4], relatedObjects=[5])
  // only holds for the IfcRelAggregates shape and silently mis-reads
  // IfcRelAssociatesMaterial.
  it('extracts RelatedObjects (list, slot 4) and RelatingMaterial (single ref, slot 5)', () => {
    const entities = new Map<number, IfcEntity>();
    entities.set(
      1,
      extract(
        1,
        'IFCRELASSOCIATESMATERIAL',
        `#1=IFCRELASSOCIATESMATERIAL('3xJf$b$MP7XLbaHy6XT9EM',$,$,$,(#10,#11),#20);`,
      ),
    );

    const relationships = new RelationshipExtractor(entities).extractRelationships();
    const rel = relationships.find((r) => r.type === 'IFCRELASSOCIATESMATERIAL');

    expect(rel).toBeDefined();
    expect(rel?.relatingObject).toBe(20); // the material reference, #20
    expect(rel?.relatedObjects).toEqual([10, 11]); // the related elements
  });
});
