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
import {
  buildNameTable,
  canonicalNameHash,
  generateTypeNameParser,
  nameBucket,
  nameSlot,
} from '../src/rust-type-name-parser.js';
import { mergeTypeUniverse } from '../src/rust-schema-queries.js';

const SCHEMA_SRC = `
  SCHEMA TEST_RUST;

  TYPE IfcGloballyUniqueId = STRING(22);
  END_TYPE;

  TYPE IfcWallTypeEnum = ENUMERATION OF (STANDARD, NOTDEFINED);
  END_TYPE;

  TYPE IfcObjectDefinition = SELECT (IfcWall);
  END_TYPE;

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
const cratePrivateRust = generateRust(schema, [], true);

const LEGACY_SCHEMA_SRC = `
  SCHEMA TEST_LEGACY;

  ENTITY IfcLegacyDoorStyle
    SUBTYPE OF (IfcRoot);
    LegacyOperation : OPTIONAL STRING;
  END_ENTITY;

  END_SCHEMA;
`;

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

  it('emits one perfect-hash slot per uppercase schema name', () => {
    const { slots } = buildNameTable(['IFCRELAGGREGATES', 'IFCROOT', 'IFCWALL']);
    expect(rust.schema).toContain(`            ${slots.indexOf('IFCWALL')} => Self::IfcWall,`);
    // The slot's own UPPERCASE spelling, not the hash, decides a hit.
    expect(rust.schema).toContain('(ifc_type.as_str() == s).then_some(ifc_type)');
    expect(rust.schema).toContain('if !(7..=16).contains(&s.len()) {');
  });

  it('hashes names with the same word hash the Rust twin uses (#7914)', () => {
    // Pinned values, checked against the Rust twin: the short (<8 bytes),
    // one-word, multi-word and longest-keyword paths.
    expect(canonicalNameHash('IFCWALL')).toBe(0x11910e62d26b7d80n);
    expect(canonicalNameHash('IFCSLAB1')).toBe(0x64e05037afdcfc42n);
    expect(canonicalNameHash('IFCCARTESIANPOINT')).toBe(0x890facf81f35a55n);
    expect(canonicalNameHash('IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM')).toBe(0x5212d2e531bf5494n);
    expect(rust.schema).toContain('fn canonical_name_hash(bytes: &[u8]) -> u64 {');
    expect(rust.schema).toContain('const K: u64 = 0x9e37_79b9_7f4a_7c15;');
    expect(() => canonicalNameHash('IFC')).toThrow(/at least 4 bytes/);
    expect(() => canonicalNameHash('IFCWÄLL')).toThrow(/ASCII/);
  });

  it('places every name on the slot the generated lookup computes', () => {
    // Many similar names stress the displacement search like a real schema.
    const names = Array.from({ length: 1200 }, (_, i) => `IFC${'ABCDEFGH'[i % 8]}NAME${i}${'XYZ'.repeat(i % 7)}`);
    const { displacements, slots } = buildNameTable(names);
    expect(new Set(slots).size).toBe(names.length);
    expect(slots).toHaveLength(names.length);
    for (const name of names) {
      const hash = canonicalNameHash(name);
      const displacement = displacements[nameBucket(hash, displacements.length)];
      expect(displacement).toBeLessThanOrEqual(0xffff);
      expect(slots[nameSlot(hash, displacement, names.length)]).toBe(name);
    }
  });

  it('refuses to generate two names that share a hash', () => {
    expect(() => generateTypeNameParser({
      ...schema,
      entities: [schema.entities[0], schema.entities[0]],
    })).toThrow(/canonical_name_hash collision/);
  });

  it('maps from_id on the CRC32 id', () => {
    expect(rust.schema).toContain(`${crc32('IfcWall')} => Some(Self::IfcWall),`);
    expect(rust.schema).toContain('_ => None,');
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
    // IfcRoot is the root: its parent() arm falls through to the shared None.
    const parentBody = rust.schema.split('pub fn parent(&self) -> Option<Self> {')[1]
      .split('    /// Check if this type is a subtype')[0];
    expect(parentBody).not.toContain('Self::IfcRoot => Some(');
  });

  it('emits is_abstract() arms only for ABSTRACT entities', () => {
    expect(rust.schema).toContain('Self::IfcRoot => true,');
    expect(rust.schema).not.toContain('Self::IfcWall => true,');
  });

  it('records the entity count in the doc comment', () => {
    expect(rust.schema).toContain(`All ${schema.entities.length} entity types`);
  });
});

describe('generateRust — crate-private registries', () => {
  it('keeps the generated enum and universe inside the consuming crate', () => {
    expect(cratePrivateRust.schema).toContain('pub(crate) enum IfcType');
    expect(cratePrivateRust.schema).toContain('pub(crate) static ALL: &[IfcType]');
  });

  it('documents why unused full-universe helpers are allowed', () => {
    expect(cratePrivateRust.schema).toContain(
      '#![allow(dead_code, clippy::enum_variant_names)] // Full EXPRESS names are required; registry consumers currently use only name lookup and attribute slots.',
    );
  });
});

describe('generateRust — supported schema type universe (#4203)', () => {
  const legacySchema = parseExpressSchema(LEGACY_SCHEMA_SRC);
  const universeRust = generateRust(schema, [legacySchema]);

  it('resolves an entity that exists only in a supplemental schema by exact name', () => {
    expect(universeRust.schema).toContain('    IfcLegacyDoorStyle,\n');
    expect(universeRust.schema).toMatch(/^ {12}\d+ => Self::IfcLegacyDoorStyle,$/m);
    expect(universeRust.schema).toContain('Self::IfcLegacyDoorStyle => "IFCLEGACYDOORSTYLE",');
    expect(universeRust.schema).toContain(
      'Self::IfcLegacyDoorStyle => "IfcLegacyDoorStyle",'
    );
  });

  it('does not borrow version-specific attribute positions from another schema', () => {
    expect(universeRust.schema).toContain('Self::IfcLegacyDoorStyle => &[],');
    expect(universeRust.schema).not.toContain(
      'Self::IfcLegacyDoorStyle => &["GlobalId", "LegacyOperation"]'
    );
  });

  it('keeps the canonical per-schema catalog scoped to the canonical schema', () => {
    const all = universeRust.schema.slice(universeRust.schema.indexOf('pub static ALL:')).split('];')[0];
    expect(all).toContain('IfcType::IfcWall,');
    expect(all).not.toContain('IfcType::IfcLegacyDoorStyle,');
  });

  it('lists the supplemental-only names so tests can reach every dispatch arm (#7914)', () => {
    const supplemental = universeRust.schema
      .split('pub(crate) static SUPPLEMENTAL: &[IfcType] = &[')[1]
      .split('];')[0];
    expect(supplemental).toContain('IfcType::IfcLegacyDoorStyle,');
    expect(supplemental).not.toContain('IfcType::IfcWall,');
    const universe = mergeTypeUniverse(schema, [legacySchema]).entities.length;
    expect(universeRust.schema).toContain(`pub(crate) const CANONICAL_NAME_ARMS: usize = ${universe};`);
    expect(universeRust.schema.match(/^ {12}\d+ => Self::\w+,$/gm)).toHaveLength(universe);
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
