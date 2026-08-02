/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for Georeferencing Extractor
 */

import { describe, it, expect } from 'vitest';
import { extractGeoreferencing, transformToWorld, transformToLocal, getCoordinateSystemDescription, computeAngleToGridNorth } from '../src/georef-extractor.js';
import type { IfcEntity } from '../src/entity-extractor.js';
import { getAttributeNames } from '../src/ifc-schema.js';

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

  it('extracts legacy IFC2X3 IfcSite geolocation', () => {
    const entities = new Map<number, IfcEntity>();
    const siteAttrNames = getAttributeNames('IfcSite');
    const attributes = new Array(siteAttrNames.length).fill(null);
    attributes[siteAttrNames.indexOf('RefLatitude')] = [50, 2, 20];
    attributes[siteAttrNames.indexOf('RefLongitude')] = [14, 28, 0];
    attributes[siteAttrNames.indexOf('RefElevation')] = 245;

    entities.set(300, {
      expressId: 300,
      type: 'IfcSite',
      attributes,
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcSite', [300]);

    const georef = extractGeoreferencing(entities, entitiesByType);

    expect(georef.hasGeoreference).toBe(true);
    expect(georef.source).toBe('siteLocation');
    expect(georef.projectedCRS?.name).toBe('EPSG:4326');
    expect(georef.projectedCRS?.description).toBe('Legacy IfcSite geolocation');
    expect(georef.mapConversion?.eastings).toBeCloseTo(14.4666667, 6);
    expect(georef.mapConversion?.northings).toBeCloseTo(50.0388889, 6);
    expect(georef.mapConversion?.orthogonalHeight).toBe(245);
    expect(georef.transformMatrix).toBeUndefined();
    expect(getCoordinateSystemDescription(georef)).toContain('Site:');
  });

  // Helper for the IFC2x3 ePSet_MapConversion fixtures. Values mirror the
  // Rust parity fixtures in rust/processing/src/georeferencing.rs so the
  // two extractors are pinned to identical outputs.
  function epsetEntities(name: string) {
    const entities = new Map<number, IfcEntity>();
    entities.set(1, {
      expressId: 1,
      type: 'IfcPropertySingleValue',
      attributes: ['Eastings', null, 1000.5, null],
    });
    entities.set(2, {
      expressId: 2,
      type: 'IfcPropertySingleValue',
      attributes: ['Northings', null, 2000.25, null],
    });
    entities.set(3, {
      expressId: 3,
      type: 'IfcPropertySingleValue',
      attributes: ['OrthogonalHeight', null, 42, null],
    });
    entities.set(4, {
      expressId: 4,
      type: 'IfcPropertySet',
      attributes: ['0PSet00000000000000001', null, name, null, ['#1', '#2', '#3']],
    });
    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcPropertySingleValue', [1, 2, 3]);
    entitiesByType.set('IfcPropertySet', [4]);
    return { entities, entitiesByType };
  }

  it('extracts IFC2X3 ePSet_MapConversion fallback (Rust parity)', () => {
    for (const name of ['ePSet_MapConversion', 'EPset_MapConversion']) {
      const { entities, entitiesByType } = epsetEntities(name);
      const georef = extractGeoreferencing(entities, entitiesByType);

      expect(georef.hasGeoreference).toBe(true);
      expect(georef.source).toBe('ePSetMapConversion');
      expect(georef.mapConversion?.eastings).toBeCloseTo(1000.5, 9);
      expect(georef.mapConversion?.northings).toBeCloseTo(2000.25, 9);
      expect(georef.mapConversion?.orthogonalHeight).toBeCloseTo(42, 9);
      expect(georef.transformMatrix?.[12]).toBeCloseTo(1000.5, 9);
    }
  });

  it('prefers ePSet_MapConversion over the legacy site fallback (Rust precedence)', () => {
    const { entities, entitiesByType } = epsetEntities('ePSet_MapConversion');

    const siteAttrNames = getAttributeNames('IfcSite');
    const attributes = new Array(siteAttrNames.length).fill(null);
    attributes[siteAttrNames.indexOf('RefLatitude')] = [50, 2, 20];
    attributes[siteAttrNames.indexOf('RefLongitude')] = [14, 28, 0];
    entities.set(300, { expressId: 300, type: 'IfcSite', attributes });
    entitiesByType.set('IfcSite', [300]);

    const georef = extractGeoreferencing(entities, entitiesByType);
    expect(georef.source).toBe('ePSetMapConversion');
    expect(georef.mapConversion?.eastings).toBeCloseTo(1000.5, 9);
  });

  it('ignores property sets that are not the map-conversion ePSet', () => {
    const { entities, entitiesByType } = epsetEntities('Pset_SomethingElse');
    const georef = extractGeoreferencing(entities, entitiesByType);
    expect(georef.hasGeoreference).toBe(false);
    expect(georef.source).toBeUndefined();
  });

  // Real-world casing written by the `ifc-georeferencer` post-processor:
  // `ePset_…` (lowercase s), which an exact match missed → models fell back
  // to the legacy IfcSite EPSG:4326 and displayed the wrong CRS.
  it('matches the ePset name case-insensitively (ifc-georeferencer casing)', () => {
    for (const name of ['ePset_MapConversion', 'epset_mapconversion', 'EPSET_MAPCONVERSION']) {
      const { entities, entitiesByType } = epsetEntities(name);
      const georef = extractGeoreferencing(entities, entitiesByType);
      expect(georef.source).toBe('ePSetMapConversion');
      expect(georef.mapConversion?.eastings).toBeCloseTo(1000.5, 9);
    }
  });

  it('surfaces the EPSG code from ePset_ProjectedCRS.Name', () => {
    const { entities, entitiesByType } = epsetEntities('ePset_MapConversion');
    // ePset_ProjectedCRS with a single Name property (EPSG:7415 = RD + NAP).
    entities.set(10, {
      expressId: 10,
      type: 'IfcPropertySingleValue',
      attributes: ['Name', null, 'EPSG:7415', null],
    });
    entities.set(11, {
      expressId: 11,
      type: 'IfcPropertySet',
      attributes: ['0PSet00000000000000002', null, 'ePset_ProjectedCRS', null, ['#10']],
    });
    entitiesByType.set('IfcPropertySingleValue', [1, 2, 3, 10]);
    entitiesByType.set('IfcPropertySet', [4, 11]);

    const georef = extractGeoreferencing(entities, entitiesByType);
    expect(georef.source).toBe('ePSetMapConversion');
    expect(georef.projectedCRS?.name).toBe('EPSG:7415');
  });

  it('falls back to MapConversion.TargetCRS when no ePset_ProjectedCRS exists', () => {
    const { entities, entitiesByType } = epsetEntities('ePset_MapConversion');
    // Add a string TargetCRS property to the map-conversion pset.
    entities.set(5, {
      expressId: 5,
      type: 'IfcPropertySingleValue',
      attributes: ['TargetCRS', null, 'EPSG:28992', null],
    });
    const pset = entities.get(4)!;
    pset.attributes[4] = ['#1', '#2', '#3', '#5'];
    entitiesByType.set('IfcPropertySingleValue', [1, 2, 3, 5]);

    const georef = extractGeoreferencing(entities, entitiesByType);
    expect(georef.source).toBe('ePSetMapConversion');
    expect(georef.projectedCRS?.name).toBe('EPSG:28992');
  });

  // A bare-numeric EPSG `Name` ("7415") and a `MapZone` like "31N" must stay
  // strings — over-eager numeric coercion used to drop them before the CRS was
  // assembled, leaving the gate without a name.
  it('preserves numeric-looking CRS metadata as strings', () => {
    const { entities, entitiesByType } = epsetEntities('ePset_MapConversion');
    entities.set(10, {
      expressId: 10,
      type: 'IfcPropertySingleValue',
      attributes: ['Name', null, '7415', null],
    });
    entities.set(11, {
      expressId: 11,
      type: 'IfcPropertySingleValue',
      attributes: ['MapZone', null, '31N', null],
    });
    entities.set(12, {
      expressId: 12,
      type: 'IfcPropertySet',
      attributes: ['0PSet00000000000000002', null, 'ePset_ProjectedCRS', null, ['#10', '#11']],
    });
    entitiesByType.set('IfcPropertySingleValue', [1, 2, 3, 10, 11]);
    entitiesByType.set('IfcPropertySet', [4, 12]);

    const georef = extractGeoreferencing(entities, entitiesByType);
    expect(georef.projectedCRS?.name).toBe('7415');
    expect(georef.projectedCRS?.mapZone).toBe('31N');
  });

  // A model placed at the projected-CRS origin (offsets all 0) but carrying a
  // real CRS name is a valid georeference and must not drop to EPSG:4326.
  it('keeps a zero-origin ePSet georeference when a CRS name is present', () => {
    const { entities, entitiesByType } = epsetEntities('ePset_MapConversion');
    (entities.get(1)!.attributes as unknown[])[2] = 0;
    (entities.get(2)!.attributes as unknown[])[2] = 0;
    (entities.get(3)!.attributes as unknown[])[2] = 0;
    entities.set(10, {
      expressId: 10,
      type: 'IfcPropertySingleValue',
      attributes: ['Name', null, 'EPSG:28992', null],
    });
    entities.set(11, {
      expressId: 11,
      type: 'IfcPropertySet',
      attributes: ['0PSet00000000000000002', null, 'ePset_ProjectedCRS', null, ['#10']],
    });
    entitiesByType.set('IfcPropertySingleValue', [1, 2, 3, 10]);
    entitiesByType.set('IfcPropertySet', [4, 11]);

    const georef = extractGeoreferencing(entities, entitiesByType);
    expect(georef.source).toBe('ePSetMapConversion');
    expect(georef.projectedCRS?.name).toBe('EPSG:28992');
    expect(georef.mapConversion?.eastings).toBe(0);
  });

  // An explicit ePSet MapUnit label carries its own scale (parity with the
  // native IfcProjectedCRS path); direct consumers must not assume metres.
  it('infers mapUnitScale from an explicit ePSet MapUnit label', () => {
    const { entities, entitiesByType } = epsetEntities('ePset_MapConversion');
    entities.set(10, {
      expressId: 10,
      type: 'IfcPropertySingleValue',
      attributes: ['Name', null, 'EPSG:2225', null],
    });
    entities.set(11, {
      expressId: 11,
      type: 'IfcPropertySingleValue',
      attributes: ['MapUnit', null, 'FOOT', null],
    });
    entities.set(12, {
      expressId: 12,
      type: 'IfcPropertySet',
      attributes: ['0PSet00000000000000002', null, 'ePset_ProjectedCRS', null, ['#10', '#11']],
    });
    entitiesByType.set('IfcPropertySingleValue', [1, 2, 3, 10, 11]);
    entitiesByType.set('IfcPropertySet', [4, 12]);

    const georef = extractGeoreferencing(entities, entitiesByType);
    expect(georef.projectedCRS?.mapUnit).toBe('FOOT');
    expect(georef.projectedCRS?.mapUnitScale).toBe(0.3048);
  });
});
