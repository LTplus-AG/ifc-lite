/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';
import { SCHEMA_REGISTRY, type IfcDataStore } from '@ifc-lite/parser';
import { MATERIAL_DEF_TYPES, isMaterialDefinitionType } from './materialDefinitionTypes';
import { buildMaterialTree } from '@/components/viewer/hierarchy/treeDataBuilder';

/**
 * Derive the truth from the bundled EXPRESS schema instead of restating the
 * table: expand every root of the `IfcMaterialSelect` SELECT to its concrete
 * (non-ABSTRACT) subtypes. A table that restates its own contents cannot catch
 * drift — this one fails the moment the schema and the table disagree.
 */
function deriveSelectMembers(selectName: string): Set<string> {
  const roots = SCHEMA_REGISTRY.selects[selectName];
  assert.ok(Array.isArray(roots) && roots.length > 0, `${selectName} must exist in SCHEMA_REGISTRY.selects`);

  const childrenOf = new Map<string, string[]>();
  for (const meta of Object.values(SCHEMA_REGISTRY.entities)) {
    if (!meta.parent) continue;
    const siblings = childrenOf.get(meta.parent);
    if (siblings) siblings.push(meta.name);
    else childrenOf.set(meta.parent, [meta.name]);
  }

  const concrete = new Set<string>();
  const stack = [...roots];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const meta = SCHEMA_REGISTRY.entities[name];
    // A SELECT root may be a defined TYPE rather than an ENTITY; only entities
    // participate in the subtype expansion.
    if (meta && !meta.isAbstract) concrete.add(name.toUpperCase());
    stack.push(...(childrenOf.get(name) ?? []));
  }
  return concrete;
}

describe('MATERIAL_DEF_TYPES — derived from IfcMaterialSelect, both directions', () => {
  const derived = deriveSelectMembers('IfcMaterialSelect');

  it('the derivation is not vacuous', () => {
    // Named required members, not a magic count floor: one from each of the
    // three SELECT roots plus the three IFC4 subtypes whose omission from the
    // panel's hand-copy was the bug this table replaces.
    for (const required of [
      'IFCMATERIAL',                        // IfcMaterialDefinition root
      'IFCMATERIALLIST',                    // IfcMaterialList root
      'IFCMATERIALLAYERSETUSAGE',           // IfcMaterialUsageDefinition root
      'IFCMATERIALCONSTITUENT',
      'IFCMATERIALLAYERWITHOFFSETS',
      'IFCMATERIALPROFILESETUSAGETAPERING',
    ]) {
      assert.ok(derived.has(required), `schema derivation must yield ${required}`);
    }
  });

  it('every concrete IfcMaterialSelect member is in the table', () => {
    const missing = [...derived].filter((name) => !MATERIAL_DEF_TYPES.has(name)).sort();
    assert.deepStrictEqual(missing, [], 'schema members absent from MATERIAL_DEF_TYPES');
  });

  it('every table entry is a real, concrete IfcMaterialSelect member', () => {
    const extra = [...MATERIAL_DEF_TYPES].filter((name) => !derived.has(name)).sort();
    assert.deepStrictEqual(extra, [], 'MATERIAL_DEF_TYPES entries the schema does not back');
  });

  it('rejects non-members (negative control)', () => {
    // IfcMaterialProperties and IfcMaterialDefinitionRepresentation are real
    // IFC entities with material-ish names that are NOT IfcMaterialSelect
    // members; IfcMaterialDefinition itself is ABSTRACT and never instantiated.
    for (const name of ['IFCWALL', 'IFCMATERIALPROPERTIES', 'IFCMATERIALDEFINITIONREPRESENTATION', 'IFCMATERIALDEFINITION']) {
      assert.ok(!MATERIAL_DEF_TYPES.has(name), `${name} must not be a material definition type`);
      assert.ok(!isMaterialDefinitionType(name), `isMaterialDefinitionType('${name}') must be false`);
    }
    assert.ok(!isMaterialDefinitionType(null));
    assert.ok(!isMaterialDefinitionType(''));
  });

  it('matches raw STEP class names case-insensitively', () => {
    assert.ok(isMaterialDefinitionType('IfcMaterialConstituent'));
    assert.ok(isMaterialDefinitionType('IFCMATERIALCONSTITUENT'));
  });
});

/** STEP-lines store with a single association from `defLine`'s entity to a wall. */
function storeWithAssociation(lines: string[], defId: number, elementId: number): IfcDataStore {
  const text = lines.join('\n');
  const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
  let cursor = 0;
  for (const line of lines) {
    const start = text.indexOf(line, cursor);
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/)!;
    byId.set(parseInt(match[1], 10), {
      expressId: parseInt(match[1], 10),
      type: match[2],
      byteOffset: start,
      byteLength: line.length,
      lineNumber: 1,
    });
    cursor = start + line.length;
  }
  const rel = new RelationshipGraphBuilder();
  rel.addEdge(defId, elementId, RelationshipType.AssociatesMaterial, 100);
  return {
    source: new TextEncoder().encode(text),
    entityIndex: { byId, byType: new Map() },
    onDemandMaterialMap: new Map([[elementId, [defId]]]),
    relationships: rel.build(),
  } as unknown as IfcDataStore;
}

describe('every Materials-tab row is recognisable by the properties panel gate', () => {
  // The tab keys rows on the material usage index's leaf id. Definitions the
  // resolver has no expansion rule for (IfcMaterialConstituent on its own,
  // IfcMaterialLayerWithOffsets, ...) surface as opaque leaves carrying their
  // OWN class, so the panel gate must accept the whole select — a subset makes
  // the row a dead click: no MaterialTotalsPanel, just the generic view.
  const cases: Array<{ label: string; lines: string[]; defId: number; elementId: number }> = [
    {
      label: 'IfcMaterialConstituent',
      lines: [
        `#3=IFCWALL('w1',$,'Wall',$,$,$,$,$,$);`,
        `#10=IFCMATERIAL('Oak',$,$);`,
        `#20=IFCMATERIALCONSTITUENT('Lining',$,#10,0.6,$);`,
      ],
      defId: 20,
      elementId: 3,
    },
    {
      label: 'IfcMaterialLayerWithOffsets',
      lines: [
        `#4=IFCWALL('w2',$,'Wall',$,$,$,$,$,$);`,
        `#11=IFCMATERIAL('Steel',$,$);`,
        `#30=IFCMATERIALLAYERWITHOFFSETS(#11,0.2,$,'Core',$,$,$,.AXIS2.,(0.,0.));`,
      ],
      defId: 30,
      elementId: 4,
    },
  ];

  for (const { label, lines, defId, elementId } of cases) {
    it(`a ${label} row resolves to the material totals view`, () => {
      const ds = storeWithAssociation(lines, defId, elementId);
      const nodes = buildMaterialTree(new Map(), ds, new Set(), false, new Set([elementId]));
      assert.strictEqual(nodes.length, 1, `${label} must produce exactly one Materials-tab row`);
      const [row] = nodes;
      assert.strictEqual(row.entityExpressId, defId);
      assert.ok(
        isMaterialDefinitionType(row.ifcType),
        `the panel gate rejected the row the tab rendered (ifcType=${row.ifcType})`,
      );
    });
  }
});
