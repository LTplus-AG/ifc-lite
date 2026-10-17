/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the per-attribute flag bytes (packages/codegen/src/rust-attribute-flags.ts)
 * behind `IfcType::attribute_flags()` (F3e-0a, #7780).
 *
 * Two layers: a synthetic schema that pins each classification rule, and the
 * five committed registries, whose every flag byte is compared with the parsed
 * EXPRESS declaration (OPTIONAL and the aggregate keyword are read straight
 * off `AttributeDefinition`, independent of the resolver's type walk).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllAttributes, parseExpressSchema } from '../src/express-parser.js';
import {
  AttributeKindResolver,
  FLAG_AGGREGATE,
  FLAG_OPTIONAL,
  KIND,
} from '../src/rust-attribute-flags.js';

const SCHEMA_SRC = `
  SCHEMA TEST_FLAGS;
  TYPE IfcLabel = STRING(255); END_TYPE;
  TYPE IfcCount = INTEGER; END_TYPE;
  TYPE IfcPositive = IfcCount; END_TYPE;
  TYPE IfcLength = REAL; END_TYPE;
  TYPE IfcIndex = LIST [2:?] OF IfcPositive; END_TYPE;
  TYPE IfcBlob = BINARY; END_TYPE;
  TYPE IfcFlag = BOOLEAN; END_TYPE;
  TYPE IfcKind = ENUMERATION OF (A, B); END_TYPE;
  TYPE IfcValue = SELECT (IfcLabel, IfcLength); END_TYPE;
  TYPE IfcShape = SELECT (IfcPoint, IfcCurve); END_TYPE;
  TYPE IfcPointSet = SET [1:?] OF IfcPoint; END_TYPE;
  TYPE IfcPointOrSet = SELECT (IfcPoint, IfcPointSet); END_TYPE;
  ENTITY IfcPoint; END_ENTITY;
  ENTITY IfcCurve; END_ENTITY;
  ENTITY IfcThing;
    Label : IfcLabel;
    Maybe : OPTIONAL IfcLength;
    Count : IfcPositive;
    Index : IfcIndex;
    Blob : IfcBlob;
    Flag : IfcFlag;
    Raw : LOGICAL;
    Kind : IfcKind;
    Value : IfcValue;
    One : IfcPoint;
    Either : IfcShape;
    Many : LIST [1:?] OF IfcPoint;
    Grid : LIST [1:?] OF LIST [1:?] OF IfcPoint;
    Reals : ARRAY [1:3] OF REAL;
    Sets : SET [1:?] OF IfcValue;
    OneOrMany : IfcPointOrSet;
  END_ENTITY;
  END_SCHEMA;
`;

describe('AttributeKindResolver', () => {
  const schema = parseExpressSchema(SCHEMA_SRC);
  const resolver = new AttributeKindResolver(schema);
  const thing = schema.entities.find((e) => e.name === 'IfcThing')!;
  const flags = Object.fromEntries(
    getAllAttributes(thing, schema).map((a) => [a.name, resolver.flagByte(a)]),
  );

  it.each([
    ['Label', KIND.Text],
    ['Maybe', KIND.Real | FLAG_OPTIONAL],
    ['Count', KIND.Int],
    ['Index', KIND.List | FLAG_AGGREGATE],
    ['Blob', KIND.Binary],
    ['Flag', KIND.Logical],
    ['Raw', KIND.Logical],
    ['Kind', KIND.Enum],
    ['Value', KIND.Select],
    ['One', KIND.Ref],
    ['Either', KIND.Ref],
    ['Many', KIND.RefList | FLAG_AGGREGATE],
    ['Grid', KIND.List | FLAG_AGGREGATE],
    ['Reals', KIND.List | FLAG_AGGREGATE],
    ['Sets', KIND.List | FLAG_AGGREGATE],
    ['OneOrMany', KIND.Select | FLAG_AGGREGATE],
  ])('%s', (name, expected) => {
    expect(flags[name]).toBe(expected);
  });

  it('refuses a type it cannot classify instead of defaulting', () => {
    const broken = parseExpressSchema(
      'SCHEMA B;\nENTITY IfcX;\n  A : IfcNowhere;\nEND_ENTITY;\nEND_SCHEMA;\n',
    );
    const attr = broken.entities[0].attributes[0];
    expect(() => new AttributeKindResolver(broken).flagByte(attr)).toThrow(/IfcNowhere/);
  });
});

describe('committed registries', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemas = join(here, '../schemas');
  const generated = join(here, '../../../rust/core/src/generated');
  const registries: [string, string][] = [
    ['IFC2X3_TC1.exp', 'ifc2x3/schema.rs'],
    ['IFC4_ADD2_TC1.exp', 'ifc4/schema.rs'],
    ['IFC4X1.exp', 'ifc4x1/schema.rs'],
    ['IFC4X2.exp', 'ifc4x2/schema.rs'],
    ['IFC4X3.exp', 'schema.rs'],
  ];

  it.each(registries)('%s flags equal the EXPRESS declaration (%s)', (expFile, rustFile) => {
    const schema = parseExpressSchema(readFileSync(join(schemas, expFile), 'utf8'));
    const rust = readFileSync(join(generated, rustFile), 'utf8');
    const arms = (fn: string): Map<string, string> => {
      // @source-text-assertion-ok asserts on the committed generator output (the registry under test), not unexecuted production source
      const body = rust.slice(rust.indexOf(`pub fn ${fn}(`));
      // @source-text-assertion-ok asserts on the committed generator output (the registry under test), not unexecuted production source
      const end = body.indexOf('Self::Unknown(_)');
      const map = new Map<string, string>();
      for (const m of body.slice(0, end).matchAll(/Self::(\w+) => (?:\{\s*)?&\[([^\]]*)\]/g)) {
        map.set(m[1], m[2]);
      }
      return map;
    };
    const names = arms('attribute_names');
    const flags = arms('attribute_flags');
    expect(flags.size).toBe(names.size);

    let checked = 0;
    for (const entity of schema.entities) {
      const attributes = getAllAttributes(entity, schema);
      const emitted = (flags.get(entity.name) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
      expect(emitted.length).toBe(attributes.length);
      attributes.forEach((attribute, i) => {
        const direct = attribute.isList || attribute.isArray || attribute.isSet;
        expect((emitted[i] & FLAG_OPTIONAL) !== 0, `${entity.name}.${attribute.name} optional`).toBe(
          attribute.optional,
        );
        // A directly declared aggregate is always flagged; the flag may also
        // be set by a defined aggregate type or a select alternative.
        if (direct) {
          expect(emitted[i] & FLAG_AGGREGATE, `${entity.name}.${attribute.name} aggregate`).toBe(
            FLAG_AGGREGATE,
          );
        }
        expect(emitted[i] & 0xc0).toBe(0);
        expect(emitted[i] & 0x0f).toBeLessThanOrEqual(KIND.Select);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(2000);
  });
});
