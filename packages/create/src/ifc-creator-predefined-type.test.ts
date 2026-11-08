/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification enums written by `IfcCreator`. Before this change every
 * IFC4/IFC4X3 wall was written as `IfcWallTypeEnum.STANDARD`, which
 * buildingSMART deprecates from IFC4 on, and callers could not choose another
 * value. Invariants checked here:
 *  - with no PredefinedType the creator writes NOTDEFINED, never a deprecated value;
 *  - a value is checked against the target schema's own enumeration;
 *  - a refused value throws before anything is emitted;
 *  - IFC2X3 `IfcWall`, which has no PredefinedType, keeps its 8-attribute layout.
 */

import { describe, it, expect } from 'vitest';
import { IfcCreator } from './ifc-creator.js';
import type { WallParams } from './types.js';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

const WALL = { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 } satisfies WallParams;

function setup(schema: Schema) {
  const creator = new IfcCreator({ Schema: schema, Timestamp: 0 });
  const storey = creator.addIfcBuildingStorey({ Name: 'Level 0', Elevation: 0 });
  return { creator, storey };
}

/** The STEP attribute list of the one `type` instance in `content`. */
function attributesOf(content: string, type: string): string[] {
  const line = content.split('\n').find((l) => new RegExp(`^#\\d+=${type}\\(`).test(l));
  if (!line) throw new Error(`no ${type} in output`);
  return line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')).split(',');
}

function wallAttributes(schema: Schema, params: Partial<WallParams> = {}): string[] {
  const { creator, storey } = setup(schema);
  creator.addIfcWall(storey, { ...WALL, ...params });
  return attributesOf(creator.toIfc().content, 'IFCWALL');
}

describe('IfcCreator.addIfcWall PredefinedType', () => {
  it.each(['IFC4', 'IFC4X3'] as const)('defaults to NOTDEFINED, not the deprecated STANDARD, in %s', (schema) => {
    const attrs = wallAttributes(schema);
    expect(attrs).toHaveLength(9);
    expect(attrs[8]).toBe('.NOTDEFINED.');
  });

  it.each(['IFC4', 'IFC4X3'] as const)('writes SOLIDWALL and PARTITIONING as given in %s', (schema) => {
    expect(wallAttributes(schema, { PredefinedType: 'SOLIDWALL' })[8]).toBe('.SOLIDWALL.');
    expect(wallAttributes(schema, { PredefinedType: 'PARTITIONING' })[8]).toBe('.PARTITIONING.');
  });

  it.each(['IFC4', 'IFC4X3'] as const)('refuses the deprecated STANDARD and POLYGONAL in %s', (schema) => {
    const { creator, storey } = setup(schema);
    // @ts-expect-error STANDARD is deprecated and is not part of the accepted type
    expect(() => creator.addIfcWall(storey, { ...WALL, PredefinedType: 'STANDARD' }))
      .toThrow(`addIfcWall: IfcWallTypeEnum.STANDARD is deprecated in ${schema}`);
    // @ts-expect-error POLYGONAL is deprecated and is not part of the accepted type
    expect(() => creator.addIfcWall(storey, { ...WALL, PredefinedType: 'POLYGONAL' }))
      .toThrow(/POLYGONAL is deprecated/);
  });

  it('refuses before emitting anything, so no orphan geometry is left behind', () => {
    const { creator, storey } = setup('IFC4');
    // @ts-expect-error STANDARD is not part of the accepted type
    expect(() => creator.addIfcWall(storey, { ...WALL, PredefinedType: 'STANDARD' })).toThrow();
    const content = creator.toIfc().content;
    expect(content).not.toContain('IFCEXTRUDEDAREASOLID(');
    expect(content).not.toContain('IFCWALL(');
  });

  it('checks the value against the target schema, not a merged list', () => {
    // ELEMENTEDWALL is deprecated in IFC4 and reinstated in IFC4.3.2.0;
    // RETAININGWALL and WAVEWALL only exist from IFC4X3.
    expect(() => wallAttributes('IFC4', { PredefinedType: 'ELEMENTEDWALL' })).toThrow(/ELEMENTEDWALL is deprecated in IFC4/);
    expect(wallAttributes('IFC4X3', { PredefinedType: 'ELEMENTEDWALL' })[8]).toBe('.ELEMENTEDWALL.');
    expect(() => wallAttributes('IFC4', { PredefinedType: 'RETAININGWALL' }))
      .toThrow(/IfcWall\.PredefinedType must be one of .* in IFC4; got RETAININGWALL/);
    expect(wallAttributes('IFC4X3', { PredefinedType: 'RETAININGWALL' })[8]).toBe('.RETAININGWALL.');
  });

  it('lists only current values in the error, so the suggestion is never a deprecated one', () => {
    let message = '';
    try {
      // @ts-expect-error not an IfcWallTypeEnum value
      wallAttributes('IFC4X3', { PredefinedType: 'BRICK' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/must be one of .*SOLIDWALL/);
    expect(message).not.toMatch(/STANDARD|POLYGONAL/);
  });

  it('requires ObjectType for USERDEFINED (IfcWall CorrectPredefinedType rule)', () => {
    expect(() => wallAttributes('IFC4', { PredefinedType: 'USERDEFINED' })).toThrow(/ObjectType is required/);
    const attrs = wallAttributes('IFC4', { PredefinedType: 'USERDEFINED', ObjectType: 'Gabion' });
    expect(attrs[4]).toBe("'Gabion'");
    expect(attrs[8]).toBe('.USERDEFINED.');
  });

  it('keeps the IFC2X3 layout: 8 attributes, no PredefinedType', () => {
    const attrs = wallAttributes('IFC2X3');
    expect(attrs).toHaveLength(8);
    expect(attrs[7]).toBe('$');
    // IFC2X3 IfcWall has no PredefinedType to write a requested value into.
    expect(() => wallAttributes('IFC2X3', { PredefinedType: 'SOLIDWALL' }))
      .toThrow('addIfcWall: IfcWall has no PredefinedType attribute in IFC2X3');
  });
});

describe('IfcCreator PredefinedType on slabs, columns, beams and spaces', () => {
  it('keeps the existing defaults, which are current values', () => {
    for (const schema of ['IFC4', 'IFC4X3'] as const) {
      const { creator, storey } = setup(schema);
      creator.addIfcSlab(storey, { Position: [0, 0, 0], Width: 4, Depth: 4, Thickness: 0.2 });
      creator.addIfcColumn(storey, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
      creator.addIfcBeam(storey, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.4 });
      const content = creator.toIfc().content;
      expect(attributesOf(content, 'IFCSLAB')[8]).toBe('.FLOOR.');
      expect(attributesOf(content, 'IFCCOLUMN')[8]).toBe('.COLUMN.');
      expect(attributesOf(content, 'IFCBEAM')[8]).toBe('.BEAM.');
    }
  });

  it('writes a requested value and refuses one outside the schema', () => {
    const { creator, storey } = setup('IFC4');
    creator.addIfcSlab(storey, { Position: [0, 0, 0], Width: 4, Depth: 4, Thickness: 0.2, PredefinedType: 'ROOF' });
    creator.addIfcColumn(storey, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3, PredefinedType: 'PILASTER' });
    creator.addIfcBeam(storey, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.4, PredefinedType: 'LINTEL' });
    const content = creator.toIfc().content;
    expect(attributesOf(content, 'IFCSLAB')[8]).toBe('.ROOF.');
    expect(attributesOf(content, 'IFCCOLUMN')[8]).toBe('.PILASTER.');
    expect(attributesOf(content, 'IFCBEAM')[8]).toBe('.LINTEL.');

    const other = setup('IFC4');
    // PAVING is an IFC4X3 IfcSlabTypeEnum value.
    expect(() => other.creator.addIfcSlab(other.storey, { Position: [0, 0, 0], Width: 4, Depth: 4, Thickness: 0.2, PredefinedType: 'PAVING' }))
      .toThrow(/IfcSlab\.PredefinedType must be one of .* in IFC4; got PAVING/);
  });

  it('IFC2X3: slab keeps its PredefinedType, column and beam have none', () => {
    const { creator, storey } = setup('IFC2X3');
    creator.addIfcSlab(storey, { Position: [0, 0, 0], Width: 4, Depth: 4, Thickness: 0.2 });
    creator.addIfcColumn(storey, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
    const content = creator.toIfc().content;
    expect(attributesOf(content, 'IFCSLAB')[8]).toBe('.FLOOR.');
    expect(attributesOf(content, 'IFCCOLUMN')).toHaveLength(8);
    expect(() => creator.addIfcColumn(storey, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3, PredefinedType: 'COLUMN' }))
      .toThrow('addIfcColumn: IfcColumn has no PredefinedType attribute in IFC2X3');
  });

  it('IfcSpace: IFC4X3 does not default to the deprecated INTERNAL; IFC4 and IFC2X3 are unchanged', () => {
    const spaceClass = (schema: Schema, PredefinedType?: string): string => {
      const { creator, storey } = setup(schema);
      creator.addIfcSpace(storey, { Position: [0, 0, 0], Width: 4, Depth: 4, Height: 3, PredefinedType });
      return attributesOf(creator.toIfc().content, 'IFCSPACE')[9];
    };
    expect(spaceClass('IFC4X3')).toBe('.NOTDEFINED.');
    expect(spaceClass('IFC4')).toBe('.INTERNAL.');
    expect(spaceClass('IFC2X3')).toBe('.INTERNAL.'); // InteriorOrExteriorSpace
    expect(spaceClass('IFC4X3', 'PARKING')).toBe('.PARKING.');
    expect(() => spaceClass('IFC4X3', 'INTERNAL')).toThrow(/IfcSpaceTypeEnum\.INTERNAL is deprecated in IFC4X3/);
    expect(spaceClass('IFC2X3', 'EXTERNAL')).toBe('.EXTERNAL.');
    expect(() => spaceClass('IFC2X3', 'PARKING')).toThrow(/IfcSpace\.InteriorOrExteriorSpace must be one of/);
  });
});
