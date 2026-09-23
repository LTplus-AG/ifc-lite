#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate the IFC4 REQUIRED-SLOT table the Rust schema converter reads when
 * it downgrades a file to IFC4 from IFC4X3/IFC5 (#5307, the Rust twin of
 * #5202's finding 2):
 *
 *   rust/export/src/generated/ifc4_required_slots.rs
 *
 * WHY THIS EXISTS. `rust/export/src/schema_convert.rs`'s `convert_step_line`
 * only guarded cardinality tightening for `cto == "IFC2X3"`
 * (`Ifc2x3SlotFill`, #4714). IFC4X3 made some attributes optional that IFC4
 * declares mandatory — e.g. `IfcProjectedCRS.Name` and
 * `IfcCoordinateReferenceSystem.Name` — so a downgrade from IFC4X3 (or IFC5)
 * to IFC4 could legitimately carry `$` in a slot the IFC4 target requires a
 * value in, with nothing to fill or count it.
 *
 * THIS IS A ROSTER-ONLY GENERATOR, NOT THE TWIN OF
 * `generate-ifc2x3-required-slots.mjs`. That script writes both a Rust and a
 * TypeScript file from one row-building pass because both language
 * implementations already existed side by side. `scripts/generate-ifc4-
 * required-slots.mjs` (#5202) writes only
 * `packages/export/src/generated/ifc4-required-slots.ts` today, because the
 * Rust IFC4 downgrade did not fill any required slot at all before this
 * change (#5307). This script produces the ROW-IDENTICAL Rust table by the
 * same rules, independently, so the Rust port does not have to wait on
 * #5202 landing first. If #5202's generator gains a Rust output of its own
 * later, the two should be unified the way the IFC2X3 pair already is —
 * left as a follow-up rather than done here, to avoid touching a file another
 * open PR (#5202 / PR #5332) also writes.
 *
 * WHAT A ROW SAYS. One row per CONCRETE IFC4 entity that has at least one
 * required slot, carrying the entity's total attribute count and, per
 * required slot, its index, its EXPRESS attribute name, and the value a
 * downgrade may write there when the record's own value is `$`:
 *
 *   - a BOOLEAN (directly, or through a defined type such as `IfcBoolean`) -> `.F.`
 *   - anything else, INCLUDING every enum -> NO fill. The slot keeps `$` and
 *     the converter counts it, so the caller learns the file is not valid
 *     IFC4 instead of receiving an invented measure, label, identifier,
 *     entity reference, or enum member. Filling an IFC4-mandatory enum slot
 *     with an invented member would be indistinguishable from #5202's
 *     separate, unaddressed enum-reconciliation gap (finding 1), so this
 *     table deliberately does not attempt one — same policy as
 *     `generate-ifc4-required-slots.mjs`'s TypeScript table.
 *
 * `IfcRoot.OwnerHistory` needs no row: it is optional in both IFC4X3 and
 * IFC4, so unlike the IFC2X3 downgrade there is no mandatory/optional
 * mismatch on that slot — the generator excludes it the same way the
 * TypeScript table does, because `optional` is true for it in the IFC4
 * registry.
 *
 * SOURCE OF TRUTH. `packages/parser/src/generated/schema-registry.ts` (the
 * IFC4 registry) and `packages/data/src/ifc-schema/generated/entities-ifc4.ts`
 * (the Rust converter's own positional attribute-name table, read via
 * `rust/data/src/...`'s generated mirror at build time — `--check` verifies
 * the registry and the TypeScript arity table agree on attribute order for
 * every row, the same guarantee `generate-ifc2x3-required-slots.mjs` and
 * `generate-ifc4-required-slots.mjs` make for theirs; the Rust converter's
 * own arity table for IFC4 targets is exercised by
 * `rust/export/src/schema_convert_tests.rs`, not re-verified here, because
 * `convert_step_line` applies NO trim/pad on an IFC4 target at all today —
 * only the fill runs, and the fill's own arity guard
 * (`values.len() != arity`) already refuses to touch a record whose length
 * disagrees, the same safety net `Ifc2x3SlotFill::fill_required` uses.
 *
 * `IfcCartesianPointList2D`/`3D` are excluded, matching
 * `generate-ifc4-required-slots.mjs`'s `IFC4_DATA_TABLE_BUG_TYPES` — see that
 * script's own comment for why (`entities-ifc4.ts` carries IFC4X3's shape
 * into the IFC4 row; a pre-existing, out-of-scope data bug, not a registry
 * gap, and costless to exclude since `CoordList` has no honest fill anyway).
 *
 * Run: `node scripts/generate-ifc4-required-slots-rust.mjs` to write the
 * file, `--check` to verify it is up to date.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

// The registries are TypeScript. Re-exec under the `tsx` loader already a
// workspace devDependency rather than re-implementing a TS parser here, same
// pattern as `generate-ifc2x3-required-slots.mjs` / `generate-ifc4-required-
// slots.mjs`.
if (!process.env.IFC4_REQUIRED_SLOTS_RUST_TSX) {
  const loader = createRequire(SELF).resolve('tsx');
  try {
    execFileSync(process.execPath, ['--import', loader, SELF, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, IFC4_REQUIRED_SLOTS_RUST_TSX: '1' },
    });
  } catch (err) {
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
  process.exit(0);
}

const RS_REL = 'rust/export/src/generated/ifc4_required_slots.rs';

// `pathToFileURL`, not the bare path: Node's ESM loader parses a Windows
// `C:\...` specifier as protocol `c:` and refuses it with
// ERR_UNSUPPORTED_ESM_URL_SCHEME (same fix as PR #4750).
const { SCHEMA_REGISTRY: IFC4 } = await import(
  pathToFileURL(join(ROOT, 'packages/parser/src/generated/schema-registry.ts')).href
);
const { ENTITIES_IFC4 } = await import(
  pathToFileURL(join(ROOT, 'packages/data/src/ifc-schema/generated/entities-ifc4.ts')).href
);

/** Follow a chain of IFC4 defined types down to its EXPRESS base type. */
function underlyingType(name) {
  const seen = new Set();
  let type = name;
  while (IFC4.types[type] !== undefined && !seen.has(type)) {
    seen.add(type);
    type = IFC4.types[type];
  }
  return type;
}

/** The value a downgrade may write into this required slot, or null. Enum
 *  slots are deliberately left unfilled — see the module doc above. */
function fillFor(attr) {
  if (IFC4.enums[attr.type]) return null;
  return underlyingType(attr.type) === 'BOOLEAN' ? '.F.' : null;
}

/** Excluded for the same reason `generate-ifc4-required-slots.mjs` excludes
 *  them from its `IFC4_DATA_TABLE_BUG_TYPES` — see the module doc above. */
const IFC4_DATA_TABLE_BUG_TYPES = new Set(['IFCCARTESIANPOINTLIST2D', 'IFCCARTESIANPOINTLIST3D']);

function buildRows() {
  const rows = [];
  for (const [name, entity] of Object.entries(IFC4.entities)) {
    if (entity.isAbstract) continue;
    if (IFC4_DATA_TABLE_BUG_TYPES.has(name.toUpperCase())) continue;
    const attributes = entity.allAttributes ?? [];
    const slots = [];
    attributes.forEach((attr, index) => {
      if (attr.optional) return;
      slots.push({ index, name: attr.name, fill: fillFor(attr) });
    });
    if (slots.length === 0) continue;
    rows.push({ type: name.toUpperCase(), arity: attributes.length, slots });
  }
  rows.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return rows;
}

/**
 * The Rust converter indexes a converted record's slots positionally, so a
 * row's indexes are only usable if the registry's attribute order is the
 * order `entities-ifc4.ts` uses (the same table
 * `generate-ifc4-required-slots.mjs` checks its TypeScript rows against).
 * Disagreement is a hard failure rather than a silently skipped entity: a
 * wrong index writes `.F.` over a value.
 */
function verifyAgainstConverterTable(rows) {
  const byType = new Map();
  for (const entity of ENTITIES_IFC4) byType.set(entity.name.toUpperCase(), entity.attributes);
  const problems = [];
  for (const row of rows) {
    const converterNames = byType.get(row.type);
    if (converterNames === undefined) continue; // not in the converter's table at all
    const registryNames = (IFC4.entities[
      Object.keys(IFC4.entities).find((k) => k.toUpperCase() === row.type)
    ].allAttributes ?? []).map((a) => a.name);
    const same =
      registryNames.length === converterNames.length &&
      registryNames.every((n, i) => n === converterNames[i]);
    if (!same) problems.push(`${row.type}: registry [${registryNames}] vs data [${converterNames}]`);
  }
  return problems;
}

function renderRust(rows) {
  const lines = [];
  lines.push('// This Source Code Form is subject to the terms of the Mozilla Public');
  lines.push('// License, v. 2.0. If a copy of the MPL was not distributed with this');
  lines.push('// file, You can obtain one at https://mozilla.org/MPL/2.0/.');
  lines.push('');
  lines.push('//! Slots IFC4 declares MANDATORY, per concrete entity, for the schema');
  lines.push('//! downgrade in `schema_convert` (#5307, Rust twin of #5202). A record the');
  lines.push('//! source wrote `$` in takes the recorded fill when the schema has an');
  lines.push('//! honest one (a BOOLEAN), and is COUNTED when it has none — including');
  lines.push('//! every enum-typed required slot, deliberately left unfilled (see the');
  lines.push('//! generator\'s module doc).');
  lines.push('//!');
  lines.push('//! Generated by `scripts/generate-ifc4-required-slots-rust.mjs` from');
  lines.push('//! `packages/parser/src/generated/schema-registry.ts`. Row-identical twin');
  lines.push('//! of `packages/export/src/generated/ifc4-required-slots.ts` (#5202).');
  lines.push('//!');
  lines.push('//! DO NOT EDIT - regenerate with');
  lines.push('//!   node scripts/generate-ifc4-required-slots-rust.mjs');
  lines.push('');
  lines.push('/// `(index, attribute name, fill)`; an EMPTY fill means IFC4 requires a value');
  lines.push('/// the downgrade must not invent.');
  lines.push("pub type Ifc4RequiredSlot = (u8, &'static str, &'static str);");
  lines.push('');
  lines.push('/// `(UPPERCASE entity name, total attribute count, required slots)`.');
  lines.push("pub type Ifc4RequiredSlotRow = (&'static str, u8, &'static [Ifc4RequiredSlot]);");
  lines.push('');
  lines.push('/// Every concrete IFC4 entity with at least one mandatory slot, sorted by');
  lines.push('/// name for binary search.');
  lines.push('pub static IFC4_REQUIRED_SLOTS: &[Ifc4RequiredSlotRow] = &[');
  for (const row of rows) {
    const slots = row.slots
      .map((s) => `(${s.index}, "${s.name}", "${s.fill ?? ''}")`)
      .join(', ');
    lines.push(`    ("${row.type}", ${row.arity}, &[${slots}]),`);
  }
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

const rows = buildRows();
if (rows.length === 0) {
  console.error('generate-ifc4-required-slots-rust: the registry yielded ZERO rows; refusing to write.');
  process.exit(1);
}
const problems = verifyAgainstConverterTable(rows);
if (problems.length > 0) {
  console.error(
    'generate-ifc4-required-slots-rust: the IFC4 registry and the converter attribute table ' +
      'disagree on attribute ORDER, so a slot index here would name the wrong value:\n  ' +
      problems.join('\n  '),
  );
  process.exit(1);
}

const text = renderRust(rows);

if (process.argv.includes('--check')) {
  let committed;
  try {
    committed = readFileSync(join(ROOT, RS_REL), 'utf8');
  } catch {
    console.error(`generate-ifc4-required-slots-rust --check: ${RS_REL} is missing.`);
    process.exit(1);
  }
  if (committed !== text) {
    console.error(`generate-ifc4-required-slots-rust --check: ${RS_REL} is out of date.`);
    console.error('Run: node scripts/generate-ifc4-required-slots-rust.mjs');
    process.exit(1);
  }
  const slots = rows.reduce((n, r) => n + r.slots.length, 0);
  console.log(`generate-ifc4-required-slots-rust --check: OK (${rows.length} entities, ${slots} slots)`);
  process.exit(0);
}

mkdirSync(dirname(join(ROOT, RS_REL)), { recursive: true });
writeFileSync(join(ROOT, RS_REL), text);
console.log(`generate-ifc4-required-slots-rust: wrote ${RS_REL}`);
