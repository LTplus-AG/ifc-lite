/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Projection equivalence (#5886) for every input the production dispatcher
 * passes (#9629 review).
 *
 * The hierarchy builds the complete structure once and projects it per
 * expansion. That is only correct if the projection is row-for-row and
 * field-for-field what `buildTreeForGrouping` returns at that expansion, for
 * every grouping input, not only the plain modes `treeDataBuilder.test.ts`
 * covers: presentation layers (each layer grouping), group sub-filters,
 * authored products and georeference edits. Each variant must also change
 * the structure against its baseline, so it actually reaches the builder.
 *
 * Real STEP parsed by the columnar parser; the production dispatcher.
 */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { HierarchyMode } from '@/store';
import { buildTreeForGrouping } from './revealGlobalId.js';
import { buildPresentationLayerTree } from './presentationLayerTree.js';
import { buildUnifiedStoreys, type AuthoredProduct, type GeorefMutationsByModel } from './treeDataBuilder.js';
import { flattenVisibleHierarchy, indexHierarchyTree } from './treeProjection.js';
import type { GroupSubFilter } from './groupEntityTypes.js';
import type { LayerGrouping } from './presentationLayerGroups.js';
import type { TreeNode } from './types.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0PROJ00000000000000001',$,'Project',$,$,$,$,(#200),#300);
#2=IFCSITE('0SITE00000000000000001',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0BLDG00000000000000001',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('0STOREY000000000000001',$,'Level 0',$,$,$,$,$,.ELEMENT.,0.);
#5=IFCBUILDINGSTOREY('0STOREY000000000000002',$,'Level 1',$,$,$,$,$,.ELEMENT.,3.);
#10=IFCWALL('0WALL000000000000000010',$,'Wall A',$,$,$,#60,$,$);
#11=IFCWALL('0WALL000000000000000011',$,'Wall B',$,$,$,#61,$,$);
#12=IFCWALL('0WALL000000000000000012',$,'Wall C',$,$,$,#62,$,$);
#13=IFCSLAB('0SLAB000000000000000013',$,'Slab',$,$,$,#63,$,$);
#14=IFCDOOR('0DOOR000000000000000014',$,'Door',$,$,$,$,$,$,$,$,$,$);
#20=IFCRELAGGREGATES('0RAGG00000000000000020',$,$,$,#1,(#2));
#21=IFCRELAGGREGATES('0RAGG00000000000000021',$,$,$,#2,(#3));
#22=IFCRELAGGREGATES('0RAGG00000000000000022',$,$,$,#3,(#4,#5));
#23=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RCON00000000000000023',$,$,$,(#10,#11,#14),#4);
#24=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RCON00000000000000024',$,$,$,(#12,#13),#5);
#40=IFCDISTRIBUTIONSYSTEM('0SYST00000000000000040',$,'Supply air',$,$,$,.VENTILATION.);
#41=IFCZONE('0ZONE00000000000000041',$,'Zone A',$,$,$);
#42=IFCGROUP('0GRUP00000000000000042',$,'Misc',$,$);
#43=IFCRELASSIGNSTOGROUP('0RGRP00000000000000043',$,$,$,(#10,#11),$,#40);
#44=IFCRELASSIGNSTOGROUP('0RGRP00000000000000044',$,$,$,(#12),$,#41);
#45=IFCRELASSIGNSTOGROUP('0RGRP00000000000000045',$,$,$,(#13,#14),$,#42);
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#70));
#61=IFCPRODUCTDEFINITIONSHAPE($,$,(#71));
#62=IFCPRODUCTDEFINITIONSHAPE($,$,(#72));
#63=IFCPRODUCTDEFINITIONSHAPE($,$,(#73));
#70=IFCSHAPEREPRESENTATION(#200,'Body','SweptSolid',(#80));
#71=IFCSHAPEREPRESENTATION(#200,'Body','SweptSolid',(#81));
#72=IFCSHAPEREPRESENTATION(#200,'Body','SweptSolid',(#82));
#73=IFCSHAPEREPRESENTATION(#200,'Body','SweptSolid',(#83));
#80=IFCEXTRUDEDAREASOLID($,$,$,1.);
#81=IFCEXTRUDEDAREASOLID($,$,$,1.);
#82=IFCEXTRUDEDAREASOLID($,$,$,1.);
#83=IFCEXTRUDEDAREASOLID($,$,$,1.);
#90=IFCPRESENTATIONLAYERASSIGNMENT('A-WALL',$,(#70,#71,#72),'walls');
#91=IFCPRESENTATIONLAYERASSIGNMENT('S-SLAB',$,(#73),$);
#200=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#201,$);
#201=IFCAXIS2PLACEMENT3D(#202,$,$);
#202=IFCCARTESIANPOINT((0.,0.,0.));
#210=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,$);
#211=IFCMAPCONVERSION(#200,#210,2600000.,1200000.,400.,$,$,$);
#300=IFCUNITASSIGNMENT((#301));
#301=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
ENDSEC;
END-ISO-10303-21;`;

const ALL = { has: () => true };
const GEOMETRY: ReadonlySet<number> = new Set([10, 11, 12, 13]);
const READY: ReadonlySet<string> = new Set(['legacy']);

interface Variant {
  mode: HierarchyMode;
  groupFilter?: GroupSubFilter;
  layerGrouping?: LayerGrouping;
  authored?: AuthoredProduct[];
  georef?: GeorefMutationsByModel;
}

function builderFor(store: IfcDataStore, variant: Variant) {
  const unified = buildUnifiedStoreys(new Map(), 'name-asc');
  return (expansion: { has(id: string): boolean }): TreeNode[] => buildTreeForGrouping(
    variant.mode, new Map(), store, expansion, false, unified, 'name-asc',
    GEOMETRY, GEOMETRY, variant.authored ?? [], variant.groupFilter ?? 'all', READY,
    variant.georef ?? new Map(), new Map(), undefined, buildPresentationLayerTree,
    variant.layerGrouping ?? 'none',
  );
}

/** Every visible-row set from nothing expanded to everything, including a partial one. */
function stagesOf(structure: TreeNode[]): Set<string>[] {
  const expandable = structure.filter((node) => node.hasChildren).map((node) => node.id);
  return [
    new Set<string>(),
    new Set(expandable.slice(0, 1)),
    new Set(expandable.filter((_, i) => i % 2 === 0)),
    new Set(expandable.slice(1)),
    new Set(expandable),
  ];
}

const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer, { disableWorkerScan: true });

const authored: AuthoredProduct[] = [
  { modelId: 'legacy', expressId: 900, globalId: 900, name: 'Authored space', ifcType: 'IfcSpace' },
  { modelId: 'legacy', expressId: 901, globalId: 901, name: 'Authored wall', ifcType: 'IfcWall' },
];
const georef: GeorefMutationsByModel = new Map([['__legacy__', { mapConversion: { orthogonalHeight: 512.25 } }]]);

/** [label, variant, baseline it must differ from (undefined: none)] */
const CASES: Array<[string, Variant, Variant | undefined]> = [
  ['presentation layers, no layer grouping', { mode: 'presentation-layers' }, undefined],
  ['presentation layers grouped by class', { mode: 'presentation-layers', layerGrouping: 'class' }, { mode: 'presentation-layers' }],
  ['presentation layers grouped by classification', { mode: 'presentation-layers', layerGrouping: 'classification' }, { mode: 'presentation-layers' }],
  ['groups, all', { mode: 'groups', groupFilter: 'all' }, undefined],
  ['groups, systems', { mode: 'groups', groupFilter: 'systems' }, { mode: 'groups', groupFilter: 'all' }],
  ['groups, zones', { mode: 'groups', groupFilter: 'zones' }, { mode: 'groups', groupFilter: 'all' }],
  ['groups, other', { mode: 'groups', groupFilter: 'other' }, { mode: 'groups', groupFilter: 'all' }],
  ['class tree with authored products', { mode: 'type', authored }, { mode: 'type' }],
  ['spatial tree with a georeference edit', { mode: 'spatial', georef }, { mode: 'spatial' }],
];

describe('the expansion projection equals the dispatcher for every grouping input (#5886, #9629)', () => {
  for (const [label, variant, baseline] of CASES) {
    it(label, () => {
      const build = builderFor(store, variant);
      const structure = build(ALL);
      assert.ok(structure.length > 0, `${label}: the fixture must produce rows`);
      assert.ok(structure.some((node) => node.hasChildren), `${label}: the fixture must have expandable rows`);
      if (baseline) {
        assert.notDeepStrictEqual(structure, builderFor(store, baseline)(ALL),
          `${label}: the input must change the structure, or this case tests nothing`);
      }
      const index = indexHierarchyTree(structure);
      for (const expanded of stagesOf(structure)) {
        assert.deepStrictEqual(flattenVisibleHierarchy(index, expanded), build(expanded),
          `${label}: projected rows must equal the builder's at ${expanded.size} expanded`);
      }
    });
  }
});
