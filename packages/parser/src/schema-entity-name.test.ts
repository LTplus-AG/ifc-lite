/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { getSchemaRegistryForVersion, type SchemaRegistry } from './generated/schema-registry-by-version.js';
import { getCanonicalEntityName } from './schema-entity-name.js';
import { getAttributeNamesForSchema, getAttributeTypeForSchema } from './ifc-schema.js';

describe('canonical registry lookup #7362', () => {
  it('matches every real schema key and preserves unknown/schema boundaries', () => {
    for (const version of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
      const registry = getSchemaRegistryForVersion(version);
      for (const key of Object.keys(registry.entities)) {
        expect(getCanonicalEntityName(registry, key.toUpperCase())).toBe(key);
        expect(getCanonicalEntityName(registry, key.toLowerCase())).toBe(key);
      }
      for (const unknown of ['IfcUnknown7362', '__proto__', 'constructor', '']) expect(getCanonicalEntityName(registry, unknown)).toBeUndefined();
    }
    expect(getCanonicalEntityName(getSchemaRegistryForVersion('IFC4'), 'IFCRAILWAY')).toBeUndefined();
    expect(getCanonicalEntityName(getSchemaRegistryForVersion('IFC4X3'), 'IFCRAILWAY')).toBe('IfcRailway');
    expect(getAttributeNamesForSchema('IFCTASK', 'IFC4')).toContain('IsMilestone');
    expect(getAttributeTypeForSchema('IFCTASK', 'IsMilestone', 'IFC4')).toBe('IfcBoolean');
  });

  it('retains ordered first-match behavior through public registry extension, deletion and reordering', () => {
    const base = getSchemaRegistryForVersion('IFC4');
    const registry: SchemaRegistry = { ...base, entities: { IfcWall: base.entities.IfcWall } };
    expect(getCanonicalEntityName(registry, 'ifcwall')).toBe('IfcWall');
    registry.entities.IFCWALL = base.entities.IfcWall;
    expect(getCanonicalEntityName(registry, 'IFCWALL')).toBe('IfcWall');
    delete registry.entities.IfcWall;
    expect(getCanonicalEntityName(registry, 'IfcWall')).toBe('IFCWALL');
    registry.entities.IfcWall = base.entities.IfcWall;
    expect(getCanonicalEntityName(registry, 'IfcWall')).toBe('IFCWALL');
    delete registry.entities.IFCWALL;
    expect(getCanonicalEntityName(registry, 'IFCWALL')).toBe('IfcWall');
    registry.entities = { IfcRailway: getSchemaRegistryForVersion('IFC4X3').entities.IfcRailway };
    expect(getCanonicalEntityName(registry, 'IfcWall')).toBeUndefined();
    expect(getCanonicalEntityName(registry, 'IFCRAILWAY')).toBe('IfcRailway');
    expect(getCanonicalEntityName(base, 'IFCRAILWAY')).toBeUndefined();
  });

  it('indexes names without reading definitions or caching replaced metadata', () => {
    const base = getSchemaRegistryForVersion('IFC4');
    const entities = { IfcWall: base.entities.IfcWall };
    let reads = 0;
    Object.defineProperty(entities, 'IfcTask', { enumerable: true, configurable: true, get: () => { reads++; return base.entities.IfcTask; } });
    const registry: SchemaRegistry = { ...base, entities };
    expect(getCanonicalEntityName(registry, 'IFCTASK')).toBe('IfcTask');
    expect(reads).toBe(0);
    entities.IfcWall = base.entities.IfcTask;
    const name = getCanonicalEntityName(registry, 'IFCWALL');
    expect(name).toBe('IfcWall');
    expect(registry.entities[name!]).toBe(base.entities.IfcTask);
  });
});
