/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { generateIfcGuid, isValidIfcGuid, ifcGuidToUuid, uuidToIfcGuid } from '@ifc-lite/encoding';
import { IfcCreator } from './ifc-creator.js';

describe('IfcCreator', () => {
  it('creates a minimal valid IFC file with project, site, building', () => {
    const creator = new IfcCreator({ Name: 'Test Project' });
    const result = creator.toIfc();

    expect(result.content).toContain('ISO-10303-21');
    expect(result.content).toContain('IFCPROJECT');
    expect(result.content).toContain('IFCSITE');
    expect(result.content).toContain('IFCBUILDING');
    expect(result.content).toContain('IFCRELAGGREGATES');
    expect(result.content).toContain("'Test Project'");
    expect(result.content).toContain('END-ISO-10303-21');
    expect(result.stats.entityCount).toBeGreaterThan(10);
    expect(result.stats.fileSize).toBeGreaterThan(0);
    expect(result.entities.some(e => e.type === 'IfcProject')).toBe(true);
  });

  it('adds a storey and includes it in aggregation', () => {
    const creator = new IfcCreator();
    const storeyId = creator.addIfcBuildingStorey({ Name: 'Ground Floor', Elevation: 0 });
    const result = creator.toIfc();

    expect(storeyId).toBeGreaterThan(0);
    expect(result.content).toContain('IFCBUILDINGSTOREY');
    expect(result.content).toContain("'Ground Floor'");
    expect(result.entities.some(e => e.type === 'IfcBuildingStorey')).toBe(true);
  });

  it('throws when adding an element to an unknown storey', () => {
    const creator = new IfcCreator();

    expect(() => creator.addIfcWall(9999, {
      Start: [0, 0, 0],
      End: [5, 0, 0],
      Thickness: 0.2,
      Height: 3,
    })).toThrow(/Unknown storeyId/);
  });

  it('creates a wall with geometry', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wallId = creator.addIfcWall(storey, {
      Name: 'Test Wall',
      Start: [0, 0, 0],
      End: [5, 0, 0],
      Thickness: 0.2,
      Height: 3,
    });
    const result = creator.toIfc();

    expect(wallId).toBeGreaterThan(0);
    expect(result.content).toContain('IFCWALL');
    expect(result.content).toContain("'Test Wall'");
    expect(result.content).toContain('IFCEXTRUDEDAREASOLID');
    expect(result.content).toContain('IFCRECTANGLEPROFILEDEF');
    expect(result.content).toContain('IFCSHAPEREPRESENTATION');
    expect(result.content).toContain('IFCRELCONTAINEDINSPATIALSTRUCTURE');
  });

  it('creates a wall with openings', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcWall(storey, {
      Name: 'Wall with Opening',
      Start: [0, 0, 0],
      End: [5, 0, 0],
      Thickness: 0.2,
      Height: 3,
      Openings: [
        { Name: 'Window', Width: 1.2, Height: 1.5, Position: [2, 0, 0.9] },
      ],
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCOPENINGELEMENT');
    expect(result.content).toContain('IFCRELVOIDSELEMENT');
    expect(result.content).toContain("'Window'");
  });

  it('creates a wall-hosted window aligned to the wall opening', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wallId = creator.addIfcWall(storey, {
      Name: 'Window Wall',
      Start: [0, 0, 0],
      End: [5, 0, 0],
      Thickness: 0.2,
      Height: 3,
    });
    creator.addIfcWallWindow(wallId, {
      Name: 'Hosted Window',
      Position: [2.5, 0, 1.0],
      Width: 1.2,
      Height: 1.2,
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCWINDOW');
    expect(result.content).toContain("'Hosted Window'");
    expect(result.content).toContain('IFCRELFILLSELEMENT');
    expect(result.content).toContain('IFCOPENINGELEMENT');
  });

  it('creates a wall-hosted door aligned to the wall opening', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wallId = creator.addIfcWall(storey, {
      Name: 'Door Wall',
      Start: [0, 0, 0],
      End: [5, 0, 0],
      Thickness: 0.2,
      Height: 3,
    });
    creator.addIfcWallDoor(wallId, {
      Name: 'Hosted Door',
      Position: [1.0, 0, 0],
      Width: 0.9,
      Height: 2.1,
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCDOOR');
    expect(result.content).toContain("'Hosted Door'");
    expect(result.content).toContain('IFCRELFILLSELEMENT');
    expect(result.content).toContain('IFCOPENINGELEMENT');
  });

  it('creates a slab', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcSlab(storey, {
      Name: 'Floor Slab',
      Position: [0, 0, 0],
      Thickness: 0.3,
      Width: 10,
      Depth: 8,
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCSLAB');
    expect(result.content).toContain("'Floor Slab'");
  });

  it('creates a slab with arbitrary profile', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcSlab(storey, {
      Name: 'L-Shape Slab',
      Position: [0, 0, 0],
      Thickness: 0.3,
      Profile: [[0, 0], [5, 0], [5, 3], [2, 3], [2, 8], [0, 8]],
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCSLAB');
    expect(result.content).toContain('IFCARBITRARYCLOSEDPROFILEDEF');
    expect(result.content).toContain('IFCPOLYLINE');
  });

  it('creates a column', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcColumn(storey, {
      Name: 'Corner Column',
      Position: [0, 0, 0],
      Width: 0.3,
      Depth: 0.3,
      Height: 3,
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCCOLUMN');
    expect(result.content).toContain("'Corner Column'");
  });

  it('creates a beam', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcBeam(storey, {
      Name: 'Ridge Beam',
      Start: [0, 0, 3],
      End: [5, 0, 3],
      Width: 0.2,
      Height: 0.4,
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCBEAM');
    expect(result.content).toContain("'Ridge Beam'");
  });

  it('creates a stair', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcStair(storey, {
      Name: 'Main Stair',
      Position: [1, 1, 0],
      NumberOfRisers: 10,
      RiserHeight: 0.18,
      TreadLength: 0.28,
      Width: 1.0,
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCSTAIR');
    expect(result.content).toContain("'Main Stair'");
    // 10 risers = 10 extruded solids
    const solidCount = (result.content.match(/IFCEXTRUDEDAREASOLID/g) || []).length;
    expect(solidCount).toBeGreaterThanOrEqual(10);
  });

  it('creates a roof', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcRoof(storey, {
      Name: 'Flat Roof',
      Position: [0, 0, 3],
      Width: 10,
      Depth: 8,
      Thickness: 0.25,
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCROOF');
    expect(result.content).toContain("'Flat Roof'");
  });

  it('creates a sloped roof', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcRoof(storey, {
      Name: 'Pitched Roof',
      Position: [0, 0, 3],
      Width: 10,
      Depth: 8,
      Thickness: 0.2,
      Slope: Math.PI / 12, // 15 degrees
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCROOF');
    expect(result.content).toContain("'Pitched Roof'");
  });

  it('creates a gable roof with two roof planes', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcGableRoof(storey, {
      Name: 'House Roof',
      Position: [0, 0, 3],
      Width: 10,
      Depth: 8,
      Thickness: 0.2,
      Slope: Math.PI / 12,
      Overhang: 0.3,
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCROOF');
    expect(result.content).toContain('.GABLE_ROOF.');
    expect(result.content).toContain("'House Roof'");
    expect((result.content.match(/IFCEXTRUDEDAREASOLID/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('rejects roof slopes that look like degrees', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });

    expect(() => creator.addIfcRoof(storey, {
      Position: [0, 0, 3],
      Width: 10,
      Depth: 8,
      Thickness: 0.2,
      Slope: 15,
    })).toThrow(/radians/);
  });

  it('attaches property sets', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wallId = creator.addIfcWall(storey, {
      Start: [0, 0, 0], End: [5, 0, 0],
      Thickness: 0.2, Height: 3,
    });

    creator.addIfcPropertySet(wallId, {
      Name: 'Pset_WallCommon',
      Properties: [
        { Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' },
        { Name: 'FireRating', NominalValue: 'REI60' },
        { Name: 'ThermalTransmittance', NominalValue: 0.25 },
      ],
    });

    const result = creator.toIfc();

    expect(result.content).toContain('IFCPROPERTYSET');
    expect(result.content).toContain('IFCPROPERTYSINGLEVALUE');
    expect(result.content).toContain('IFCRELDEFINESBYPROPERTIES');
    expect(result.content).toContain("'Pset_WallCommon'");
    expect(result.content).toContain("'IsExternal'");
    expect(result.content).toContain('IFCBOOLEAN(.T.)');
    expect(result.content).toContain("IFCLABEL('REI60')");
    expect(result.content).toContain('IFCREAL(0.25)');
  });

  it('attaches quantity sets', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const slabId = creator.addIfcSlab(storey, {
      Position: [0, 0, 0], Thickness: 0.3, Width: 10, Depth: 8,
    });

    creator.addIfcElementQuantity(slabId, {
      Name: 'Qto_SlabBaseQuantities',
      Quantities: [
        { Name: 'GrossArea', Value: 80, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: 24, Kind: 'IfcQuantityVolume' },
      ],
    });

    const result = creator.toIfc();

    expect(result.content).toContain('IFCELEMENTQUANTITY');
    expect(result.content).toContain('IFCQUANTITYAREA');
    expect(result.content).toContain('IFCQUANTITYVOLUME');
    expect(result.content).toContain("'Qto_SlabBaseQuantities'");
  });

  it('attaches a simple material via IfcRelAssociatesMaterial', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const colId = creator.addIfcColumn(storey, {
      Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3,
    });

    creator.addIfcMaterial(colId, { Name: 'Concrete C30/37', Category: 'Concrete' });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCMATERIAL');
    expect(result.content).toContain("'Concrete C30/37'");
    expect(result.content).toContain("'Concrete'");
    expect(result.content).toContain('IFCRELASSOCIATESMATERIAL');
  });

  it('attaches a layered material set', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wallId = creator.addIfcWall(storey, {
      Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3,
    });

    creator.addIfcMaterial(wallId, {
      Name: 'Wall Assembly',
      Layers: [
        { Name: 'Gypsum', Thickness: 0.013, Category: 'Finish' },
        { Name: 'Concrete', Thickness: 0.2, Category: 'Structural' },
      ],
    });
    const result = creator.toIfc();

    expect(result.content).toContain('IFCMATERIAL');
    expect(result.content).toContain('IFCMATERIALLAYER');
    expect(result.content).toContain('IFCMATERIALLAYERSET');
    expect(result.content).toContain("'Wall Assembly'");
    expect(result.content).toContain("'Gypsum'");
    expect(result.content).toContain("'Concrete'");
    expect(result.content).toContain('IFCRELASSOCIATESMATERIAL');
  });

  it('shares IfcMaterial entities across elements with same material name', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const col1 = creator.addIfcColumn(storey, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
    const col2 = creator.addIfcColumn(storey, { Position: [5, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });

    creator.addIfcMaterial(col1, { Name: 'Concrete' });
    creator.addIfcMaterial(col2, { Name: 'Concrete' });
    const result = creator.toIfc();

    // Only one IFCMATERIAL('Concrete'...) should be created, shared between both
    const materialMatches = result.content.match(/IFCMATERIAL\('Concrete'/g) ?? [];
    expect(materialMatches.length).toBe(1);

    // But one IfcRelAssociatesMaterial should link both elements
    const relMatches = result.content.match(/IFCRELASSOCIATESMATERIAL/g) ?? [];
    expect(relMatches.length).toBe(1);
  });

  it('produces valid STEP header', () => {
    const creator = new IfcCreator({ Schema: 'IFC4' });
    const result = creator.toIfc();

    expect(result.content).toMatch(/^ISO-10303-21;/);
    expect(result.content).toContain("FILE_SCHEMA(('IFC4'))");
    expect(result.content).toContain('HEADER;');
    expect(result.content).toContain('ENDSEC;');
    expect(result.content).toContain('DATA;');
    expect(result.content).toMatch(/END-ISO-10303-21;\s*$/);
  });

  it('generates unique, spec-valid GlobalIds that round-trip through UUID', () => {
    const creator = new IfcCreator();
    creator.addIfcBuildingStorey({ Name: 'S1', Elevation: 0 });
    creator.addIfcBuildingStorey({ Name: 'S2', Elevation: 3 });
    const result = creator.toIfc();

    // Extract all GlobalIds
    const globalIds = (result.content.match(/'[0-9A-Za-z_$]{22}'/g) ?? []).map((g) => g.slice(1, -1));
    const uniqueIds = new Set(globalIds);
    expect(uniqueIds.size).toBe(globalIds.length);
    expect(globalIds.length).toBeGreaterThan(0);
    // Every GlobalId must encode 128 bits (first char 0-3) and survive a
    // guid -> uuid -> guid round-trip without silently changing identity.
    for (const id of globalIds) {
      expect(isValidIfcGuid(id)).toBe(true);
      expect(uuidToIfcGuid(ifcGuidToUuid(id))).toBe(id);
    }
  });

  it('builds a complete building', () => {
    const creator = new IfcCreator({ Name: 'Complete Building' });
    const gf = creator.addIfcBuildingStorey({ Name: 'Ground Floor', Elevation: 0 });
    const ff = creator.addIfcBuildingStorey({ Name: 'First Floor', Elevation: 3.2 });

    // Ground floor walls
    creator.addIfcWall(gf, { Start: [0, 0, 0], End: [10, 0, 0], Thickness: 0.2, Height: 3 });
    creator.addIfcWall(gf, { Start: [10, 0, 0], End: [10, 8, 0], Thickness: 0.2, Height: 3 });
    creator.addIfcWall(gf, { Start: [10, 8, 0], End: [0, 8, 0], Thickness: 0.2, Height: 3 });
    creator.addIfcWall(gf, { Start: [0, 8, 0], End: [0, 0, 0], Thickness: 0.2, Height: 3 });

    // Ground floor slab
    creator.addIfcSlab(gf, { Position: [0, 0, -0.3], Thickness: 0.3, Width: 10, Depth: 8 });

    // Columns
    creator.addIfcColumn(gf, { Position: [5, 4, 0], Width: 0.4, Depth: 0.4, Height: 3 });

    // First floor slab (Z=0 relative to storey elevation 3.2 → world Z=3.2)
    creator.addIfcSlab(ff, { Position: [0, 0, 0], Thickness: 0.3, Width: 10, Depth: 8 });

    // Roof (Z=3 relative to storey elevation 3.2 → world Z=6.2)
    creator.addIfcRoof(ff, { Position: [0, 0, 3], Width: 10, Depth: 8, Thickness: 0.25 });

    const result = creator.toIfc();

    // Check all element types are present
    expect(result.content).toContain('IFCWALL');
    expect(result.content).toContain('IFCSLAB');
    expect(result.content).toContain('IFCCOLUMN');
    expect(result.content).toContain('IFCROOF');
    expect(result.content).toContain('IFCBUILDINGSTOREY');

    // Check proper spatial containment
    const containedCount = (result.content.match(/IFCRELCONTAINEDINSPATIALSTRUCTURE/g) || []).length;
    expect(containedCount).toBe(2); // One per storey

    expect(result.stats.entityCount).toBeGreaterThan(50);
    expect(result.entities.length).toBeGreaterThan(10);
  });
});

describe('IfcCreator — scheduling / 4D', () => {
  it('emits IFCWORKSCHEDULE with name, dates, and PredefinedType', () => {
    const c = new IfcCreator();
    const scheduleId = c.addIfcWorkSchedule({
      Name: 'Main schedule',
      StartTime: '2024-05-01T08:00:00',
      FinishTime: '2024-06-30T17:00:00',
      PredefinedType: 'PLANNED',
    });
    const result = c.toIfc();
    expect(scheduleId).toBeGreaterThan(0);
    expect(result.content).toContain('IFCWORKSCHEDULE');
    expect(result.content).toContain("'Main schedule'");
    expect(result.content).toContain("'2024-05-01T08:00:00'");
    expect(result.content).toContain("'2024-06-30T17:00:00'");
    expect(result.content).toContain('.PLANNED.');
  });

  it('emits IFCWORKPLAN with PredefinedType', () => {
    const c = new IfcCreator();
    c.addIfcWorkPlan({
      Name: 'Master plan',
      StartTime: '2024-01-01T00:00:00',
      PredefinedType: 'BASELINE',
    });
    const result = c.toIfc();
    expect(result.content).toContain('IFCWORKPLAN');
    expect(result.content).toContain("'Master plan'");
    expect(result.content).toContain('.BASELINE.');
  });

  it('emits IFCTASK with an IFCTASKTIME when dates are provided', () => {
    const c = new IfcCreator();
    const taskId = c.addIfcTask({
      Name: 'Install walls',
      PredefinedType: 'INSTALLATION',
      ScheduleStart: '2024-05-06T08:00:00',
      ScheduleFinish: '2024-05-10T17:00:00',
      ScheduleDuration: 'P5D',
      IsCritical: true,
      IsMilestone: false,
    });
    const result = c.toIfc();
    expect(taskId).toBeGreaterThan(0);
    expect(result.content).toContain('IFCTASK');
    expect(result.content).toContain('IFCTASKTIME');
    expect(result.content).toContain("'Install walls'");
    expect(result.content).toContain("'2024-05-06T08:00:00'");
    expect(result.content).toContain("'P5D'");
    expect(result.content).toContain('.INSTALLATION.');
    // IsCritical = true is emitted as `.T.` inside the IfcTaskTime line.
    const taskTimeLine = result.content
      .split('\n')
      .find((line) => line.startsWith('#') && line.includes('=IFCTASKTIME('));
    expect(taskTimeLine).toContain('.T.');
  });

  it('skips IfcTaskTime when no time fields are present', () => {
    const c = new IfcCreator();
    c.addIfcTask({ Name: 'Handover', IsMilestone: true });
    const result = c.toIfc();
    expect(result.content).toContain('IFCTASK');
    expect(result.content).not.toContain('IFCTASKTIME');
  });

  it('creates IfcRelSequence with IfcLagTime when TimeLag is supplied', () => {
    const c = new IfcCreator();
    const a = c.addIfcTask({ Name: 'A' });
    const b = c.addIfcTask({ Name: 'B' });
    const relId = c.addIfcRelSequence(a, b, {
      SequenceType: 'FINISH_START',
      TimeLag: 'P2D',
      LagDurationType: 'WORKTIME',
    });
    const result = c.toIfc();
    expect(relId).toBeGreaterThan(0);
    expect(result.content).toContain('IFCRELSEQUENCE');
    expect(result.content).toContain('IFCLAGTIME');
    expect(result.content).toContain(".FINISH_START.");
    expect(result.content).toContain("IFCDURATION('P2D')");
  });

  it('creates IfcRelSequence without a lag when TimeLag is omitted', () => {
    const c = new IfcCreator();
    const a = c.addIfcTask({ Name: 'A' });
    const b = c.addIfcTask({ Name: 'B' });
    c.addIfcRelSequence(a, b);
    const result = c.toIfc();
    expect(result.content).toContain('IFCRELSEQUENCE');
    expect(result.content).not.toContain('IFCLAGTIME');
  });

  it('emits IFCRELASSIGNSTOCONTROL when assigning tasks to a schedule', () => {
    const c = new IfcCreator();
    const s = c.addIfcWorkSchedule({ Name: 'S', StartTime: '2024-01-01T00:00:00' });
    const t1 = c.addIfcTask({ Name: 'T1' });
    const t2 = c.addIfcTask({ Name: 'T2' });
    c.assignTasksToWorkSchedule(s, [t1, t2]);
    const result = c.toIfc();
    expect(result.content).toContain('IFCRELASSIGNSTOCONTROL');
    expect((result.content.match(/IFCRELASSIGNSTOCONTROL/g) ?? []).length).toBe(1);
  });

  it('emits IFCRELASSIGNSTOPROCESS when binding products to a task', () => {
    const c = new IfcCreator();
    const storey = c.addIfcBuildingStorey({ Name: 'L0', Elevation: 0 });
    const w1 = c.addIfcWall(storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    const w2 = c.addIfcWall(storey, { Start: [5, 0, 0], End: [5, 5, 0], Thickness: 0.2, Height: 3 });
    const task = c.addIfcTask({
      Name: 'Install',
      PredefinedType: 'INSTALLATION',
      ScheduleStart: '2024-05-01T08:00:00',
      ScheduleFinish: '2024-05-05T17:00:00',
    });
    c.assignProductsToTask(task, [w1, w2]);
    const result = c.toIfc();
    expect(result.content).toContain('IFCRELASSIGNSTOPROCESS');
  });

  it('emits IFCRELNESTS when nesting child tasks under a parent', () => {
    const c = new IfcCreator();
    const parent = c.addIfcTask({ Name: 'Foundations' });
    const child1 = c.addIfcTask({ Name: 'Excavation' });
    const child2 = c.addIfcTask({ Name: 'Pour' });
    c.nestTasks(parent, [child1, child2]);
    const result = c.toIfc();
    expect(result.content).toContain('IFCRELNESTS');
  });

  it('rejects empty id lists on assignment helpers', () => {
    const c = new IfcCreator();
    const s = c.addIfcWorkSchedule({ Name: 'S', StartTime: '2024-01-01T00:00:00' });
    expect(() => c.assignTasksToWorkSchedule(s, [])).toThrow(/empty/);
    const t = c.addIfcTask({ Name: 'T' });
    expect(() => c.assignProductsToTask(t, [])).toThrow(/empty/);
    expect(() => c.nestTasks(t, [])).toThrow(/empty/);
  });
});

describe('IfcCreator deterministic output (Timestamp + GuidSource)', () => {
  /** Simple LCG in [0, 1): same seed => same stream. */
  const seededRng = (seed: number) => {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  };

  const FIXED = Date.UTC(2024, 0, 1, 0, 0, 0);

  /** A representative model touching header, owner history, GUIDs and scheduling. */
  const buildModel = (params: ConstructorParameters<typeof IfcCreator>[0]) => {
    const c = new IfcCreator({ Name: 'Deterministic', Author: 'A', ...params });
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wall = c.addIfcWall(storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    c.addIfcWallWindow(wall, { Width: 1, Height: 1.2, Position: [1, 0, 0.9] });
    c.addIfcSlab(storey, { Position: [0, 0, 0], Width: 5, Depth: 5, Thickness: 0.2 });
    c.addIfcWorkSchedule({ Name: 'S', StartTime: '2024-01-01T00:00:00' });
    return c.toIfc().content;
  };

  it('same Timestamp + GuidSource yields byte-identical output', () => {
    const opts = () => ({
      Timestamp: FIXED,
      GuidSource: (() => {
        const rng = seededRng(42);
        return () => generateIfcGuid(rng);
      })(),
    });
    const first = buildModel(opts());
    const second = buildModel(opts());
    expect(second).toBe(first);
    // The fixed instant landed in the STEP header and IfcOwnerHistory.
    expect(first).toContain("'20240101T000000'");
    expect(first).toContain(`,${Math.floor(FIXED / 1000)});`);
  });

  it('accepts a Date for Timestamp', () => {
    const opts = () => ({
      Timestamp: new Date(FIXED),
      GuidSource: (() => {
        const rng = seededRng(7);
        return () => generateIfcGuid(rng);
      })(),
    });
    expect(buildModel(opts())).toBe(buildModel(opts()));
  });

  it('default behavior stays random', () => {
    // Without the hooks, GlobalIds come from the CSPRNG, so two otherwise
    // identical builds differ.
    expect(buildModel({})).not.toBe(buildModel({}));
  });

  it('rejects an invalid Timestamp', () => {
    expect(() => new IfcCreator({ Timestamp: Number.NaN })).toThrow(/Timestamp/);
    expect(() => new IfcCreator({ Timestamp: new Date('nonsense') })).toThrow(/Timestamp/);
    // Regression, PR #1882 (follow-up to #1879): finite but past the
    // ±8.64e15 ms Date range. Caught here rather than surfacing later as a
    // RangeError from toISOString() while writing the header.
    expect(() => new IfcCreator({ Timestamp: 1e16 })).toThrow(/Timestamp/);
    expect(() => new IfcCreator({ Timestamp: -1e16 })).toThrow(/Timestamp/);
  });

  it('rejects a GuidSource returning invalid GlobalIds', () => {
    expect(() => new IfcCreator({ GuidSource: () => 'not-a-guid' })).toThrow(/invalid IFC GlobalId/);
  });

  it('errors instead of spinning when a GuidSource repeats forever', () => {
    // The preamble needs several distinct GlobalIds (project/site/building), so
    // a constant source trips the bounded-retry guard already in the constructor.
    const constant = generateIfcGuid();
    expect(() => new IfcCreator({ GuidSource: () => constant })).toThrow(/repeating/);
  });
});

/**
 * Dimension validation — see LTplus-AG/ifc-lite#2767 (sibling fix for the
 * in-store/ builders, which lives outside this class). A bare `<= 0` check
 * is `false` for both `NaN` and `Infinity`, so those values used to be
 * emitted into the STEP file as the literal strings "NaN"/"Infinity" — not
 * valid STEP REAL tokens. Every method below is table-driven so a future
 * method added without a guard shows up as a new failing case, not a gap
 * nobody notices.
 */
describe('IfcCreator dimension validation', () => {
  type Build = (creator: IfcCreator, storeyId: number) => unknown;

  // Each case builds the element with one bad value substituted in for a
  // real dimension. `label` documents which field/method is under test.
  const methodCases: Array<{ label: string; build: Build }> = [
    {
      label: 'addIfcColumn Width=NaN',
      build: (c, s) => c.addIfcColumn(s, { Position: [0, 0, 0], Width: NaN, Depth: 0.3, Height: 3 }),
    },
    {
      label: 'addIfcColumn Width=-2 (pre-existing hole: no guard at all before this fix)',
      build: (c, s) => c.addIfcColumn(s, { Position: [0, 0, 0], Width: -2, Depth: 0.3, Height: 3 }),
    },
    {
      label: 'addIfcColumn Height=Infinity',
      build: (c, s) => c.addIfcColumn(s, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: Infinity }),
    },
    {
      label: 'addIfcWall Thickness=NaN',
      build: (c, s) => c.addIfcWall(s, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: NaN, Height: 3 }),
    },
    {
      label: 'addIfcWall Height=Infinity',
      build: (c, s) => c.addIfcWall(s, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: Infinity }),
    },
    {
      label: 'addIfcSlab Thickness=NaN',
      build: (c, s) => c.addIfcSlab(s, { Position: [0, 0, 0], Thickness: NaN, Width: 5, Depth: 5 }),
    },
    {
      label: 'addIfcSlab Width=Infinity',
      build: (c, s) => c.addIfcSlab(s, { Position: [0, 0, 0], Thickness: 0.2, Width: Infinity, Depth: 5 }),
    },
    {
      label: 'addIfcBeam Width=NaN',
      build: (c, s) => c.addIfcBeam(s, { Start: [0, 0, 0], End: [5, 0, 0], Width: NaN, Height: 0.5 }),
    },
    {
      label: 'addIfcBeam Height=Infinity',
      build: (c, s) => c.addIfcBeam(s, { Start: [0, 0, 0], End: [5, 0, 0], Width: 0.3, Height: Infinity }),
    },
    {
      label: 'addIfcStair NumberOfRisers=NaN',
      build: (c, s) => c.addIfcStair(s, { Position: [0, 0, 0], NumberOfRisers: NaN, RiserHeight: 0.18, TreadLength: 0.28, Width: 1 }),
    },
    {
      label: 'addIfcRoof Thickness=Infinity',
      build: (c, s) => c.addIfcRoof(s, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: Infinity }),
    },
    {
      label: 'addIfcRoof Slope=NaN',
      build: (c, s) => c.addIfcRoof(s, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.3, Slope: NaN }),
    },
    {
      label: 'addIfcGableRoof Width=NaN',
      build: (c, s) => c.addIfcGableRoof(s, { Position: [0, 0, 0], Width: NaN, Depth: 4, Thickness: 0.3, Slope: 0.4 }),
    },
    {
      label: 'addIfcGableRoof Slope=Infinity',
      build: (c, s) => c.addIfcGableRoof(s, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.3, Slope: Infinity }),
    },
    {
      label: 'addIfcGableRoof Overhang=NaN',
      build: (c, s) => c.addIfcGableRoof(s, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.3, Slope: 0.4, Overhang: NaN }),
    },
    {
      label: 'addIfcDoor Width=NaN',
      build: (c, s) => c.addIfcDoor(s, { Position: [0, 0, 0], Width: NaN, Height: 2.1 }),
    },
    {
      label: 'addIfcDoor Thickness=Infinity',
      build: (c, s) => c.addIfcDoor(s, { Position: [0, 0, 0], Width: 0.9, Height: 2.1, Thickness: Infinity }),
    },
    {
      label: 'addIfcWindow Height=NaN',
      build: (c, s) => c.addIfcWindow(s, { Position: [0, 0, 0], Width: 1.2, Height: NaN }),
    },
    {
      label: 'addIfcRamp Length=NaN',
      build: (c, s) => c.addIfcRamp(s, { Position: [0, 0, 0], Width: 1.5, Length: NaN, Thickness: 0.2 }),
    },
    {
      label: 'addIfcRamp Rise=Infinity',
      build: (c, s) => c.addIfcRamp(s, { Position: [0, 0, 0], Width: 1.5, Length: 5, Thickness: 0.2, Rise: Infinity }),
    },
    {
      label: 'addIfcRailing Height=NaN',
      build: (c, s) => c.addIfcRailing(s, { Start: [0, 0, 0], End: [5, 0, 0], Height: NaN }),
    },
    {
      label: 'addIfcRailing Width=Infinity',
      build: (c, s) => c.addIfcRailing(s, { Start: [0, 0, 0], End: [5, 0, 0], Height: 1.1, Width: Infinity }),
    },
    {
      label: 'addIfcPlate Thickness=NaN',
      build: (c, s) => c.addIfcPlate(s, { Position: [0, 0, 0], Width: 1, Depth: 1, Thickness: NaN }),
    },
    {
      label: 'addIfcMember Width=NaN',
      build: (c, s) => c.addIfcMember(s, { Start: [0, 0, 0], End: [3, 0, 0], Width: NaN, Height: 0.1 }),
    },
    {
      label: 'addIfcFooting Height=NaN',
      build: (c, s) => c.addIfcFooting(s, { Position: [0, 0, 0], Width: 1, Depth: 1, Height: NaN }),
    },
    {
      label: 'addIfcPile Diameter=NaN',
      build: (c, s) => c.addIfcPile(s, { Position: [0, 0, 0], Length: 5, Diameter: NaN }),
    },
    {
      label: 'addIfcPile RectangularDepth=Infinity',
      build: (c, s) => c.addIfcPile(s, { Position: [0, 0, 0], Length: 5, Diameter: 0.4, IsRectangular: true, RectangularDepth: Infinity }),
    },
    {
      label: 'addIfcSpace Height=NaN',
      build: (c, s) => c.addIfcSpace(s, { Position: [0, 0, 0], Width: 4, Depth: 4, Height: NaN }),
    },
    {
      label: 'addIfcCurtainWall Height=NaN',
      build: (c, s) => c.addIfcCurtainWall(s, { Start: [0, 0, 0], End: [5, 0, 0], Height: NaN }),
    },
    {
      label: 'addIfcCurtainWall Thickness=Infinity',
      build: (c, s) => c.addIfcCurtainWall(s, { Start: [0, 0, 0], End: [5, 0, 0], Height: 3, Thickness: Infinity }),
    },
    {
      label: 'addIfcFurnishingElement Height=NaN',
      build: (c, s) => c.addIfcFurnishingElement(s, { Position: [0, 0, 0], Width: 1, Depth: 1, Height: NaN }),
    },
    {
      label: 'addIfcFurnishingElement Direction=Infinity',
      build: (c, s) => c.addIfcFurnishingElement(s, { Position: [0, 0, 0], Width: 1, Depth: 1, Height: 1, Direction: Infinity }),
    },
    {
      label: 'addIfcBuildingElementProxy Height=NaN',
      build: (c, s) => c.addIfcBuildingElementProxy(s, { Position: [0, 0, 0], Width: 1, Depth: 1, Height: NaN }),
    },
    {
      label: 'addIfcCircularColumn Radius=NaN',
      build: (c, s) => c.addIfcCircularColumn(s, { Position: [0, 0, 0], Radius: NaN, Height: 3 }),
    },
    {
      label: 'addIfcIShapeBeam OverallWidth=NaN',
      build: (c, s) => c.addIfcIShapeBeam(s, {
        Start: [0, 0, 0], End: [5, 0, 0],
        OverallWidth: NaN, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.02,
      }),
    },
    {
      label: 'addIfcIShapeBeam FilletRadius=Infinity',
      build: (c, s) => c.addIfcIShapeBeam(s, {
        Start: [0, 0, 0], End: [5, 0, 0],
        OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.02, FilletRadius: Infinity,
      }),
    },
    {
      label: 'addIfcLShapeMember Thickness=NaN',
      build: (c, s) => c.addIfcLShapeMember(s, { Start: [0, 0, 0], End: [3, 0, 0], Depth: 0.1, Width: 0.1, Thickness: NaN }),
    },
    {
      label: 'addIfcTShapeMember FlangeWidth=NaN',
      build: (c, s) => c.addIfcTShapeMember(s, {
        Start: [0, 0, 0], End: [3, 0, 0], FlangeWidth: NaN, Depth: 0.2, WebThickness: 0.01, FlangeThickness: 0.02,
      }),
    },
    {
      label: 'addIfcUShapeMember Depth=NaN',
      build: (c, s) => c.addIfcUShapeMember(s, {
        Start: [0, 0, 0], End: [3, 0, 0], Depth: NaN, FlangeWidth: 0.1, WebThickness: 0.01, FlangeThickness: 0.02,
      }),
    },
    {
      label: 'addIfcHollowCircularColumn WallThickness=NaN',
      build: (c, s) => c.addIfcHollowCircularColumn(s, { Position: [0, 0, 0], Radius: 0.2, WallThickness: NaN, Height: 3 }),
    },
    {
      label: 'addIfcRectangleHollowBeam XDim=NaN',
      build: (c, s) => c.addIfcRectangleHollowBeam(s, { Start: [0, 0, 0], End: [3, 0, 0], XDim: NaN, YDim: 0.2, WallThickness: 0.01 }),
    },
    {
      label: 'addIfcRectangleHollowBeam InnerFilletRadius=Infinity',
      build: (c, s) => c.addIfcRectangleHollowBeam(s, {
        Start: [0, 0, 0], End: [3, 0, 0], XDim: 0.2, YDim: 0.2, WallThickness: 0.01, InnerFilletRadius: Infinity,
      }),
    },
    {
      label: 'addIfcWallDoor Thickness=Infinity',
      build: (c, s) => {
        const wallId = c.addIfcWall(s, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
        c.addIfcWallDoor(wallId, { Position: [1, 0, 0], Width: 0.9, Height: 2.1, Thickness: Infinity });
      },
    },
    {
      label: 'addIfcWallDoor Width=NaN',
      build: (c, s) => {
        const wallId = c.addIfcWall(s, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
        c.addIfcWallDoor(wallId, { Position: [1, 0, 0], Width: NaN, Height: 2.1 });
      },
    },
    {
      label: 'addIfcWallWindow Thickness=Infinity',
      build: (c, s) => {
        const wallId = c.addIfcWall(s, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
        c.addIfcWallWindow(wallId, { Position: [1, 0, 0.9], Width: 1.2, Height: 1.2, Thickness: Infinity });
      },
    },
    {
      label: 'addIfcWallWindow Height=NaN',
      build: (c, s) => {
        const wallId = c.addIfcWall(s, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
        c.addIfcWallWindow(wallId, { Position: [1, 0, 0.9], Width: 1.2, Height: NaN });
      },
    },
  ];

  it.each(methodCases.map((c) => [c.label, c.build] as const))('rejects %s', (_label, build) => {
    const creator = new IfcCreator();
    const storeyId = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    // The NaN/Infinity value must be rejected before it reaches emitted
    // STEP output. Slope goes through its own bounded-range message
    // ("must be in radians..."); everything else goes through
    // assertPositiveFinite or a dedicated finite-number check — both
    // throw, which is what matters here (previously neither did).
    expect(() => build(creator, storeyId)).toThrow();
  });

  // Distinct-points gap: a non-finite Start/End coordinate makes the
  // computed length NaN, and `NaN <= 0` is false, so the (already-existing)
  // zero-length guard in vecNorm() never fires. Guard the source
  // coordinates instead of trusting the derived length.
  const distinctPointsCases: Array<{ label: string; build: Build }> = [
    {
      label: 'addIfcWall Start=[NaN,0,0]',
      build: (c, s) => c.addIfcWall(s, { Start: [NaN, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 }),
    },
    {
      label: 'addIfcBeam End=[5,0,Infinity]',
      build: (c, s) => c.addIfcBeam(s, { Start: [0, 0, 0], End: [5, 0, Infinity], Width: 0.3, Height: 0.5 }),
    },
    {
      label: 'addIfcMember Start=[NaN,0,0]',
      build: (c, s) => c.addIfcMember(s, { Start: [NaN, 0, 0], End: [3, 0, 0], Width: 0.1, Height: 0.1 }),
    },
    {
      label: 'addIfcRailing End=[NaN,0,0]',
      build: (c, s) => c.addIfcRailing(s, { Start: [0, 0, 0], End: [NaN, 0, 0], Height: 1.1 }),
    },
    {
      label: 'addIfcCurtainWall Start=[0,Infinity,0]',
      build: (c, s) => c.addIfcCurtainWall(s, { Start: [0, Infinity, 0], End: [5, 0, 0], Height: 3 }),
    },
    {
      label: 'addIfcIShapeBeam Start=[NaN,0,0]',
      build: (c, s) => c.addIfcIShapeBeam(s, {
        Start: [NaN, 0, 0], End: [5, 0, 0],
        OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.02,
      }),
    },
    {
      label: 'addIfcLShapeMember End=[3,NaN,0]',
      build: (c, s) => c.addIfcLShapeMember(s, { Start: [0, 0, 0], End: [3, NaN, 0], Depth: 0.1, Width: 0.1, Thickness: 0.01 }),
    },
    {
      label: 'addIfcTShapeMember Start=[0,0,Infinity]',
      build: (c, s) => c.addIfcTShapeMember(s, {
        Start: [0, 0, Infinity], End: [3, 0, 0], FlangeWidth: 0.1, Depth: 0.2, WebThickness: 0.01, FlangeThickness: 0.02,
      }),
    },
    {
      label: 'addIfcUShapeMember End=[NaN,0,0]',
      build: (c, s) => c.addIfcUShapeMember(s, {
        Start: [0, 0, 0], End: [NaN, 0, 0], Depth: 0.2, FlangeWidth: 0.1, WebThickness: 0.01, FlangeThickness: 0.02,
      }),
    },
    {
      label: 'addIfcRectangleHollowBeam Start=[NaN,0,0]',
      build: (c, s) => c.addIfcRectangleHollowBeam(s, { Start: [NaN, 0, 0], End: [3, 0, 0], XDim: 0.2, YDim: 0.2, WallThickness: 0.01 }),
    },
  ];

  it.each(distinctPointsCases.map((c) => [c.label, c.build] as const))('rejects %s', (_label, build) => {
    const creator = new IfcCreator();
    const storeyId = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    expect(() => build(creator, storeyId)).toThrow(/finite coordinates/);
  });

  // Pin the pre-existing `<= 0` behaviour: still rejected after the fix.
  it('still rejects non-positive dimensions (pre-existing behaviour, unchanged)', () => {
    const creator = new IfcCreator();
    const storeyId = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    expect(() => creator.addIfcColumn(storeyId, { Position: [0, 0, 0], Width: 0, Depth: 0.3, Height: 3 }))
      .toThrow(/positive finite number/);
    expect(() => creator.addIfcColumn(storeyId, { Position: [0, 0, 0], Width: -2, Depth: 0.3, Height: 3 }))
      .toThrow(/positive finite number/);
    expect(() => creator.addIfcWall(storeyId, { Start: [1, 1, 0], End: [1, 1, 0], Thickness: 0.2, Height: 3 }))
      .toThrow(/zero-length vector/);
  });
});
