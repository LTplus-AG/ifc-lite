/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpeningRelationshipBuilder } from './opening-relationship-builder.js';
import type { EntityMetadata } from '../types.js';

describe('OpeningRelationshipBuilder', () => {
  it('computes width from the x-extent and height from the z-extent of bounds', () => {
    const entityMetadata = new Map<number, EntityMetadata>([
      [
        10,
        {
          ifcType: 'IfcOpeningElement',
          bounds: {
            min: { x: 0, y: 0, z: 0 },
            // x-extent (width) = 3, z-extent (height) = 2 -- deliberately
            // different so a width/height axis swap is detectable.
            max: { x: 3, y: 0.2, z: 2 },
          },
        },
      ],
    ]);

    const relationships = new OpeningRelationshipBuilder(entityMetadata)
      .addVoidRelationships([{ hostId: 1, openingId: 10 }])
      .build(0);

    const info = relationships.openingInfo.get(10);
    expect(info).toBeDefined();
    expect(info!.width).toBe(3);
    expect(info!.height).toBe(2);
  });

  it('assigns doorOperation only for door-type openings', () => {
    const entityMetadata = new Map<number, EntityMetadata>([
      [
        10,
        {
          ifcType: 'IfcOpeningElement',
          bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 2 } },
        },
      ],
      [
        20,
        {
          ifcType: 'IfcDoor',
          properties: { OperationType: 'DOUBLE_DOOR_SINGLE_SWING' },
        },
      ],
    ]);

    const relationships = new OpeningRelationshipBuilder(entityMetadata)
      .addVoidRelationships([{ hostId: 1, openingId: 10 }])
      .addFillRelationships([{ openingId: 10, elementId: 20 }])
      .build(0);

    const info = relationships.openingInfo.get(10);
    expect(info?.type).toBe('door');
    expect(info?.doorOperation).toBe('DOUBLE_DOOR_SINGLE_SWING');
  });

  // determineOpeningType has three arms (door / window / bare opening with no
  // symbol type). The test above only exercises the door arm, so a bug that
  // misclassifies a window (e.g. as a door) would pass every existing
  // fixture. Each opening here has a distinct filling type so the three
  // arms are independently observable in one assertion pass.
  it('classifies door, window, and bare openings independently', () => {
    const entityMetadata = new Map<number, EntityMetadata>([
      [10, { ifcType: 'IfcOpeningElement', bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 2 } } }],
      [20, { ifcType: 'IfcDoor' }],
      [30, { ifcType: 'IfcOpeningElement', bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 2 } } }],
      [40, { ifcType: 'IfcWindow' }],
      [50, { ifcType: 'IfcOpeningElement', bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 2 } } }],
    ]);

    const relationships = new OpeningRelationshipBuilder(entityMetadata)
      .addVoidRelationships([
        { hostId: 1, openingId: 10 },
        { hostId: 1, openingId: 30 },
        { hostId: 1, openingId: 50 }, // no fill -> bare opening
      ])
      .addFillRelationships([
        { openingId: 10, elementId: 20 }, // door
        { openingId: 30, elementId: 40 }, // window
      ])
      .build(0);

    expect(relationships.openingInfo.get(10)?.type).toBe('door');
    expect(relationships.openingInfo.get(30)?.type).toBe('window');
    expect(relationships.openingInfo.get(50)?.type).toBe('opening');

    // doorOperation must not leak onto a window-filled opening.
    expect(relationships.openingInfo.get(30)?.doorOperation).toBeUndefined();
  });

  it('assigns windowPartitioning for window-type openings, mirroring doorOperation', () => {
    const entityMetadata = new Map<number, EntityMetadata>([
      [
        10,
        {
          ifcType: 'IfcOpeningElement',
          bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 2 } },
        },
      ],
      [
        20,
        {
          ifcType: 'IfcWindow',
          properties: { PartitioningType: 'DOUBLE_PANEL_HORIZONTAL' },
        },
      ],
    ]);

    const relationships = new OpeningRelationshipBuilder(entityMetadata)
      .addVoidRelationships([{ hostId: 1, openingId: 10 }])
      .addFillRelationships([{ openingId: 10, elementId: 20 }])
      .build(0);

    const info = relationships.openingInfo.get(10);
    expect(info?.type).toBe('window');
    expect(info?.windowPartitioning).toBe('DOUBLE_PANEL_HORIZONTAL');
  });
});

// #8232: the door's operation is the occurrence's unless that is NOTDEFINED/absent, then the type's.
describe('OpeningRelationshipBuilder door operation source (#8232)', () => {
  const opening = { ifcType: 'IfcOpeningElement', bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 2 } } };
  const operationOf = (door: EntityMetadata) =>
    new OpeningRelationshipBuilder(new Map<number, EntityMetadata>([[10, opening], [20, door]]))
      .addVoidRelationships([{ hostId: 1, openingId: 10 }])
      .addFillRelationships([{ openingId: 10, elementId: 20 }])
      .build(0)
      .openingInfo.get(10)?.doorOperation;

  it('takes the occurrence OperationType over the type', () => {
    expect(operationOf({ ifcType: 'IfcDoor', properties: { OperationType: 'SINGLE_SWING_RIGHT' }, typeOperationType: 'SINGLE_SWING_LEFT' }))
      .toBe('SINGLE_SWING_RIGHT');
  });

  it('falls back to the type when the occurrence is NOTDEFINED', () => {
    expect(operationOf({ ifcType: 'IfcDoor', properties: { OperationType: '.NOTDEFINED.' }, typeOperationType: '.SINGLE_SWING_RIGHT.' }))
      .toBe('SINGLE_SWING_RIGHT');
  });

  it('falls back to the type when the occurrence has no properties at all', () => {
    expect(operationOf({ ifcType: 'IfcDoor', typeOperationType: 'SINGLE_SWING_RIGHT' })).toBe('SINGLE_SWING_RIGHT');
  });

  it('keeps the default when neither states a handedness', () => {
    expect(operationOf({ ifcType: 'IfcDoor', properties: { OperationType: 'NOTDEFINED' }, typeOperationType: 'NOTDEFINED' }))
      .toBe('SINGLE_SWING_LEFT');
  });

  // AC20-FZK-Haus.ifc: the occurrence states `$` and its IFCDOORTYPE states .SINGLE_SWING_RIGHT.
  const fzk = new URL('../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  it.skipIf(!existsSync(fzk))('draws the FZK door typed SINGLE_SWING_RIGHT as RIGHT (fixture; pnpm fixtures)', () => {
    const text = readFileSync(fzk, 'latin1');
    // Resolve the door's own type through IfcRelDefinesByType and pass that type's OperationType
    // as the file spells it (dots included), so the builder normalises the raw enum of the type
    // actually assigned rather than receiving the expected answer pre-cleaned.
    expect(/#17468=\s*IFCDOOR\([^;]*?,2\.01,0\.885,\$,\$,\$\);/.test(text)).toBe(true);
    const rel = /IFCRELDEFINESBYTYPE\([^;]*?\((?:[^)]*,)?#17468[,)][^;]*?,#(\d+)\);/.exec(text);
    expect(rel, '#17468 has a type').not.toBeNull();
    const type = new RegExp(`#${rel![1]}=\\s*IFCDOORTYPE\\([^;]*?,\\.NOTDEFINED\\.,(\\.[A-Z_]+\\.),`).exec(text);
    expect(type?.[1], "#17468's type states SINGLE_SWING_RIGHT").toBe('.SINGLE_SWING_RIGHT.');
    expect(operationOf({ ifcType: 'IfcDoor', typeOperationType: type![1] })).toBe('SINGLE_SWING_RIGHT');
  });
});
