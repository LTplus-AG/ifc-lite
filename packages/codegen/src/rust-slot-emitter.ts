/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `rust/core/src/generated/slots.rs`: one typed attribute slot per
 * (entity, attribute), flattened across the supertype chain (F3e-0b, #7780).
 *
 * The positions are not a second table. They are the positions the registries
 * already emit as `IfcType::attribute_names()` (supertype attributes first),
 * read per bundled schema, then classified:
 *
 *   stable    the same position in every schema that declares the entity;
 *   trailing  the same position where present, and past the end of the
 *             record in every schema where the attribute is absent (reading it
 *             there yields None either way);
 *   moving    everything else.
 *
 * A stable or trailing attribute becomes a `Slot<Kind>` const. A moving one
 * becomes a `SchemaSlot<Kind>`, which has no `index()` and can only be read
 * after it is resolved against a `SchemaVersion`.
 *
 * A slot is named by the canonical IFC4X3 attribute name (an entity that
 * IFC4X3 does not declare uses the newest schema that does). Same-position
 * renames between releases are listed in `schemas/attribute-renames.json`;
 * every row is validated here, and a row whose names sit at different
 * positions fails generation, so a rename can never cover a move. A semantic
 * replacement (CompositionType -> PredefinedType, ...) is not a rename: it
 * stays a moving slot and reads as absent in the older schema.
 */

import type { EntityDefinition, ExpressSchema } from './express-parser.js';
import { getAllAttributes } from './express-parser.js';
import { AttributeKindResolver, KIND } from './rust-attribute-flags.js';
import type { AttributeRenameRow, RenameTable } from './rust-slot-renames.js';

/** Mirrors `SchemaVersion` (declaration order) in rust/core/src/generated/schema_registry.rs. */
export const SLOT_SCHEMAS = ['Ifc2x3', 'Ifc4', 'Ifc4x1', 'Ifc4x2', 'Ifc4x3'] as const;
export type SlotSchema = (typeof SLOT_SCHEMAS)[number];

/** Value of an absent `by_schema` entry (`ABSENT` in rust/core/src/slot.rs). */
export const ABSENT = 255;

const KIND_NAMES = ['Ref', 'RefList', 'List', 'Real', 'Int', 'Text', 'Enum', 'Logical', 'Binary', 'Select'] as const;

export interface SlotSchemaInput {
  readonly version: SlotSchema;
  readonly schema: ExpressSchema;
}

export interface SlotAttribute {
  /** SCREAMING_SNAKE const name. */
  readonly constName: string;
  /** Canonical attribute name. */
  readonly name: string;
  readonly kind: string;
  /** Canonical position (the position in `owner`'s newest declaring schema). */
  readonly index: number;
  /** `null` for a Slot; per-schema positions (ABSENT = 255) for a SchemaSlot. */
  readonly bySchema: readonly number[] | null;
}

export interface SlotEntity {
  readonly name: string;
  readonly attributes: readonly SlotAttribute[];
}

/** Resolve a schema label ("IFC4_ADD2_TC1", "IFC4X3_DEV_…") to its `SlotSchema`. */
export function slotSchemaOf(schemaName: string): SlotSchema {
  const upper = schemaName.toUpperCase();
  const family = (label: string) => upper === label || new RegExp(`^${label}(?![0-9A-Z])`).test(upper);
  if (family('IFC4X3')) return 'Ifc4x3';
  if (family('IFC4X2')) return 'Ifc4x2';
  if (family('IFC4X1')) return 'Ifc4x1';
  if (family('IFC4')) return 'Ifc4';
  if (family('IFC2X3')) return 'Ifc2x3';
  throw new Error(`slot schema "${schemaName}" is not a bundled IFC family`);
}

/** `URLReference` -> `URL_REFERENCE`, `UAxes` -> `U_AXES`, `DeltaT_Constant` -> `DELTA_T_CONSTANT`. */
export function screamingSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/__+/g, '_')
    .toUpperCase();
}

interface PerSchema {
  readonly version: SlotSchema;
  readonly names: Map<string, string[]>;
  readonly kinds: Map<string, number[]>;
  readonly parent: Map<string, string | undefined>;
}

function layoutOf(input: SlotSchemaInput): PerSchema {
  const resolver = new AttributeKindResolver(input.schema);
  const names = new Map<string, string[]>();
  const kinds = new Map<string, number[]>();
  const parent = new Map<string, string | undefined>();
  for (const entity of input.schema.entities) {
    const attributes = getAllAttributes(entity, input.schema);
    names.set(entity.name, attributes.map((a) => a.name));
    kinds.set(entity.name, attributes.map((a) => resolver.flagByte(a) & 0x0f));
    parent.set(entity.name, entity.supertype);
  }
  return { version: input.version, names, kinds, parent };
}

/** The set of entities (with subtypes, across every schema) a rename row covers. */
function renameScope(row: AttributeRenameRow, schemas: readonly PerSchema[]): Set<string> {
  const scope = new Set<string>();
  const roots = new Set(row.entities);
  for (const schema of schemas) {
    for (const entity of schema.names.keys()) {
      for (let current: string | undefined = entity, depth = 0; current && depth < 64; depth++) {
        if (roots.has(current)) {
          scope.add(entity);
          break;
        }
        current = schema.parent.get(current);
      }
    }
  }
  return scope;
}

/**
 * Classify every (entity, attribute) of `entities` across the schemas.
 * `canonical` is the IFC4X3 input; `others` are the older releases.
 */
export function classifySlots(
  canonical: SlotSchemaInput,
  others: readonly SlotSchemaInput[],
  table: RenameTable,
  entityFilter: (name: string) => boolean,
): SlotEntity[] {
  const { renames, omit } = table;
  const inputs = [canonical, ...others];
  const omitted = new Set(omit.map((o) => `${o.entity}.${o.attribute}`));
  const omitUsed = new Set<string>();
  const seenVersions = new Set<string>();
  for (const input of inputs) {
    if (seenVersions.has(input.version)) throw new Error(`slot schema ${input.version} given twice`);
    seenVersions.add(input.version);
  }
  const schemas = inputs.map(layoutOf);
  // Newest first, so an entity IFC4X3 does not declare takes the next newest.
  const byAge = [...schemas].sort(
    (a, b) => SLOT_SCHEMAS.indexOf(b.version) - SLOT_SCHEMAS.indexOf(a.version),
  );

  const scopes = renames.map((row) => ({ row, scope: renameScope(row, schemas) }));
  const resolveName = (entity: string, name: string): string => {
    for (const { row, scope } of scopes) {
      if (scope.has(entity) && row.aliases.includes(name)) return row.name;
    }
    return name;
  };

  const allNames = new Set<string>();
  for (const schema of schemas) for (const name of schema.names.keys()) allNames.add(name);

  const out: SlotEntity[] = [];
  for (const entity of [...allNames].sort()) {
    if (!entityFilter(entity)) continue;
    const declaring = byAge.filter((s) => s.names.has(entity));
    const home = declaring[0];
    const homeRaw = home.names.get(entity)!;
    const homeKinds = home.kinds.get(entity)!;
    const homeNames = homeRaw.map((n) => resolveName(entity, n));
    assertUnique(entity, home.version, homeNames);

    // Each declaring schema's normalised names, with alias positions validated.
    const normalised = new Map<SlotSchema, string[]>();
    for (const schema of declaring) {
      const raw = schema.names.get(entity)!;
      const names = raw.map((n) => resolveName(entity, n));
      assertUnique(entity, schema.version, names);
      normalised.set(schema.version, names);
    }
    for (const { row, scope } of scopes) {
      if (!scope.has(entity)) continue;
      for (const alias of row.aliases) {
        for (const schema of declaring) {
          const raw = schema.names.get(entity)!;
          const at = raw.indexOf(alias);
          if (at < 0) continue;
          const canonicalAt = homeNames.indexOf(row.name);
          if (canonicalAt >= 0 && canonicalAt !== at) {
            throw new Error(
              `rename ${alias} -> ${row.name} on ${entity}: ${alias} is at ${at} in ${schema.version} ` +
                `but ${row.name} is at ${canonicalAt} in ${home.version}; a rename must keep the position`,
            );
          }
        }
      }
    }

    // Every attribute any schema declares: the home schema's, then names only
    // an older release has (IfcAlignment.Axis exists in IFC4X1/4X2 alone), each
    // at the position of the newest schema that has it.
    const slotNames: { name: string; index: number; kind: number }[] = homeNames.map((name, index) => ({
      name,
      index,
      kind: homeKinds[index],
    }));
    for (const schema of declaring.slice(1)) {
      normalised.get(schema.version)!.forEach((name, index) => {
        if (omitted.has(`${entity}.${name}`)) {
          omitUsed.add(`${entity}.${name}`);
        } else if (!slotNames.some((s) => s.name === name)) {
          slotNames.push({ name, index, kind: schema.kinds.get(entity)![index] });
        }
      });
    }

    const attributes: SlotAttribute[] = [];
    const used = new Map<string, string>();
    for (const { name, index, kind: homeKind } of slotNames) {
      if (index >= ABSENT) throw new Error(`${entity}.${name} is at ${index}; a slot index must fit below ${ABSENT}`);
      const bySchema = new Array<number>(SLOT_SCHEMAS.length).fill(ABSENT);
      let moving = false;
      const kinds = new Set<number>([homeKind]);
      for (const schema of declaring) {
        const names = normalised.get(schema.version)!;
        const at = names.indexOf(name);
        const slotIx = SLOT_SCHEMAS.indexOf(schema.version);
        if (at === index) {
          bySchema[slotIx] = index;
          kinds.add(schema.kinds.get(entity)![at]);
        } else if (at < 0 && index >= names.length) {
          // Trailing: past the end of this schema's record, absent either way.
          bySchema[slotIx] = index;
        } else {
          moving = true;
          bySchema[slotIx] = at < 0 ? ABSENT : at;
          if (at >= 0) kinds.add(schema.kinds.get(entity)![at]);
        }
      }
      const constName = screamingSnake(name);
      const clash = used.get(constName);
      if (clash) throw new Error(`${entity}: ${name} and ${clash} both name the slot ${constName}`);
      used.set(constName, name);
      // A kind that differs between schemas is only safely read as Select.
      const kind = kinds.size === 1 ? homeKind : KIND.Select;
      attributes.push({
        constName,
        name,
        kind: KIND_NAMES[kind],
        index,
        bySchema: moving ? bySchema : null,
      });
    }
    out.push({ name: entity, attributes });
  }
  for (const key of omitted) {
    if (!omitUsed.has(key)) throw new Error(`attribute-renames.json: omit row ${key} matches no older-release attribute`);
  }
  return out;
}

function assertUnique(entity: string, version: SlotSchema, names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`${entity} in ${version}: attribute ${name} appears twice after renames`);
    seen.add(name);
  }
}

function slotsSource(entities: readonly SlotEntity[], canonicalName: string): string {
  const header = `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Auto-generated typed attribute slots.
//!
//! Generated from the bundled EXPRESS schemas (canonical: ${canonicalName}).
//! One zero-sized struct per entity, inherited attributes flattened in:
//! \`slot::IfcWall::OBJECT_PLACEMENT\`. A \`Slot\` has the same position in every
//! bundled schema that declares the entity; a \`SchemaSlot\` moves and must be
//! resolved against a \`SchemaVersion\` before it can be read.
//!
//! DO NOT EDIT - This file is auto-generated by @ifc-lite/codegen

#![allow(clippy::unreadable_literal)]

use super::type_ids as ids;
use crate::generated::IfcType;
#[allow(unused_imports)]
use crate::slot::kind::{Binary, Enum, Int, List, Logical, Real, Ref, RefList, Select, Text};
use crate::slot::{SchemaSlot, Slot, ABSENT};

`;
  const body = entities
    .map((entity) => {
      const owner = `ids::${entity.name.toUpperCase()}`;
      const consts = entity.attributes
        .map((a) =>
          a.bySchema === null
            ? `    pub const ${a.constName}: Slot<${a.kind}> = Slot::new(${a.index}, ${owner});`
            : `    pub const ${a.constName}: SchemaSlot<${a.kind}> = SchemaSlot::new([${a.bySchema
                .map((v) => (v === ABSENT ? 'ABSENT' : String(v)))
                .join(', ')}], ${owner});`,
        )
        .join('\n');
      return `/// \`${entity.name}\` attribute slots.
pub struct ${entity.name};

impl ${entity.name} {
    /// The entity type these slots belong to.
    pub const IFC_TYPE: IfcType = IfcType::${entity.name};
${consts}
}
`;
    })
    .join('\n');
  return header + body;
}

/**
 * `generated/slots_table.rs`: every generated slot with its entity and attribute
 * name, bound to the consts themselves, for the independent re-derivation in
 * `rust/core/src/slot_tests.rs`. `#[cfg(test)]` and a file of its own, so a
 * normal build neither reads nor parses it.
 */
function tableSource(entities: readonly SlotEntity[], canonicalName: string): string {
  const rows = entities
    .flatMap((entity) =>
      entity.attributes.map(
        (a) =>
          `        ${a.bySchema === null ? 'fixed' : 'moving'}("${entity.name}", "${a.name}", ${entity.name}::${a.constName}),`,
      ),
    )
    .join('\n');
  return `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Auto-generated test-only index of the typed attribute slots.
//!
//! Generated from the bundled EXPRESS schemas (canonical: ${canonicalName}).
//!
//! DO NOT EDIT - This file is auto-generated by @ifc-lite/codegen

use super::slots::*;
use crate::slot::tests::{fixed, moving, Row};

/// Every generated slot, for the tests that re-derive the classification.
pub(crate) fn table() -> Vec<Row> {
    vec![
${rows}
    ]
}
`;
}

export interface GeneratedSlots {
  /** `generated/slots.rs`. */
  readonly slots: string;
  /** `generated/slots_table.rs` (test-only). */
  readonly table: string;
}

/** Emit `generated/slots.rs` and its test-only index. */
export function generateSlots(
  canonical: SlotSchemaInput,
  others: readonly SlotSchemaInput[],
  typeUniverse: readonly EntityDefinition[],
  table: RenameTable,
): GeneratedSlots {
  const inUniverse = new Set(typeUniverse.map((e) => e.name));
  const entities = classifySlots(canonical, others, table, (name) => inUniverse.has(name));
  return {
    slots: slotsSource(entities, canonical.schema.name),
    table: tableSource(entities, canonical.schema.name),
  };
}
