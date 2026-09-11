#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate `rust/core/src/generated/legacy_attribute_names.rs`: the OWN
 * positional attribute-name list, per schema-removed IFC2X3/IFC4 entity,
 * read from the same EXPRESS-derived tables the TypeScript side already
 * generates (`packages/data/src/ifc-schema/generated/entities-ifc2x3.ts`,
 * `entities-ifc4.ts` — themselves produced from `packages/codegen/schemas/
 * *.exp` by `@ifc-lite/data`'s `generate:ifc-schema`).
 *
 * WHY THIS EXISTS (#4203): `rust/core/src/generated/schema.rs`'s
 * `attribute_names()` is IFC4X3-only; a class removed by IFC4X3 answers
 * `Unknown(u32)` with an EMPTY attribute list. `rust/export/src/model_props.rs`
 * used to paper over this by rendering `entity.ifc_type.attribute_names()` —
 * for a legacy entity, that decoded type is `Unknown`, so its own-class
 * attributes were silently dropped from the attribute export even for the 26
 * names `legacy_entities.rs` already resolves for geometry/rootedness. Naively
 * substituting the resolved BASE TYPE's attribute list is not safe either:
 * `IFCDOORSTYLE` (IFC2X3/IFC4) ends `[...,"OperationType","ConstructionType",
 * "ParameterTakesPrecedence","Sizeable"]` while `IfcDoorType` (IFC4X3) ends
 * `[...,"PredefinedType","OperationType","ParameterTakesPrecedence",
 * "UserDefinedOperationType"]` — same length, different names past index 8,
 * so borrowing the base type's names would MISLABEL `Sizeable` as
 * `UserDefinedOperationType` rather than merely omit it. This table carries
 * each legacy entity's OWN declared attribute list instead, so a value never
 * gets a name that names something else.
 *
 * SCOPE: only entities present in `entities-ifc2x3.ts` or `entities-ifc4.ts`
 * that `rust/core/src/generated/schema.rs`'s `from_str` does NOT already
 * resolve (i.e. legacy/removed names) get a row — a name the modern enum
 * already knows keeps using its own generated `attribute_names()`, unchanged.
 *
 * CONFLICT HANDLING: if a name's attribute list differs between the IFC2X3
 * and IFC4 tables (this generator found none as of 2026-09), the IFC2X3 row
 * wins (checked first) and the row is annotated `[conflict]` in a trailing
 * comment — this codebase has no per-file-schema dispatch at this call site
 * (`rust/export/src/model.rs` resolves a keyword the same way regardless of
 * the file's declared `FILE_SCHEMA`), so a conflict cannot be resolved
 * correctly here; it can only be surfaced. `--check` fails loudly if one
 * exists, rather than silently picking a schema.
 *
 * Run: `node scripts/generate-legacy-attribute-names.mjs` to write the file,
 * `--check` to verify it is up to date (wired into `scripts/check-generated.mjs`
 * conceptually the same way the other generated-file gates are, though not
 * yet added to that script's numbered list — see the PR description for why).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEntityTable, generatedNames } from './check-legacy-entity-coverage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = 'packages/data/src/ifc-schema/generated';
const OLD_SCHEMAS = ['entities-ifc2x3.ts', 'entities-ifc4.ts'];
const SCHEMA_REL = 'rust/core/src/generated/schema.rs';
const OUT_REL = 'rust/core/src/generated/legacy_attribute_names.rs';

function loadOldTables() {
  return OLD_SCHEMAS.map((f) => ({
    schema: f.replace('entities-', '').replace('.ts', '').toUpperCase(),
    table: parseEntityTable(readFileSync(join(ROOT, DATA_DIR, f), 'utf8')),
  }));
}

/**
 * `{ name -> { attrs, sources: string[], conflict: bool } }` for every
 * entity in an older schema's table that the generated IFC4X3 enum cannot
 * resolve by name. IFC2X3 is checked before IFC4, so its row wins a conflict
 * (the loop order below; `OLD_SCHEMAS` lists it first).
 */
export function computeLegacyAttributeNames(oldTables, known) {
  const rows = new Map();
  for (const { schema, table } of oldTables) {
    for (const e of table.values()) {
      const upper = e.name.toUpperCase();
      if (known.has(upper)) continue;
      if (!rows.has(e.name)) {
        rows.set(e.name, { attrs: e.attributes, sources: [schema], conflict: false });
      } else {
        const row = rows.get(e.name);
        row.sources.push(schema);
        if (JSON.stringify(row.attrs) !== JSON.stringify(e.attributes)) row.conflict = true;
      }
    }
  }
  return rows;
}

function render(rows) {
  const sorted = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));
  let code = `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Auto-generated legacy (IFC2X3/IFC4, removed-by-IFC4X3) entity attribute
//! names.
//!
//! Generated by \`scripts/generate-legacy-attribute-names.mjs\` from
//! \`packages/data/src/ifc-schema/generated/entities-ifc2x3.ts\` and
//! \`entities-ifc4.ts\` — the same EXPRESS-derived tables the TypeScript side
//! reads, per #4203. Each row is an entity NOT resolvable by
//! \`rust/core/src/generated/schema.rs\`'s \`from_str\`, paired with its OWN
//! declared positional attribute names (not a base-type approximation — see
//! the generator's file header for why that would mislabel values).
//!
//! DO NOT EDIT - regenerate with
//!   node scripts/generate-legacy-attribute-names.mjs

/// \`(UPPERCASE entity name, positional attribute names)\`, sorted by name for
/// binary search. A name appearing in both IFC2X3 and IFC4 with the SAME
/// attribute list contributes one row; this generator found no case where the
/// two disagree (an entity that did would carry a trailing \`// [conflict]\`
/// comment and use its IFC2X3 attribute list).
pub static LEGACY_ATTRIBUTE_NAMES: &[(&str, &[&str])] = &[
`;
  for (const [name, row] of sorted) {
    const upper = name.toUpperCase();
    const attrs = row.attrs.map((a) => `"${a}"`).join(', ');
    const note = row.conflict
      ? ` // ${row.sources.join('+')} [conflict: attribute lists differ; IFC2X3 wins]`
      : ` // ${row.sources.join('+')}`;
    code += `    ("${upper}", &[${attrs}]),${note}\n`;
  }
  code += '];\n';
  return code;
}

function generate() {
  const oldTables = loadOldTables();
  const schemaSource = readFileSync(join(ROOT, SCHEMA_REL), 'utf8');
  const known = generatedNames(schemaSource);
  if (known.size < 500) {
    throw new Error(`only ${known.size} names extracted from ${SCHEMA_REL} — the extractor has drifted`);
  }
  const rows = computeLegacyAttributeNames(oldTables, known);
  if (rows.size === 0) {
    throw new Error('computed zero legacy attribute rows — an extractor has drifted');
  }
  return { rows, code: render(rows) };
}

if (process.argv[1] && process.argv[1].endsWith('generate-legacy-attribute-names.mjs')) {
  const { rows, code } = generate();
  const conflicts = [...rows.entries()].filter(([, r]) => r.conflict);
  if (process.argv.includes('--check')) {
    const current = readFileSync(join(ROOT, OUT_REL), 'utf8');
    if (current !== code) {
      console.error(`❌ ${OUT_REL} is out of date. Run: node scripts/generate-legacy-attribute-names.mjs`);
      process.exit(1);
    }
    if (conflicts.length > 0) {
      console.error(`❌ ${conflicts.length} legacy entity name(s) have conflicting attribute lists between IFC2X3 and IFC4: ${conflicts.map(([n]) => n).join(', ')}`);
      process.exit(1);
    }
    console.log(`✅ ${OUT_REL} is up to date (${rows.size} legacy entities, 0 conflicts).`);
  } else {
    writeFileSync(join(ROOT, OUT_REL), code);
    console.log(`Wrote ${OUT_REL}: ${rows.size} legacy entities, ${conflicts.length} conflicts.`);
  }
}
