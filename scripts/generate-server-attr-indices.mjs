#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generates the Rust root-attribute index table the parse server uses to
 * extract Description / ObjectType / Tag / PredefinedType (issue #1765).
 *
 * Parity by construction: the table is derived from the SAME schema registry
 * the in-browser (WASM/columnar) path resolves attribute names against —
 * `SCHEMA_REGISTRY` (IFC4_ADD2_TC1) via `getAttributeNames` in
 * `@ifc-lite/parser` (see `extractRootAttributesFromEntity` /
 * `extractAllEntityAttributes`). Every registry entity gets a row, even when
 * all indices are -1: "known type without the attribute" must NOT fall back
 * to the unknown-type fixed indices [3,4,7] the way a truly unknown type does.
 *
 * Regenerate after a schema-registry change:
 *   pnpm turbo build --filter=@ifc-lite/parser && node scripts/generate-server-attr-indices.mjs
 *   (then `cargo fmt -p ifc-lite-server` — the emitted arms are single-line)
 *
 * `--check` compares the committed file's per-type indices against a fresh
 * derivation from the registry and exits 1 on drift. The comparison is
 * SEMANTIC (parses the indices out of the committed arms), so it's immune to
 * rustfmt reflowing the single-line arms into multiple lines — no Rust
 * toolchain required in CI (issue #1780).
 *
 * ANTI-VACUITY (#3200): a stale or half-built `packages/parser/dist` imports
 * cleanly and exports an empty `SCHEMA_REGISTRY`, and this script used to
 * cooperate with it in the worst possible way. `--check` correctly went red
 * (every committed row reads as stale), but the remedy it printed says
 * "regenerate" — and regenerating against an empty extraction writes a `match`
 * with no arms at all. `root_attr_indices` then returns `None` for every type,
 * which per the note above means every KNOWN type falls back to the
 * unknown-type indices [3,4,7]: exactly the parity break this generator exists
 * to prevent, with `--check` printing ✓ from then on. The `(0 types, …)` count
 * in the success line was the only tell.
 *
 * So the registry is now checked for emptiness before EITHER mode proceeds,
 * the way `generate-bim-globals.mjs` already refuses its own empty schema, and
 * a measured floor stands behind that (see ROW_FLOOR).
 *
 * A row count alone does not close that hole, though — it only moves it one
 * level down. `allAttributes` is OPTIONAL on the registry's `EntityMetadata`
 * (`allAttributes?: AttributeMetadata[]`) and `getAllAttributesForEntity`
 * returns `metadata?.allAttributes || []`, so a registry whose `entities` map
 * is fully populated while `allAttributes` stops being emitted yields a
 * healthy-looking 776 rows in which EVERY row is `[-1,-1,-1,-1]`. Measured on
 * exactly that shape: 776 arms written, exit 0, and `--check` blessing the
 * result from the next run on. Per the generated header, -1 means "known type
 * that does not declare the attribute (never fall back)", so the server-parse
 * path would report Description / ObjectType / Tag / PredefinedType as absent
 * for every entity while the browser resolves them normally — the same parity
 * break, reached by a different route. RESOLVED_FLOOR guards that level.
 *
 * Output: apps/server/src/services/data_model/generated/attr_indices.rs
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = process.argv.includes('--check');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { SCHEMA_REGISTRY, getAttributeNames } = await import(
  join(root, 'packages/parser/dist/index.js')
);

const NAMES = ['Description', 'ObjectType', 'Tag', 'PredefinedType'];

/**
 * Lower bound on how many entity types the registry must yield before this
 * script will write or bless anything.
 *
 * MEASURED, not guessed: a healthy `@ifc-lite/parser` build yields 776 types
 * from IFC4_ADD2_TC1 (the figure `--check` prints on a clean tree). The floor
 * is 700.
 *
 * It used to be 500, justified by needing headroom in case the registry were
 * pointed at a smaller schema (IFC2X3, ~650 entities). That justification was
 * not true: there is no runtime schema selection here. `SCHEMA_REGISTRY` is a
 * single committed codegen artifact pinned to IFC4_ADD2_TC1, and the
 * multi-schema union lives elsewhere — in `ifc-schema.ts`'s
 * `ENTITY_INFO_BY_UPPER`, read by `getAttributeNamesAcrossSchemas`,
 * `getEntityInfoAcrossSchemas` and `getInheritanceChainFromSchemaUnion`, none
 * of which this generator calls (it calls the pinned `getAttributeNames`).
 * Repinning the codegen would be a
 * regenerate-and-commit event, which is exactly what the failure message below
 * already instructs. Measured on the old value: 499 rows refused and 500 rows
 * WROTE, replacing all 776 committed arms and exiting 0 — so the 500..775 band
 * was unguarded slack that bought nothing. 700 keeps ~10% headroom under
 * today's 776 for ordinary schema churn while shrinking that band.
 */
const ROW_FLOOR = 700;

/**
 * Lower bound on how many of those rows must actually RESOLVE at least one of
 * the four attributes.
 *
 * The row count is necessary but not sufficient (see ANTI-VACUITY above): a
 * registry with a full `entities` map and no `allAttributes` produces 776 rows
 * that are every one of them `[-1,-1,-1,-1]` — a table that says "no known type
 * declares Description, ObjectType, Tag or PredefinedType", which is garbage
 * the row floor waves through.
 *
 * MEASURED, not guessed: 488 of today's 776 rows resolve at least one
 * attribute; the other 288 legitimately declare none of the four (IfcCartesianPoint
 * and friends), so this can never be "all rows". The floor is 400 — under the
 * measured 488 with ~18% headroom for schema churn, and under the 412 that the
 * ROW_FLOOR boundary's worst case yields (a 700-row subset that keeps all 288
 * non-resolvers still costs only 700 - 288 = 412), so the two floors still
 * cannot contradict each other, just with a real margin of 12 rows (2.9%), not
 * the 44 a same-proportion read of 700/776 suggests.
 *
 * That margin only has to cover one of this generator's two failure shapes,
 * not both. At the generator level, `typescript-generator.ts` emits
 * `allAttributes` for every entity unconditionally, so a failure there is
 * all-or-nothing — it takes the resolved count to zero (see ANTI-VACUITY
 * above), never to something in between. One level further down, inside
 * `getAllAttributes` (`packages/codegen/src/express-parser.ts`), the
 * inheritance walk silently stops when a supertype name isn't found in
 * `schema.entities` — no error, no distinction from a legitimate root — so a
 * PARTIAL loss is reachable there, scoped to whichever ancestor's subtree lost
 * its parent link, and it is not bounded away from this floor's slack. Today's
 * registry has no such break, but measuring what one would cost: 201 of the
 * 488 resolved entities resolve ONLY through an inherited attribute, and the
 * single costliest ancestor is `IfcRoot` at 70 rows (`IfcRelationship` 47,
 * `IfcObject` 31, `IfcTypeProduct` 21, `IfcElement` 20) — every one of those
 * comfortably inside this floor's 88-row slack, so RESOLVED_FLOOR alone would
 * wave a loss that size through. `--check`'s semantic drift comparison against
 * the committed table is the actual backstop for this failure mode, not a
 * floor value.
 */
const RESOLVED_FLOOR = 400;

// A stale or half-built dist imports cleanly and still exports nothing. Refuse
// before either mode runs: in write mode an empty registry emits an armless
// `match` (every known type silently falls back to the unknown-type indices),
// and in check mode it would bless that file on the very next run.
if (!SCHEMA_REGISTRY?.entities || typeof SCHEMA_REGISTRY.entities !== 'object') {
  console.error(
    '❌ SCHEMA_REGISTRY.entities is missing or not an object in ' +
      'packages/parser/dist/index.js — stale or broken build; refusing to ' +
      'derive an attribute-index table from it.\n' +
      '   Rebuild with `pnpm turbo build --filter=@ifc-lite/parser` and retry.',
  );
  process.exit(1);
}

const rows = Object.keys(SCHEMA_REGISTRY.entities)
  .map((key) => {
    const names = getAttributeNames(key);
    const idx = NAMES.map((n) => names.indexOf(n));
    return { upper: key.toUpperCase(), idx };
  })
  .sort((a, b) => (a.upper < b.upper ? -1 : 1));

if (rows.length < ROW_FLOOR) {
  console.error(
    `❌ @ifc-lite/parser's SCHEMA_REGISTRY (${SCHEMA_REGISTRY.name}) yielded only ${rows.length} entity ` +
      `type(s); the floor is ${ROW_FLOOR}. Refusing to ${CHECK ? 'compare against' : 'emit'} an ` +
      'attribute-index table derived from an extraction this thin — a `match` with no arms (or almost ' +
      'none) makes every known type fall back to the unknown-type indices [3,4,7], which is the parity ' +
      'break this generator exists to prevent, and `--check` would report it as in sync forever after.\n' +
      '   Rebuild with `pnpm turbo build --filter=@ifc-lite/parser` and retry. If the registry genuinely ' +
      'shrank this far, lower ROW_FLOOR in the same commit.',
  );
  process.exit(1);
}

// Rows are cheap; RESOLVED rows are the payload. A registry that kept its
// `entities` map but lost `allAttributes` clears ROW_FLOOR with 776 rows of
// `[-1,-1,-1,-1]` — see RESOLVED_FLOOR.
const resolved = rows.filter((r) => r.idx.some((i) => i >= 0)).length;

if (resolved < RESOLVED_FLOOR) {
  console.error(
    `❌ @ifc-lite/parser's SCHEMA_REGISTRY (${SCHEMA_REGISTRY.name}) yielded ${rows.length} entity type(s), ` +
      `but only ${resolved} of them resolve ANY of ${NAMES.join('/')} — the floor is ${RESOLVED_FLOOR} ` +
      `(a healthy build resolves 488 of 776). Refusing to ${CHECK ? 'compare against' : 'emit'} an ` +
      'attribute-index table this blind.\n' +
      '   A row count alone cannot catch this: `allAttributes` is optional on the registry\'s entity ' +
      'metadata and `getAllAttributesForEntity` returns `metadata?.allAttributes || []`, so an `entities` ' +
      'map that is fully populated while `allAttributes` stopped being emitted writes one arm per type ' +
      'with every index -1. Per this table\'s own contract -1 means "known type, does not declare that ' +
      'attribute, never fall back" — so the server-parse path would report Description/ObjectType/Tag/' +
      'PredefinedType as absent for EVERY entity while the browser resolves them normally, and `--check` ' +
      'would report it as in sync forever after.\n' +
      '   Rebuild with `pnpm turbo build --filter=@ifc-lite/parser` and retry. If the registry genuinely ' +
      'stopped declaring these attributes, lower RESOLVED_FLOOR in the same commit.',
  );
  process.exit(1);
}

const arms = rows
  .map(({ upper, idx }) => `        "${upper}" => Some(RootAttrIndices { description: ${idx[0]}, object_type: ${idx[1]}, tag: ${idx[2]}, predefined_type: ${idx[3]} }),`)
  .join('\n');

const out = `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Root-attribute indices per IFC entity type (issue #1765).
//!
//! DO NOT EDIT — generated by \`scripts/generate-server-attr-indices.mjs\`
//! from \`@ifc-lite/parser\`'s SCHEMA_REGISTRY (${SCHEMA_REGISTRY.name}), the same
//! table the in-browser parse resolves attribute names against, so the
//! server-parse path extracts Description / ObjectType / Tag / PredefinedType
//! at IDENTICAL positions ('' / absent in exactly the same cases).
//!
//! Lookup key is the UPPERCASE STEP type name. \`None\` = type unknown to the
//! registry — callers mirror the WASM fallback (Description 3, ObjectType 4,
//! Tag 7, no PredefinedType). An index of -1 means the type is KNOWN and does
//! not declare that attribute (never fall back for these).

/// Attribute positions for one entity type; -1 = not declared.
#[derive(Debug, Clone, Copy)]
pub struct RootAttrIndices {
    pub description: i8,
    pub object_type: i8,
    pub tag: i8,
    pub predefined_type: i8,
}

/// ${rows.length} entity types from ${SCHEMA_REGISTRY.name}.
pub fn root_attr_indices(upper_type_name: &str) -> Option<RootAttrIndices> {
    match upper_type_name {
${arms}
        _ => None,
    }
}
`;

const outPath = join(root, 'apps/server/src/services/data_model/generated/attr_indices.rs');

if (CHECK) {
  // Parse the committed arms semantically (format-agnostic): each type maps to
  // its [description, object_type, tag, predefined_type] tuple.
  let committed;
  try {
    committed = readFileSync(outPath, 'utf8');
  } catch {
    console.error(`✗ ${outPath} is missing — run: node scripts/generate-server-attr-indices.mjs`);
    process.exit(1);
  }
  // A commented-out arm is dead to Rust (it falls back to the unknown-type
  // indices), but the arm regex would still match it and report "in sync" —
  // recreating the very drift this guards against. Strip Rust block and line
  // comments first. (attr_indices.rs holds no string literals containing `//`
  // or `/*` — type-name keys are `[A-Z0-9_]+` — so this can't eat a real arm.)
  const stripRustComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // Rust `match` is FIRST-arm-wins; a Map is last-wins. Track duplicates so a
  // hand-added second arm can't slip a wrong value past this guard by matching
  // the registry on its (dead) last copy while Rust dispatches the first.
  const parseArms = (rawText) => {
    const text = stripRustComments(rawText);
    const map = new Map();
    const dups = new Set();
    const re = /"([A-Z0-9_]+)"\s*=>\s*Some\(RootAttrIndices\s*\{\s*description:\s*(-?\d+)\s*,\s*object_type:\s*(-?\d+)\s*,\s*tag:\s*(-?\d+)\s*,\s*predefined_type:\s*(-?\d+)\s*,?\s*\}\)/g;
    for (const m of text.matchAll(re)) {
      // Keep the FIRST arm's value (mirrors Rust dispatch); flag the rest.
      if (map.has(m[1])) dups.add(m[1]);
      else map.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])].join(','));
    }
    return { map, dups };
  };
  const expected = new Map(rows.map((r) => [r.upper, r.idx.join(',')]));
  const { map: actual, dups } = parseArms(committed);

  const drift = [];
  for (const k of dups) drift.push(`  duplicate arm (Rust uses the first, unreachable rest): ${k}`);
  for (const [k, v] of expected) {
    if (!actual.has(k)) drift.push(`  missing row: ${k}`);
    else if (actual.get(k) !== v) drift.push(`  ${k}: committed [${actual.get(k)}] != registry [${v}]`);
  }
  for (const k of actual.keys()) if (!expected.has(k)) drift.push(`  stale row (not in registry): ${k}`);

  if (drift.length > 0) {
    console.error(
      `✗ apps/server/.../generated/attr_indices.rs is out of sync with @ifc-lite/parser's SCHEMA_REGISTRY (${SCHEMA_REGISTRY.name}).\n` +
      `  Regenerate: pnpm turbo build --filter=@ifc-lite/parser && node scripts/generate-server-attr-indices.mjs && cargo fmt -p ifc-lite-server\n` +
      `${drift.slice(0, 20).join('\n')}${drift.length > 20 ? `\n  …and ${drift.length - 20} more` : ''}`,
    );
    process.exit(1);
  }
  console.log(`✓ attr_indices.rs in sync (${expected.size} types, registry ${SCHEMA_REGISTRY.name})`);
  process.exit(0);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${rows.length} types, registry ${SCHEMA_REGISTRY.name})`);
