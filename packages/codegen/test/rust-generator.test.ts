/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the Rust generator (packages/codegen/src/rust-generator.ts).
 *
 * This emitter produces `rust/core/src/generated/type_ids.rs` and
 * `rust/core/src/generated/schema.rs` — the Rust core's entire notion of what
 * an IFC type IS. Before these tests the whole 700-line module had no test at
 * all: a mutation that emitted `pub const IfcWall` instead of `pub const
 * IFCWALL`, or that lower-cased the `from_str` match arms, produced a green
 * `pnpm test` in this package and only exploded (or, worse, silently
 * mis-classified every entity) the next time someone regenerated the Rust.
 *
 * The identifier CASING rules are the load-bearing part and are pinned in both
 * directions here:
 *   - `type_ids.rs` constants are SCREAMING_CASE (`IFCWALL`), Rust's const
 *     convention.
 *   - `IfcType` enum variants keep the schema's PascalCase (`IfcWall`).
 *   - `from_str` matches on the UPPERCASED name, because it is called with
 *     `s.to_uppercase()`.
 *   - `as_str()` returns the UPPERCASE STEP spelling; `name()` returns the
 *     PascalCase display spelling. These two must not collapse into each other.
 */

import { describe, it, expect } from 'vitest';
import { parseExpressSchema } from '../src/express-parser.js';
import { generateRust } from '../src/rust-generator.js';
import { crc32 } from '../src/crc32.js';

const SCHEMA_SRC = `
  SCHEMA TEST_RUST;

  ENTITY IfcRoot
    ABSTRACT;
    GlobalId : IfcGloballyUniqueId;
  END_ENTITY;

  ENTITY IfcWall
    SUBTYPE OF (IfcRoot);
    PredefinedType : OPTIONAL IfcWallTypeEnum;
  END_ENTITY;

  ENTITY IfcRelAggregates
    SUBTYPE OF (IfcRoot);
    RelatingObject : IfcObjectDefinition;
  END_ENTITY;

  END_SCHEMA;
`;

const schema = parseExpressSchema(SCHEMA_SRC);
const rust = generateRust(schema);

describe('generateRust — type_ids.rs', () => {
  it('emits SCREAMING_CASE constants, not the PascalCase entity name', () => {
    expect(rust.typeIds).toContain(`pub const IFCWALL: u32 = ${crc32('IfcWall')};`);
    // Both directions: the PascalCase spelling must NOT be emitted as a const.
    expect(rust.typeIds).not.toContain('pub const IfcWall:');
  });

  it('emits the CRC32 of the entity name, not of some other spelling', () => {
    // crc32() upcases internally, so IfcWall and IFCWALL hash identically; the
    // value pinned here is the real one shipped in the generated Rust.
    expect(crc32('IfcWall')).toBe(2391406946);
    expect(rust.typeIds).toContain('pub const IFCWALL: u32 = 2391406946;');
  });

  it('covers every entity in the schema exactly once', () => {
    for (const entity of schema.entities) {
      const line = `pub const ${entity.name.toUpperCase()}: u32 = ${crc32(entity.name)};\n`;
      expect(rust.typeIds.split(line).length - 1, entity.name).toBe(1);
    }
  });

  it('stamps the schema name into the module banner', () => {
    expect(rust.typeIds).toContain('Generated from EXPRESS schema: TEST_RUST');
  });
});

describe('generateRust — schema.rs IfcType enum', () => {
  it('declares variants in PascalCase, not SCREAMING_CASE', () => {
    expect(rust.schema).toContain('    IfcWall,\n');
    expect(rust.schema).not.toContain('    IFCWALL,\n');
  });

  it('matches from_str on the UPPERCASE spelling (it is fed s.to_uppercase())', () => {
    expect(rust.schema).toContain('let upper = s.to_uppercase();');
    expect(rust.schema).toContain('"IFCWALL" => Self::IfcWall,');
    // Both directions: a PascalCase match arm would be dead code.
    expect(rust.schema).not.toContain('"IfcWall" => Self::IfcWall,');
  });

  it('maps from_id on the CRC32 id', () => {
    expect(rust.schema).toContain(`${crc32('IfcWall')} => Self::IfcWall,`);
    expect(rust.schema).toContain('_ => Self::Unknown(id),');
  });

  it('id() round-trips the same constant that type_ids.rs exports', () => {
    expect(rust.schema).toContain(`Self::IfcWall => ${crc32('IfcWall')},`);
  });

  it('keeps as_str() UPPERCASE and name() PascalCase (they must not collapse)', () => {
    expect(rust.schema).toContain('Self::IfcWall => "IFCWALL",');
    expect(rust.schema).toContain('Self::IfcWall => "IfcWall",');
  });

  it('emits a parent() arm only for entities that declare SUBTYPE OF', () => {
    expect(rust.schema).toContain('Self::IfcWall => Some(Self::IfcRoot),');
    // IfcRoot is the root: no supertype, so no arm — it falls through to None.
    expect(rust.schema).not.toContain('Self::IfcRoot => Some(');
  });

  it('emits is_abstract() arms only for ABSTRACT entities', () => {
    expect(rust.schema).toContain('Self::IfcRoot => true,');
    expect(rust.schema).not.toContain('Self::IfcWall => true,');
  });

  it('records the entity count in the doc comment', () => {
    expect(rust.schema).toContain(`All ${schema.entities.length} entity types`);
  });
});

describe('generateRust — entity categorisation', () => {
  it('routes IfcRel* entities to the Relationships section', () => {
    const relIdx = rust.typeIds.indexOf('// Relationships');
    expect(relIdx).toBeGreaterThanOrEqual(0);
    const section = rust.typeIds.slice(relIdx);
    expect(section).toContain('pub const IFCRELAGGREGATES:');
  });

  it('drops categories that ended up empty', () => {
    // Nothing in this schema is MEP, so that header must not be emitted.
    expect(rust.typeIds).not.toContain('// MEP');
    expect(rust.schema).not.toContain('// MEP');
  });

  it('assigns every entity to exactly one category', () => {
    for (const entity of schema.entities) {
      const variant = `    ${entity.name},\n`;
      expect(rust.schema.split(variant).length - 1, entity.name).toBe(1);
    }
  });
});
