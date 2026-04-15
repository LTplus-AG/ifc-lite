/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for Georeferencing Extractor
 */

import { describe, it, expect } from 'vitest';
import { extractGeoreferencing, transformToWorld, transformToLocal, getCoordinateSystemDescription, computeAngleToGridNorth } from '../src/georef-extractor.js';
import type { IfcEntity } from '../src/entity-extractor.js';

describe('Georeferencing Extractor', () => {
  it('should extract IfcMapConversion', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(100, {
      expressId: 100,
      type: 'IfcMapConversion',
      attributes: [
        '#1',      // SourceCRS
        '#2',      // TargetCRS
        500000.0,  // Eastings
        4000000.0, // Northings
        100.0,     // OrthogonalHeight
        1.0,       // XAxisAbscissa (cos 0°)
        0.0,       // XAxisOrdinate (sin 0°)
        1.0,       // Scale
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMapConversion', [100]);

    const georef = extractGeoreferencing(entities, entitiesByType);

    expect(georef.hasGeoreference).toBe(true);
    expect(georef.mapConversion).toBeDefined();
    expect(georef.mapConversion?.eastings).toBe(500000.0);
    expect(georef.mapConversion?.northings).toBe(4000000.0);
    expect(georef.mapConversion?.orthogonalHeight).toBe(100.0);
    expect(georef.mapConversion?.scale).toBe(1.0);
  });

  it('should extract IfcProjectedCRS', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(200, {
      expressId: 200,
      type: 'IfcProjectedCRS',
      attributes: [
        'EPSG:32610',     // Name (UTM Zone 10N)
        'WGS 84 / UTM zone 10N',
        'WGS84',          // GeodeticDatum
        null,             // VerticalDatum
        'Universal Transverse Mercator',  // MapProjection
        '10N',            // MapZone
        null,             // MapUnit
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcProjectedCRS', [200]);

    const georef = extractGeoreferencing(entities, entitiesByType);

    expect(georef.hasGeoreference).toBe(true);
    expect(georef.projectedCRS).toBeDefined();
    expect(georef.projectedCRS?.name).toBe('EPSG:32610');
    expect(georef.projectedCRS?.geodeticDatum).toBe('WGS84');
    expect(georef.projectedCRS?.mapProjection).toBe('Universal Transverse Mercator');
    expect(georef.projectedCRS?.mapZone).toBe('10N');
  });

  it('should compute transformation matrix', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(100, {
      expressId: 100,
      type: 'IfcMapConversion',
      attributes: [
        '#1', '#2',
        1000.0,  // Eastings
        2000.0,  // Northings
        50.0,    // Height
        1.0,     // XAxisAbscissa (no rotation)
        0.0,     // XAxisOrdinate
        1.0,     // Scale
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMapConversion', [100]);

    const georef = extractGeoreferencing(entities, entitiesByType);

    expect(georef.transformMatrix).toBeDefined();
    expect(georef.transformMatrix).toHaveLength(16);

    // Check translation components (last column)
    expect(georef.transformMatrix![12]).toBe(1000.0);  // X offset
    expect(georef.transformMatrix![13]).toBe(2000.0);  // Y offset
    expect(georef.transformMatrix![14]).toBe(50.0);    // Z offset
  });

  it('should transform point to world coordinates', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(100, {
      expressId: 100,
      type: 'IfcMapConversion',
      attributes: [
        '#1', '#2',
        1000.0,  // Eastings
        2000.0,  // Northings
        50.0,    // Height
        1.0,     // No rotation
        0.0,
        1.0,     // No scale
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMapConversion', [100]);

    const georef = extractGeoreferencing(entities, entitiesByType);

    // Transform local point (10, 20, 5) to world coordinates
    const localPoint: [number, number, number] = [10, 20, 5];
    const worldPoint = transformToWorld(localPoint, georef);

    expect(worldPoint).toBeDefined();
    expect(worldPoint![0]).toBeCloseTo(1010.0);  // 1000 + 10
    expect(worldPoint![1]).toBeCloseTo(2020.0);  // 2000 + 20
    expect(worldPoint![2]).toBeCloseTo(55.0);    // 50 + 5
  });

  it('should transform point to local coordinates', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(100, {
      expressId: 100,
      type: 'IfcMapConversion',
      attributes: [
        '#1', '#2',
        1000.0,  // Eastings
        2000.0,  // Northings
        50.0,    // Height
        1.0,     // No rotation
        0.0,
        1.0,     // No scale
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMapConversion', [100]);

    const georef = extractGeoreferencing(entities, entitiesByType);

    // Transform world point back to local
    const worldPoint: [number, number, number] = [1010, 2020, 55];
    const localPoint = transformToLocal(worldPoint, georef);

    expect(localPoint).toBeDefined();
    expect(localPoint![0]).toBeCloseTo(10.0);
    expect(localPoint![1]).toBeCloseTo(20.0);
    expect(localPoint![2]).toBeCloseTo(5.0);
  });

  it('should handle rotation in transformation', () => {
    const entities = new Map<number, IfcEntity>();

    // 90 degree rotation (cos(90°) = 0, sin(90°) = 1)
    entities.set(100, {
      expressId: 100,
      type: 'IfcMapConversion',
      attributes: [
        '#1', '#2',
        0.0,   // Eastings
        0.0,   // Northings
        0.0,   // Height
        0.0,   // XAxisAbscissa (cos 90°)
        1.0,   // XAxisOrdinate (sin 90°)
        1.0,   // Scale
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMapConversion', [100]);

    const georef = extractGeoreferencing(entities, entitiesByType);

    // Transform point (1, 0, 0) with 90° rotation
    const localPoint: [number, number, number] = [1, 0, 0];
    const worldPoint = transformToWorld(localPoint, georef);

    expect(worldPoint).toBeDefined();
    expect(worldPoint![0]).toBeCloseTo(0.0, 5);  // Should rotate to Y axis
    expect(worldPoint![1]).toBeCloseTo(1.0, 5);
    expect(worldPoint![2]).toBeCloseTo(0.0, 5);
  });

  it('computes angle from XAxisAbscissa/XAxisOrdinate using cos/sin semantics', () => {
    expect(computeAngleToGridNorth(1, 0)).toBeCloseTo(0);
    expect(computeAngleToGridNorth(0, 1)).toBeCloseTo(90);
    expect(computeAngleToGridNorth(1, -1)).toBeCloseTo(-45);
    expect(computeAngleToGridNorth(-1, 0)).toBeCloseTo(180);
    expect(computeAngleToGridNorth(undefined, 1)).toBeNull();
    expect(computeAngleToGridNorth(undefined, undefined)).toBeNull();
  });

  it('should get coordinate system description', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(100, {
      expressId: 100,
      type: 'IfcMapConversion',
      attributes: ['#1', '#2', 500000, 4000000, 100, 1, 0, 1],
    });

    entities.set(200, {
      expressId: 200,
      type: 'IfcProjectedCRS',
      attributes: ['EPSG:32610', null, 'WGS84', null, 'UTM', '10N', null],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMapConversion', [100]);
    entitiesByType.set('IfcProjectedCRS', [200]);

    const georef = extractGeoreferencing(entities, entitiesByType);

    const description = getCoordinateSystemDescription(georef);

    expect(description).toContain('EPSG:32610');
    expect(description).toContain('WGS84');
    expect(description).toContain('500000');
    expect(description).toContain('4000000');
  });

  it('should handle missing georeferencing', () => {
    const entities = new Map<number, IfcEntity>();
    const entitiesByType = new Map<string, number[]>();

    const georef = extractGeoreferencing(entities, entitiesByType);

    expect(georef.hasGeoreference).toBe(false);
    expect(georef.mapConversion).toBeUndefined();
    expect(georef.projectedCRS).toBeUndefined();

    const description = getCoordinateSystemDescription(georef);
    expect(description).toBe('Local Engineering Coordinates');
  });
});
