/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
});
