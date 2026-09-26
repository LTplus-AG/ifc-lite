#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate `rust/export/src/generated/step_log_tables.rs` (#5941): the schema
 * facts the Rust mutation-log STEP writer needs and has no registry for at
 * runtime, computed by RUNNING the TypeScript `StepExporter`'s own functions
 * rather than by re-deriving them. The Rust writer's parity target is that
 * exporter, byte for byte, so the only source of truth that cannot drift from
 * it is the code itself:
 *
 *  - attribute NAMES per record type and source schema, recovered from
 *    `attrIndex` (`subset-entity-reader.ts`) — the lookup `applyAttributeMutations`
 *    uses to place a named edit — over every candidate name;
 *  - ENUM and STRING slots (`getEnumTypedSlots` / `getStringTypedSlots`,
 *    `attribute-slot-types.ts`), which decide how a named edit is serialized;
 *  - REAL slots per data schema (`getRealTypedSlots`, `attribute-real-slots.ts`);
 *  - the `IfcValue` leaves a regenerated property's `NominalValue` may be
 *    declared as, with the relaxation `declaredNominalValueType` applies to a
 *    value outside a constrained member's domain (`declared-property-type.ts`).
 *
 * Run: `node scripts/generate-step-log-tables.mjs` to write the file,
 * `--check` to verify it is current. Needs the workspace packages built
 * (`@ifc-lite/parser` / `@ifc-lite/data` resolve to their `dist/`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

// The functions are TypeScript; re-exec under the workspace's `tsx` loader,
// the same pattern as `generate-enum-reconciliation.mjs`.
if (!process.env.STEP_LOG_TABLES_TSX) {
  const loader = createRequire(SELF).resolve('tsx');
  try {
    execFileSync(process.execPath, ['--import', loader, SELF, ...process.argv.slice(2)], {
      stdio: 'inherit',
      // The root tsconfig maps `@ifc-lite/*` to `dist/*.d.ts` for the
      // typechecker; tsx would follow those to declaration files with no
      // runtime exports. A paths-free config lets the export sources resolve
      // their workspace links to the built `dist/` instead.
      env: { ...process.env, STEP_LOG_TABLES_TSX: '1', TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.tests.base.json') },
    });
  } catch (err) {
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
  process.exit(0);
}

const OUT_REL = 'rust/export/src/generated/step_log_tables.rs';
const src = async (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const { attrIndex } = await src('packages/export/src/subset-entity-reader.ts');
const { getEnumTypedSlots, getStringTypedSlots } = await src('packages/export/src/attribute-slot-types.ts');
const { getRealTypedSlots } = await src('packages/export/src/attribute-real-slots.ts');
const { declaredNominalValueType, CONSTRAINED_IFC_VALUE_MEMBERS } = await src(
  'packages/export/src/declared-property-type.ts',
);
const { getSelectDefinedLeaves } = await src('packages/export/src/select-qualification.ts');
const { isTypeClass } = await src('packages/export/src/type-owned-psets.ts');
const { readRelationshipSlotLowerBound } = await src('packages/export/src/relationship-slot-bounds.ts');
const { NONREL_REF_LIST_TYPES, NONREL_REF_LIST_REGISTRY_NAMES } = await src('packages/export/src/nonrel-ref-list-types.ts');
const { STYLE_RESCUE_TYPES } = await src('packages/export/src/style-closure.ts');
const { resolveExpressBase } = await src('packages/export/src/step-serialization.ts');
const { getAttributeNamesForSchema, getAllAttributesForEntity, SCHEMA_REGISTRY, getSchemaRegistryForVersion } = await src('packages/parser/dist/index.js');
const { ENTITIES_IFC2X3, ENTITIES_IFC4_EXPRESS, ENTITIES_IFC4X3, PropertyValueType } = await src('packages/data/dist/index.js');
const { ENTITY_NAME_ALIASES, getAttributeNamesAcrossSchemas } = await src('packages/parser/dist/ifc-schema.js');

const registries = [
  (await src('packages/parser/src/generated/ifc2x3/schema-registry.ts')).SCHEMA_REGISTRY,
  (await src('packages/parser/src/generated/schema-registry.ts')).SCHEMA_REGISTRY,
  (await src('packages/parser/src/generated/ifc4x3/schema-registry.ts')).SCHEMA_REGISTRY,
];

// Every name a record type can arrive as: each table's entities, each
// registry's entities, and every alias key.
const universe = new Map(); // UPPER -> a spelling attrIndex accepts
const addName = (name) => {
  const upper = name.toUpperCase();
  if (!universe.has(upper)) universe.set(upper, name);
};
for (const table of [ENTITIES_IFC2X3, ENTITIES_IFC4_EXPRESS, ENTITIES_IFC4X3]) for (const e of table) addName(e.name);
for (const registry of registries) for (const name of Object.keys(registry.entities)) addName(name);
for (const alias of Object.keys(ENTITY_NAME_ALIASES)) addName(alias);

// Candidate attribute names: every name any table or registry declares.
const candidates = new Set();
for (const table of [ENTITIES_IFC2X3, ENTITIES_IFC4_EXPRESS, ENTITIES_IFC4X3]) {
  for (const e of table) for (const a of e.attributes) candidates.add(a);
}
for (const registry of registries) {
  for (const meta of Object.values(registry.entities)) {
    for (const a of meta.allAttributes ?? meta.attributes ?? []) candidates.add(a.name);
  }
}

/** The name list `attrIndex(type, _, schema)` resolves against, recovered by
 *  asking it where every candidate sits. `null` when it resolves nothing. */
function namesFor(type, schema) {
  const placed = [];
  for (const name of candidates) {
    const i = attrIndex(type, name, schema);
    if (i >= 0) placed.push([i, name]);
  }
  if (placed.length === 0) return null;
  placed.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [i, name] of placed) {
    if (out[i] !== undefined) continue; // indexOf answers the FIRST occurrence
    out[i] = name;
  }
  // A duplicated name leaves a hole where its later occurrence sits; fill it
  // with a name no edit can ask for, so positions stay aligned.
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = '';
  return out;
}

const mask = (slots, type) => {
  let m = 0n;
  for (const i of slots) {
    if (i >= 64) throw new Error(`${type}: slot ${i} does not fit a u64 mask`);
    m |= 1n << BigInt(i);
  }
  return m;
};

const lists = new Map(); // joined -> index
const listIndex = (names) => {
  if (names === null) return 'NONE';
  const key = names.join('\u0000');
  if (!lists.has(key)) lists.set(key, lists.size);
  return String(lists.get(key));
};

const rows = [];
for (const upper of [...universe.keys()].sort()) {
  const type = universe.get(upper);
  const across = getAttributeNamesAcrossSchemas(type);
  const names = [
    namesFor(type, 'IFC2X3'),
    namesFor(type, 'IFC4'),
    namesFor(type, 'IFC4X3'),
    namesFor(type, undefined),
  ];
  // `attrIndex` without a schema is `getAttributeNamesAcrossSchemas(type).indexOf`;
  // the recovery above must reproduce it exactly or the table is wrong.
  if ((names[3] ?? []).join('|') !== across.map((n, i) => (across.indexOf(n) === i ? n : '')).join('|')) {
    throw new Error(`${type}: recovered cross-schema names disagree with getAttributeNamesAcrossSchemas`);
  }
  // `getAttributeNamesForSchema`, which `resolveEffectiveEntityRecord` reads.
  const registryNames = ['IFC2X3', 'IFC4', 'IFC4X3'].map((v) => {
    const n = getAttributeNamesForSchema(type, v);
    return n.length > 0 ? n : null;
  });
  const enums = mask(getEnumTypedSlots(type), type);
  const strings = mask(getStringTypedSlots(type), type);
  const reals = ['IFC2X3', 'IFC4', 'IFC4X3'].map((v) => mask(getRealTypedSlots(type, v), type));
  if (names.every((n) => n === null) && registryNames.every((n) => n === null) && enums === 0n && strings === 0n && reals.every((r) => r === 0n)) continue;
  rows.push(
    `    (${JSON.stringify(upper)}, [${[...names, ...registryNames].map(listIndex).join(', ')}], ${enums}, ${strings}, [${reals.join(', ')}]),`,
  );
}

// `IfcValue` leaves, with the member a value outside a constrained leaf's
// domain relaxes to. -1 violates every constrained member's WHERE rule.
const leaves = [];
for (const [name, base] of getSelectDefinedLeaves('IfcValue')) {
  const constrained = CONSTRAINED_IFC_VALUE_MEMBERS.includes(name);
  let relaxed = '';
  if (constrained) {
    const shape = base === 'INTEGER' ? PropertyValueType.Integer : PropertyValueType.Real;
    relaxed = declaredNominalValueType(-1, shape, name.toUpperCase()) ?? '';
  }
  leaves.push([name.toUpperCase(), name, base, constrained, relaxed]);
}
leaves.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

// Record types `isTypeClass` answers yes for: the owners of `HasPropertySets`,
// whose property sets the exporter repoints rather than relates.
const typeObjects = [...universe.keys()].sort().filter((upper) => isTypeClass(upper));

// Retype (`retype.ts`): each schema table's attribute list and PredefinedType
// domain, as `lookupEntityInfo` reads them.
const retypeRows = [];
for (const [schema, table] of [['IFC2X3', ENTITIES_IFC2X3], ['IFC4', ENTITIES_IFC4_EXPRESS], ['IFC4X3', ENTITIES_IFC4X3]]) {
  for (const e of table) {
    retypeRows.push(`    (${JSON.stringify(schema)}, ${JSON.stringify(e.name.toUpperCase())}, ${listIndex([...e.attributes])}, ${listIndex([...e.predefinedTypes])}),`);
  }
}
retypeRows.sort();

// Select qualification (`select-qualification.ts`): non-aggregate SELECT slots
// of the pinned registry, and each select's defined-type leaves.
const selectSlotRows = [];
const selectsUsed = new Set();
for (const upper of [...universe.keys()].sort()) {
  getAllAttributesForEntity(universe.get(upper)).forEach((attr, i) => {
    if (!attr.isArray && !attr.isList && !attr.isSet && Object.hasOwn(SCHEMA_REGISTRY.selects, attr.type)) {
      selectSlotRows.push(`    (${JSON.stringify(upper)}, ${i}, ${JSON.stringify(attr.type)}),`);
      selectsUsed.add(attr.type);
    }
  });
}
const selectLeafRows = [];
for (const sel of [...selectsUsed].sort()) {
  for (const [member, base] of getSelectDefinedLeaves(sel)) {
    selectLeafRows.push(`    (${JSON.stringify(sel)}, ${JSON.stringify(member)}, ${JSON.stringify(base)}),`);
  }
}
const definedBaseRows = Object.keys(SCHEMA_REGISTRY.types)
  .map((t) => [t, resolveExpressBase(t)])
  .filter(([, b]) => b !== null)
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  .map(([t, b]) => `    (${JSON.stringify(t)}, ${JSON.stringify(b)}),`);

// Aggregate slot bounds the reference filters read: style records through
// `readRelationshipSlotLowerBound`, the non-relationship narrowing through
// the registry slot `readAggregateSlot` reads.
const styleBoundRows = [];
const nonrelRows = [];
for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3']) {
  for (const upper of [...STYLE_RESCUE_TYPES].sort()) {
    for (let i = 0; i < 64; i++) {
      const lb = readRelationshipSlotLowerBound(upper, i, schema);
      if (lb !== undefined) styleBoundRows.push(`    (${JSON.stringify(schema)}, ${JSON.stringify(upper)}, ${i}, ${lb}),`);
    }
  }
  const registry = getSchemaRegistryForVersion(schema);
  for (const upper of [...NONREL_REF_LIST_TYPES].sort()) {
    const attrs = registry.entities[NONREL_REF_LIST_REGISTRY_NAMES.get(upper)]?.allAttributes ?? [];
    attrs.forEach((attr, i) => {
      if (!(attr.isList || attr.isSet)) return;
      const lb = attr.arrayBounds?.[0];
      if (lb === undefined || !Number.isFinite(lb)) return;
      nonrelRows.push(`    (${JSON.stringify(schema)}, ${JSON.stringify(upper)}, ${i}, ${attr.optional}, ${lb}),`);
    });
  }
}

const listRows = [...lists.keys()].map((key) => {
  const names = key.split('\u0000');
  return `    &[${names.map((n) => JSON.stringify(n)).join(', ')}],`;
});

const text = `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Schema facts for the mutation-log STEP writer (\`crate::step_log\`, #5941),
//! computed by running the TypeScript \`StepExporter\`'s own functions, which
//! are that writer's parity target: \`attrIndex\`, \`getEnumTypedSlots\`,
//! \`getStringTypedSlots\`, \`getRealTypedSlots\` and
//! \`declaredNominalValueType\`.
//!
//! DO NOT EDIT - regenerate with
//!   node scripts/generate-step-log-tables.mjs

/// Attribute-name lists, shared between rows. An empty name marks a position
/// whose declared name repeats an earlier one (\`indexOf\` never reaches it).
pub static NAME_LISTS: &[&[&str]] = &[
${listRows.join('\n')}
];

/// Index into [\`NAME_LISTS\`], or none.
pub const NONE: u16 = u16::MAX;

/// \`(UPPERCASE type, name lists [attrIndex for IFC2X3, IFC4, IFC4X3, no
/// schema; getAttributeNamesForSchema for IFC2X3, IFC4, IFC4X3], enum-slot
/// mask, string-slot mask, REAL-slot masks for [IFC2X3, IFC4, IFC4X3])\`,
/// sorted by type for binary search.
pub type SlotRow = (&'static str, [u16; 7], u64, u64, [u64; 3]);

pub static SLOT_ROWS: &[SlotRow] = &[
${rows.join('\n')}
];

/// \`(schema, UPPERCASE type, attribute list, PredefinedType list)\` from
/// each schema's entity table (\`retype.ts\`'s \`lookupEntityInfo\`), sorted.
pub static RETYPE_ROWS: &[(&str, &str, u16, u16)] = &[
${retypeRows.join('\n')}
];

/// \`(UPPERCASE type, slot, SELECT name)\` for every non-aggregate SELECT slot
/// (\`getSelectSlots\`), sorted.
pub static SELECT_SLOTS: &[(&str, u8, &str)] = &[
${selectSlotRows.join('\n')}
];

/// \`(SELECT, defined-type member, EXPRESS base)\` (\`getSelectDefinedLeaves\`),
/// sorted by SELECT, members in the registry's order.
pub static SELECT_LEAVES: &[(&str, &str, &str)] = &[
${selectLeafRows.join('\n')}
];

/// \`(defined type, EXPRESS base)\` (\`resolveExpressBase\`), sorted.
pub static DEFINED_TYPE_BASES: &[(&str, &str)] = &[
${definedBaseRows.join('\n')}
];

/// \`(schema, UPPERCASE style-record type, slot, lower bound)\`
/// (\`readRelationshipSlotLowerBound\`).
pub static STYLE_SLOT_BOUNDS: &[(&str, &str, u8, u32)] = &[
${styleBoundRows.join('\n')}
];

/// \`(schema, UPPERCASE type, slot, optional, lower bound)\` for the aggregate
/// slots of \`NONREL_REF_LIST_TYPES\` (\`readAggregateSlot\`).
pub static NONREL_AGGREGATE_SLOTS: &[(&str, &str, u8, bool, u32)] = &[
${nonrelRows.join('\n')}
];

/// UPPERCASE record types whose inheritance chain reaches \`IfcTypeObject\`
/// (\`isTypeClass\`), sorted.
pub static TYPE_OBJECT_CLASSES: &[&str] = &[
${typeObjects.map((t) => `    ${JSON.stringify(t)},`).join('\n')}
];

/// \`(UPPERCASE token, schema-cased name, EXPRESS base, constrained,
/// relaxed member or "")\` for every defined-type leaf of \`IfcValue\`,
/// sorted by token.
pub static NOMINAL_VALUE_LEAVES: &[(&str, &str, &str, bool, &str)] = &[
${leaves.map((l) => `    (${JSON.stringify(l[0])}, ${JSON.stringify(l[1])}, ${JSON.stringify(l[2])}, ${l[3]}, ${JSON.stringify(l[4])}),`).join('\n')}
];
`;

const outPath = join(ROOT, OUT_REL);
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(outPath, 'utf8');
  } catch {
    current = '';
  }
  if (current !== text) {
    console.error(`${OUT_REL} is stale; run: node scripts/generate-step-log-tables.mjs`);
    process.exit(1);
  }
  console.log(`${OUT_REL} is up to date (${rows.length} types, ${lists.size} name lists, ${leaves.length} IfcValue leaves).`);
} else {
  writeFileSync(outPath, text);
  console.log(`wrote ${OUT_REL} (${rows.length} types, ${lists.size} name lists, ${leaves.length} IfcValue leaves)`);
}
