/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcSpace` is a spatial structure element: it hangs off its storey by
 * `IfcRelAggregates` (`IfcSpatialStructureElement.WR41`), and
 * `IfcRelContainedInSpatialStructure.WR31` forbids it in `RelatedElements`.
 * The in-store `addSpaceToStore` already does this; `IfcCreator` contained it.
 */

import { describe, it, expect } from 'vitest';
import { IfcCreator } from './ifc-creator.js';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

function rels(content: string, type: string): Array<{ relating: number; related: number[] }> {
  const out: Array<{ relating: number; related: number[] }> = [];
  for (const m of content.matchAll(new RegExp(`^#\\d+=${type}\\((.*)\\);$`, 'gm'))) {
    const refs = [...m[1].matchAll(/#(\d+)/g)].map((r) => Number(r[1]));
    // Aggregates: ...,#relating,(#a,#b); Contained: ...,(#a,#b),#relating
    const list = /\(((?:#\d+,?)+)\)/.exec(m[1])![1].split(',').map((r) => Number(r.slice(1)));
    const relating = refs.filter((r) => !list.includes(r)).pop()!;
    out.push({ relating, related: list });
  }
  return out;
}

describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as Schema[])('IfcCreator spaces (%s) (#11498)', (schema) => {
  it('aggregates a space under its storey and never contains it', () => {
    const c = new IfcCreator({ Name: 'T', Schema: schema });
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wall = c.addIfcWall(storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    const space = c.addIfcSpace(storey, { Position: [0, 0, 0], Width: 5, Depth: 4, Height: 3 });
    const { content } = c.toIfc();

    const contained = rels(content, 'IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(contained.flatMap((r) => r.related)).toContain(wall);
    expect(contained.flatMap((r) => r.related)).not.toContain(space);
    expect(rels(content, 'IFCRELAGGREGATES')).toContainEqual({ relating: storey, related: [space] });
  });

  it('aggregates a space made through the generic addElement and addAxisElement', () => {
    const c = new IfcCreator({ Name: 'T', Schema: schema });
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const profile = { ProfileType: 'RECTANGLE' as const, XDim: 2, YDim: 2 };
    const generic = c.addElement(storey, { IfcType: 'IfcSpace', Placement: { Location: [0, 0, 0] }, Profile: profile, Depth: 3 });
    const axis = c.addAxisElement(storey, { IfcType: 'IFCSPACE', Start: [0, 0, 0], End: [0, 0, 3], Profile: profile });
    const { content } = c.toIfc();
    expect(content).not.toContain('IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(rels(content, 'IFCRELAGGREGATES')).toContainEqual({ relating: storey, related: [generic, axis] });
  });

  it('a storey holding only spaces writes no empty containment relationship', () => {
    const c = new IfcCreator({ Name: 'T', Schema: schema });
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    c.addIfcSpace(storey, { Position: [0, 0, 0], Width: 5, Depth: 4, Height: 3 });
    expect(c.toIfc().content).not.toContain('IFCRELCONTAINEDINSPATIALSTRUCTURE');
  });
});
