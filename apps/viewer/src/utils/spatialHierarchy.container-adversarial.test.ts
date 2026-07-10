/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ADVERSARIAL tests for `containerOf` (PR #1700, Container column). Pins down:
 *  - aggregated parts of an assembly contained in a STOREY (storey fallback OK)
 *  - aggregated parts of an assembly contained in a NON-storey container
 *    (elementToStorey never propagates -> blank, while the assembly resolves)
 *  - elements contained in an IfcSpatialZone / directly in an IfcSite
 *  - a container node DISCONNECTED from the project tree
 *  - zero spatial tree (hierarchy undefined)
 *  - unnamed AND typeless containers (getClass missing or empty)
 *  - the spatial container's OWN containerOf
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EntityTableBuilder,
  RelationshipGraphBuilder,
  RelationshipType,
  StringTable,
} from '@ifc-lite/data';
import { rebuildSpatialHierarchy, buildSpatialAncestryIndex } from './spatialHierarchy';

function indexFrom(builderSetup: (eb: EntityTableBuilder, rels: RelationshipGraphBuilder) => void) {
  const strings = new StringTable();
  const eb = new EntityTableBuilder(16, strings);
  const rels = new RelationshipGraphBuilder();
  builderSetup(eb, rels);
  const et = eb.build();
  const h = rebuildSpatialHierarchy(et, rels.build());
  assert.ok(h, 'hierarchy builds');
  return {
    hierarchy: h,
    idx: buildSpatialAncestryIndex(h, (id) => et.getName(id), (id) => et.getTypeName(id)),
  };
}

describe('containerOf for aggregated assembly parts', () => {
  it('assembly contained in a STOREY: parts fall back to the storey (correct label)', () => {
    const { idx } = indexFrom((eb, rels) => {
      eb.add(1, 'IFCPROJECT', 'p', 'Project', '', '');
      eb.add(2, 'IFCSITE', 's', 'Site', '', '');
      eb.add(3, 'IFCBUILDING', 'b', 'Building', '', '');
      eb.add(4, 'IFCBUILDINGSTOREY', 'st', 'Level 1', '', '');
      eb.add(5, 'IFCELEMENTASSEMBLY', 'asm', 'Truss T1', '', '', true);
      eb.add(6, 'IFCBEAM', 'beam', 'Chord', '', '', true);
      rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
      rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
      rels.addEdge(3, 4, RelationshipType.Aggregates, 102);
      rels.addEdge(4, 5, RelationshipType.ContainsElements, 103); // assembly in storey
      rels.addEdge(5, 6, RelationshipType.Aggregates, 104); // beam aggregated, NOT contained
    });
    assert.equal(idx.containerOf(5), 'Level 1');
    // IFC containment is inherited through decomposition, so labelling the
    // part with the assembly's storey is semantically right.
    assert.equal(idx.containerOf(6), 'Level 1');
  });

  it('FIXED: assembly contained in a NON-storey container attributes its parts to that container', () => {
    // Infrastructure shape: assembly contained in an IfcBridgePart. The
    // builder now records an aggregated-descendant containment walk for ANY
    // spatial container node (not just storeys) into `elementToContainer`, so
    // the beam resolves the Deck it demonstrably lives under.
    const { hierarchy, idx } = indexFrom((eb, rels) => {
      eb.add(1, 'IFCPROJECT', 'p', 'Infra', '', '');
      eb.add(2, 'IFCBRIDGE', 'br', 'Bridge A', '', '');
      eb.add(3, 'IFCBRIDGEPART', 'deck', 'Deck', '', '');
      eb.add(4, 'IFCELEMENTASSEMBLY', 'asm', 'Truss T1', '', '', true);
      eb.add(5, 'IFCBEAM', 'beam', 'Chord', '', '', true);
      rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
      rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
      rels.addEdge(3, 4, RelationshipType.ContainsElements, 102); // assembly in bridge part
      rels.addEdge(4, 5, RelationshipType.Aggregates, 103); // beam aggregated into assembly
    });
    // The assembly itself resolves its immediate container.
    assert.equal(idx.containerOf(4), 'Deck');
    // Its aggregated part now inherits the Deck via the new elementToContainer
    // map — the beam's Container cell is no longer blank.
    assert.equal(idx.containerOf(5), 'Deck');
    assert.equal(hierarchy.elementToContainer?.get(5), 3);
    // elementToStorey semantics stay byte-identical: still storey-only, so the
    // beam has NO storey entry and the pre-existing storey-backed columns
    // (buildingOf) are unchanged.
    assert.equal(hierarchy.elementToStorey.get(5), undefined);
    assert.equal(idx.buildingOf(5), '');
  });
});

describe('containerOf across container kinds', () => {
  it('element contained in an IfcSpatialZone resolves the zone; the zone resolves its storey', () => {
    const { idx } = indexFrom((eb, rels) => {
      eb.add(1, 'IFCPROJECT', 'p', 'Project', '', '');
      eb.add(2, 'IFCBUILDING', 'b', 'Building', '', '');
      eb.add(3, 'IFCBUILDINGSTOREY', 'st', 'Level 1', '', '');
      eb.add(4, 'IFCSPATIALZONE', 'z', 'GFA Apt', '', '', true);
      eb.add(5, 'IFCWALL', 'w', 'Wall', '', '', true);
      rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
      rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
      rels.addEdge(3, 4, RelationshipType.Aggregates, 102); // zone under storey
      rels.addEdge(4, 5, RelationshipType.ContainsElements, 103); // wall in zone
    });
    assert.equal(idx.containerOf(5), 'GFA Apt');
    // The zone is a child NODE (never in `elements`); it falls back to its
    // storey via elementToStorey — its nearest containing structure.
    assert.equal(idx.containerOf(4), 'Level 1');
  });

  it('element contained directly in an IfcSite resolves the site', () => {
    const { idx } = indexFrom((eb, rels) => {
      eb.add(1, 'IFCPROJECT', 'p', 'Project', '', '');
      eb.add(2, 'IFCSITE', 's', 'North Site', '', '');
      eb.add(3, 'IFCWALL', 'w', 'Retaining Wall', '', '', true);
      rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
      rels.addEdge(2, 3, RelationshipType.ContainsElements, 101);
    });
    assert.equal(idx.containerOf(3), 'North Site');
  });

  it('container DISCONNECTED from the project tree: element resolves blank, no crash', () => {
    // A zone that is never aggregated under the project is unreachable by the
    // tree walk; its contained element has no reverse entry anywhere.
    const { idx } = indexFrom((eb, rels) => {
      eb.add(1, 'IFCPROJECT', 'p', 'Project', '', '');
      eb.add(2, 'IFCBUILDING', 'b', 'Building', '', '');
      eb.add(5, 'IFCSPATIALZONE', 'z', 'Orphan Zone', '', '', true);
      eb.add(6, 'IFCWALL', 'w', 'Wall', '', '', true);
      rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
      rels.addEdge(5, 6, RelationshipType.ContainsElements, 101); // zone floats free
    });
    assert.equal(idx.containerOf(6), '');
  });

  it('the spatial container itself (a storey) has no container: blank, no self-label', () => {
    const { idx } = indexFrom((eb, rels) => {
      eb.add(1, 'IFCPROJECT', 'p', 'Project', '', '');
      eb.add(2, 'IFCBUILDING', 'b', 'Building', '', '');
      eb.add(3, 'IFCBUILDINGSTOREY', 'st', 'Level 1', '', '');
      rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
      rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
    });
    // Unlike siteOf/buildingOf (self-inclusive), containerOf never returns the
    // element itself; a storey listed as a row shows a blank Container cell.
    assert.equal(idx.containerOf(3), '');
  });
});

describe('containerOf degenerate inputs', () => {
  it('zero spatial tree (hierarchy undefined): every lookup is "" and never throws', () => {
    const idx = buildSpatialAncestryIndex(undefined, () => '', () => 'IfcWall');
    assert.equal(idx.containerOf(1), '');
    assert.equal(idx.containerOf(0), '');
    assert.equal(idx.containerOf(-1), '');
    assert.equal(idx.projectName, '');
  });

  it('unnamed container with NO getClass (legacy caller) resolves "" not undefined', () => {
    const strings = new StringTable();
    const eb = new EntityTableBuilder(4, strings);
    eb.add(1, 'IFCPROJECT', 'p', 'Project', '', '');
    eb.add(2, 'IFCBUILDINGSTOREY', 'st', '', '', ''); // unnamed storey
    eb.add(3, 'IFCWALL', 'w', 'Wall', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.ContainsElements, 101);
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    // Two-arg call (the pre-PR signature): the class fallback is simply off.
    const idx = buildSpatialAncestryIndex(h, (id) => et.getName(id));
    assert.equal(typeof idx.containerOf(3), 'string');
    assert.equal(idx.containerOf(3), '');
  });

  it('unnamed container whose getClass also yields "" resolves "" (fully anonymous)', () => {
    const strings = new StringTable();
    const eb = new EntityTableBuilder(4, strings);
    eb.add(1, 'IFCPROJECT', 'p', 'Project', '', '');
    eb.add(2, 'IFCBUILDINGSTOREY', 'st', '', '', '');
    eb.add(3, 'IFCWALL', 'w', 'Wall', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.ContainsElements, 101);
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    const idx = buildSpatialAncestryIndex(h, (id) => et.getName(id), () => '');
    assert.equal(idx.containerOf(3), '');
  });
});
