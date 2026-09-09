/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { SCHEMA_REGISTRY } from './schema-registry.js';
import {
  assertNonEmptyRegistry,
  getSchemaRegistryForVersion,
  type SchemaRegistry,
} from './schema-registry-by-version.js';

describe('getSchemaRegistryForVersion', () => {
  it('returns a populated registry for each of the three codegen schema versions', () => {
    for (const version of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
      const registry = getSchemaRegistryForVersion(version);
      expect(Object.keys(registry.entities).length).toBeGreaterThan(600);
    }
  });

  it('answers IFC4 with the exact same object the package already exports as SCHEMA_REGISTRY', () => {
    // Byte-stability requirement (#4202): adding per-version selection must
    // not move the pre-existing IFC4 answer.
    expect(getSchemaRegistryForVersion('IFC4')).toBe(SCHEMA_REGISTRY);
  });

  it('answers each version with its own schema name, not a shared/default one', () => {
    expect(getSchemaRegistryForVersion('IFC2X3').name).toBe('IFC2X3');
    expect(getSchemaRegistryForVersion('IFC4').name).toBe('IFC4_ADD2_TC1');
  });

  it('throws an error naming the bad version and listing supported ones for an unknown version', () => {
    // @ts-expect-error — exercising the runtime guard for a caller that
    // bypasses the SchemaVersionWithRegistry type (e.g. an untyped string
    // read off a parsed model's schemaVersion).
    expect(() => getSchemaRegistryForVersion('IFC4X1')).toThrow(
      /getSchemaRegistryForVersion\("IFC4X1"\): no codegen-generated registry exists.*Supported versions: IFC2X3, IFC4, IFC4X3/s,
    );
  });
});

describe('assertNonEmptyRegistry — fail loud on zero (mutation target)', () => {
  it('throws on an empty registry rather than returning it', () => {
    const empty: SchemaRegistry = { name: 'IFC4', entities: {}, types: {}, enums: {}, selects: {} };
    expect(() => assertNonEmptyRegistry(empty, 'IFC4')).toThrow(/zero entities/);
  });

  it('passes through a non-empty registry unchanged', () => {
    const one: SchemaRegistry = {
      name: 'IFC4',
      entities: { IfcWall: { name: 'IfcWall', isAbstract: false, attributes: [] } },
      types: {},
      enums: {},
      selects: {},
    };
    expect(assertNonEmptyRegistry(one, 'IFC4')).toBe(one);
  });
});
