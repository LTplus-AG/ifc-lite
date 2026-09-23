/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5204: this package's own versioned schema API (`getEntities`, `findEntity`,
 * and `ENTITIES_BY_VERSION`, which `expandTypeNamesToDescendants` walks) used to
 * serve the raw C#-derived IFC4 table. So the IDS auditor, which calls
 * `findEntity(version, name)`, accepted IFC4X3-only entities as IFC4-valid.
 */

import { describe, expect, it } from 'vitest';
import { findEntity, getEntities } from './index.js';

describe('the IFC4 schema API serves the EXPRESS-checked table (#5204)', () => {
  it('does not know IFC4X3-only entities under IFC4', async () => {
    for (const name of ['IfcLinearPlacement', 'IfcAlignment2DHorizontal', 'IfcOffsetCurve']) {
      expect(await findEntity('IFC4', name), name).toBeUndefined();
    }
    const ifc4 = await getEntities('IFC4');
    expect(ifc4.some((e) => e.name === 'IfcLinearPlacement')).toBe(false);
  });

  it('still knows them under IFC4X3, where they are real', async () => {
    expect(await findEntity('IFC4X3', 'IfcLinearPlacement')).toBeDefined();
  });

  it('gives IfcCartesianPointList3D its IFC4 attributes, without IFC4X3 TagList', async () => {
    expect((await findEntity('IFC4', 'IfcCartesianPointList3D'))?.attributes).toEqual(['CoordList']);
  });

  it('keeps ordinary IFC4 entities and defined types', async () => {
    expect((await findEntity('IFC4', 'IfcWall'))?.attributes).toContain('PredefinedType');
    expect(await findEntity('IFC4', 'IfcLengthMeasure')).toBeDefined();
  });
});
