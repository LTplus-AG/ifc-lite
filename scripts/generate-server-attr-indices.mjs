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

const rows = Object.keys(SCHEMA_REGISTRY.entities)
  .map((key) => {
    const names = getAttributeNames(key);
    const idx = NAMES.map((n) => names.indexOf(n));
    return { upper: key.toUpperCase(), idx };
  })
  .sort((a, b) => (a.upper < b.upper ? -1 : 1));

/**
 * Lower bound on the registry's own size (#3200, finding 4).
 *
 * Measured on a healthy tree: 776 entity types in `IFC4_ADD2_TC1`. Set to 500,
 * about a third of headroom, so ordinary schema churn never forces an edit here
 * while every way this generator can go blind still trips it — a stale or
 * half-built `packages/parser/dist` that imports cleanly and exports an empty
 * `entities` collapses the count to 0, not to 499.
 *
 * The sibling `generate-bim-globals.mjs` already refuses the identical
 * condition in as many words ("refusing to emit an empty bim-globals.d.ts");
 * this is that refusal, applied here.
 */
const REGISTRY_FLOOR = 500;

/**
 * Lower bound on how many rows RESOLVE at least one of `NAMES` (#3200).
 *
 * `REGISTRY_FLOOR` alone cannot see the second way this goes blind: a registry
 * that still enumerates 776 types while `getAttributeNames` returns nothing for
 * all of them. The row count stays right, every `idx` is `[-1,-1,-1,-1]`, and
 * the emitted table is fully armed and uniformly wrong.
 *
 * Measured on a healthy tree: 488 of the 776 resolve at least one name. The
 * other 288 legitimately resolve none — they are not `IfcRoot` subtypes — so
 * this floor is deliberately below the real number rather than equal to it.
 * Set to 300.
 */
const RESOLVED_FLOOR = 300;

if (rows.length < REGISTRY_FLOOR) {
  console.error(
    `\u274c SCHEMA_REGISTRY (${SCHEMA_REGISTRY.name}) enumerated ${rows.length} entity types, ` +
      `expected at least ${REGISTRY_FLOOR} \u2014 stale or broken ` +
      'packages/parser/dist; refusing to emit or verify an attr_indices.rs against it.\n' +
      '   Rebuild with `pnpm turbo build --filter=@ifc-lite/parser` and retry.\n' +
      '   If the schema genuinely shrank, lower REGISTRY_FLOOR in the same commit.',
  );
  process.exit(1);
}

const resolvedRows = rows.filter(({ idx }) => idx.some((i) => i !== -1)).length;
if (resolvedRows < RESOLVED_FLOOR) {
  console.error(
    `\u274c getAttributeNames resolved at least one of [${NAMES.join(', ')}] for only ` +
      `${resolvedRows} of ${rows.length} types, expected at least ${RESOLVED_FLOOR} \u2014 ` +
      'the registry enumerates but its attribute lists are empty, so every arm would be ' +
      '[-1, -1, -1, -1].\n' +
      '   Rebuild with `pnpm turbo build --filter=@ifc-lite/parser` and retry.\n' +
      '   If the schema genuinely stopped carrying these attributes, lower RESOLVED_FLOOR in ' +
      'the same commit.',
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
