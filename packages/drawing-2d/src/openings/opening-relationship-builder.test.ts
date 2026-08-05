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
});
