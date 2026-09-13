#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate `rust/export/src/generated/legacy_rooted_types.rs`: the set of
 * legacy (IFC2X3/IFC4, removed-by-IFC4X3) entity names whose parent chain
 * reaches `IfcRoot`, read from the same EXPRESS-derived tables
 * `scripts/generate-legacy-attribute-names.mjs` already reads
 * (`packages/data/src/ifc-schema/generated/entities-ifc2x3.ts`,
 * `entities-ifc4.ts`).
 *
 * WHY THIS EXISTS (#4203): `rust/export/src/rooted_type.rs` used to hand-keep
 * `LEGACY_ROOTED_TYPES`, a 54-name allow-list its own doc comment says was
 * "independently re-verified (2026-08-20) by walking each name's parent
 * chain ... re-verify the same way (or regenerate from a diff of those three
 * tables) rather than editing this list ad hoc" -- i.e. it always was meant
 * to be generated, not maintained by hand. This script performs exactly that
 * diff mechanically, using `reaches()` and `parseEntityTable()` from
 * `scripts/check-legacy-entity-coverage.mjs` (the same walk that gate
 * already trusts for `droppableProducts`), so there is one walker for
 * "does this legacy name's chain reach ancestor X", not two.
 *
 * SCOPE: a name qualifies iff it appears in `entities-ifc2x3.ts` or
 * `entities-ifc4.ts`, is NOT resolvable by `rust/core/src/generated/
 * schema.rs`'s `from_str` (i.e. IFC4X3 dropped or renamed it -- reusing
 * `generatedNames()`, the same "known" set `generate-legacy-attribute-
 * names.mjs` uses), and its parent chain in that table reaches `IfcRoot`.
 * Abstract entities are included (unlike `droppableProducts`, which excludes
 * them for a products-only question): an abstract rooted type such as
 * `IFCBUILDINGELEMENT` still carries a GlobalId as its first attribute in any
 * concrete file-instantiated descendant IFC4X3 also dropped, and
 * `is_rooted_type` answers the same "does this keyword's line start with a
 * GlobalId" question for both.
 *
 * CONFLICT HANDLING: a name whose reachability disagrees between the IFC2X3
 * and IFC4 tables (this generator found none as of 2026-09) is reported as a
 * conflict and `--check` fails loudly rather than silently picking one side
 * -- the same posture `generate-legacy-attribute-names.mjs` takes for
 * attribute-list conflicts.
 *
 * Run: `node scripts/generate-legacy-rooted-types.mjs` to write the file,
 * `--check` to verify it is up to date.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEntityTable, generatedNames } from './check-legacy-entity-coverage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = 'packages/data/src/ifc-schema/generated';
const OLD_SCHEMAS = ['entities-ifc2x3.ts', 'entities-ifc4.ts'];
const SCHEMA_REL = 'rust/core/src/generated/schema.rs';
const OUT_REL = 'rust/export/src/generated/legacy_rooted_types.rs';
const ROOT_ANCESTOR = 'IfcRoot';

function loadOldTables() {
  return OLD_SCHEMAS.map((f) => ({
    schema: f.replace('entities-', '').replace('.ts', '').toUpperCase(),
    table: parseEntityTable(readFileSync(join(ROOT, DATA_DIR, f), 'utf8')),
  }));
}

/** Whether `name`'s parent chain within `table` reaches `ancestor` (mirrors
 * `check-legacy-entity-coverage.mjs`'s private `reaches`, which is not
 * exported -- this is the same one-hop walk, kept in sync by the shared
 * `parseEntityTable` shape both consume). */
function reaches(table, name, ancestor) {
  const seen = new Set();
  let cur = name;
  while (cur && table.has(cur) && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = table.get(cur).parent;
  }
  return cur === ancestor;
}

/**
 * `{ name -> { rooted, sources: string[], conflict: bool } }` for every
 * legacy (not resolvable by the generated IFC4X3 enum) entity across both
 * older schemas.
 */
export function computeLegacyRootedTypes(oldTables, known) {
  const rows = new Map();
  for (const { schema, table } of oldTables) {
    for (const e of table.values()) {
      const upper = e.name.toUpperCase();
      if (known.has(upper)) continue;
      const rooted = reaches(table, e.name, ROOT_ANCESTOR);
      if (!rows.has(e.name)) {
        rows.set(e.name, { rooted, sources: [schema], conflict: false });
      } else {
        const row = rows.get(e.name);
        row.sources.push(schema);
        if (row.rooted !== rooted) row.conflict = true;
      }
    }
  }
  return rows;
}

function render(rows) {
  const rooted = [...rows.entries()]
    .filter(([, r]) => r.rooted)
    .map(([name]) => name.toUpperCase())
    .sort();
  let code = `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Auto-generated legacy (IFC2X3/IFC4, removed-by-IFC4X3) rooted entity
//! names.
//!
//! Generated by \`scripts/generate-legacy-rooted-types.mjs\` from
//! \`packages/data/src/ifc-schema/generated/entities-ifc2x3.ts\` and
//! \`entities-ifc4.ts\` -- the same EXPRESS-derived tables
//! \`legacy_attribute_names.rs\` reads, per #4203. Each name is one NOT
//! resolvable by \`rust/core/src/generated/schema.rs\`'s \`from_str\` whose
//! parent chain, in at least one of those tables, reaches \`IfcRoot\`.
//!
//! DO NOT EDIT - regenerate with
//!   node scripts/generate-legacy-rooted-types.mjs

/// Every legacy entity name whose IFC2X3 and/or IFC4 parent chain reaches
/// \`IfcRoot\`, sorted for binary search / stable diffs.
pub static LEGACY_ROOTED_TYPES: &[&str] = &[
`;
  for (const name of rooted) {
    code += `    "${name}",\n`;
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
  const rows = computeLegacyRootedTypes(oldTables, known);
  if (rows.size === 0) {
    throw new Error('computed zero legacy entity rows — an extractor has drifted');
  }
  return { rows, code: render(rows) };
}

if (process.argv[1] && process.argv[1].endsWith('generate-legacy-rooted-types.mjs')) {
  const { rows, code } = generate();
  const conflicts = [...rows.entries()].filter(([, r]) => r.conflict);
  const rootedCount = [...rows.values()].filter((r) => r.rooted).length;
  if (process.argv.includes('--check')) {
    const current = readFileSync(join(ROOT, OUT_REL), 'utf8');
    if (current !== code) {
      console.error(`❌ ${OUT_REL} is out of date. Run: node scripts/generate-legacy-rooted-types.mjs`);
      process.exit(1);
    }
    if (conflicts.length > 0) {
      console.error(`❌ ${conflicts.length} legacy entity name(s) disagree on rootedness between IFC2X3 and IFC4: ${conflicts.map(([n]) => n).join(', ')}`);
      process.exit(1);
    }
    console.log(`✅ ${OUT_REL} is up to date (${rootedCount} rooted legacy entities, 0 conflicts).`);
  } else {
    writeFileSync(join(ROOT, OUT_REL), code);
    console.log(`Wrote ${OUT_REL}: ${rootedCount} rooted legacy entities, ${conflicts.length} conflicts.`);
  }
}
