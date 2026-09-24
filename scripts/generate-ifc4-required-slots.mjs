#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate the IFC4 REQUIRED-SLOT table both schema converters read when they
 * downgrade a file to IFC4 (#5202 TypeScript, #5307 Rust), from one pass so
 * the two languages cannot disagree:
 *
 *   packages/export/src/generated/ifc4-required-slots.ts
 *   rust/export/src/generated/ifc4_required_slots.rs
 *
 * WHY THIS EXISTS. `schema-converter.ts` only guarded cardinality tightening
 * for `toSchema === 'IFC2X3'` (`Ifc2x3SlotFill`, #4714). IFC4X3 made some
 * attributes optional that IFC4 declares mandatory — e.g.
 * `IfcProjectedCRS.Name` and `IfcCoordinateReferenceSystem.Name` — so a
 * downgrade from IFC4X3 (or IFC5) to IFC4 could legitimately carry `$` in a
 * slot the IFC4 target requires a value in, with nothing to fill or even
 * count it. This table is the IFC4-target twin of
 * `generate-ifc2x3-required-slots.mjs`'s table, generated the same way from
 * the same kind of source.
 *
 * `IfcRoot.OwnerHistory` needs no row here: it is optional in IFC4X3 AND in
 * IFC4 (`schema-converter-owner-history.ts`'s own comment), so unlike the
 * IFC2X3 downgrade there is no mandatory/optional mismatch on that slot to
 * reconcile — the generator naturally excludes it anyway, since `optional`
 * is true for it in the IFC4 registry.
 *
 * WHAT A ROW SAYS. One row per CONCRETE IFC4 entity that has at least one
 * required slot: the entity's total attribute count and, per required slot,
 * its index and EXPRESS attribute name. A downgrade that leaves `$` in one of
 * these slots is COUNTED, never filled.
 *
 * WHY NO FILLS. Unlike the IFC2X3 table, no slot here has an honest default.
 * An earlier version filled BOOLEAN slots with `.F.`, but every BOOLEAN slot
 * IFC4 requires is required in IFC4X3 as well (`SameSense`, `Orientation`,
 * `AgreementFlag`, `RepeatS`, …), so a `$` there is already-invalid source,
 * not the optional-in-IFC4X3 mismatch this table exists for, and `.F.` on
 * `SameSense` or `Orientation` flips geometry. Enums are unfilled for the
 * same reason and because enum reconciliation is its own problem (#5202
 * finding 1). The slot keeps `$` and the caller learns the file is not valid
 * IFC4 instead of receiving an invented value.
 *
 * SOURCE OF TRUTH. `packages/parser/src/generated/schema-registry.ts`, the
 * EXPRESS-derived IFC4 registry. The converter's positional attribute table
 * (`attrNameTable('IFC4')` in `schema-converter.ts`) is built from the same
 * registry since #5204, so a row's slot indexes and the converter's agree by
 * construction; there is no second table left to cross-check them against.
 *
 * Run: `node scripts/generate-ifc4-required-slots.mjs` to write the file,
 * `--check` to verify it is up to date.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

// The registries are TypeScript. Re-exec under the `tsx` loader already a
// workspace devDependency rather than re-implementing a TS parser here, so the
// generator reads exactly the module the runtime does. Same pattern as
// `generate-ifc2x3-required-slots.mjs`.
if (!process.env.IFC4_REQUIRED_SLOTS_TSX) {
  const loader = createRequire(SELF).resolve('tsx');
  try {
    execFileSync(process.execPath, ['--import', loader, SELF, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, IFC4_REQUIRED_SLOTS_TSX: '1' },
    });
  } catch (err) {
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
  process.exit(0);
}

const TS_REL = 'packages/export/src/generated/ifc4-required-slots.ts';
const RS_REL = 'rust/export/src/generated/ifc4_required_slots.rs';

// `pathToFileURL`, not the bare path: Node's ESM loader parses a Windows
// `C:\...` specifier as protocol `c:` and refuses it with
// ERR_UNSUPPORTED_ESM_URL_SCHEME (same fix as PR #4750 for the IFC2X3
// generator).
const { SCHEMA_REGISTRY: IFC4 } = await import(
  pathToFileURL(join(ROOT, 'packages/parser/src/generated/schema-registry.ts')).href
);

function buildRows() {
  const rows = [];
  for (const [name, entity] of Object.entries(IFC4.entities)) {
    if (entity.isAbstract) continue;
    const attributes = entity.allAttributes ?? [];
    const slots = [];
    attributes.forEach((attr, index) => {
      if (attr.optional) return;
      slots.push({ index, name: attr.name });
    });
    if (slots.length === 0) continue;
    rows.push({ type: name.toUpperCase(), arity: attributes.length, slots });
  }
  rows.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return rows;
}

function renderTs(rows) {
  const lines = [];
  lines.push('/* This Source Code Form is subject to the terms of the Mozilla Public');
  lines.push(' * License, v. 2.0. If a copy of the MPL was not distributed with this');
  lines.push(' * file, You can obtain one at https://mozilla.org/MPL/2.0/. */');
  lines.push('');
  lines.push('/**');
  lines.push(' * Slots IFC4 declares MANDATORY, per concrete entity, for the schema');
  lines.push(' * downgrade in `schema-converter.ts` (#5202). A `$` left in one is COUNTED,');
  lines.push(' * never filled (see the generator\'s module doc for why).');
  lines.push(' *');
  lines.push(' * Generated by `scripts/generate-ifc4-required-slots.mjs` from');
  lines.push(' * `packages/parser/src/generated/schema-registry.ts`.');
  lines.push(' *');
  lines.push(' * DO NOT EDIT - regenerate with');
  lines.push(' *   node scripts/generate-ifc4-required-slots.mjs');
  lines.push(' */');
  lines.push('');
  lines.push('/** `[index, attribute name]`. */');
  lines.push('export type Ifc4RequiredSlot = readonly [number, string];');
  lines.push('');
  lines.push('/** `[UPPERCASE entity name, total attribute count, required slots]`. */');
  lines.push('export type Ifc4RequiredSlotRow = readonly [string, number, readonly Ifc4RequiredSlot[]];');
  lines.push('');
  lines.push('export const IFC4_REQUIRED_SLOTS: readonly Ifc4RequiredSlotRow[] = [');
  for (const row of rows) {
    const slots = row.slots
      .map((s) => `[${s.index}, '${s.name}']`)
      .join(', ');
    lines.push(`  ['${row.type}', ${row.arity}, [${slots}]],`);
  }
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

function renderRs(rows) {
  const lines = [
    '// This Source Code Form is subject to the terms of the Mozilla Public',
    '// License, v. 2.0. If a copy of the MPL was not distributed with this',
    '// file, You can obtain one at https://mozilla.org/MPL/2.0/.',
    '',
    '//! Slots IFC4 declares MANDATORY, per concrete entity, for the schema',
    '//! downgrade in `schema_convert` (#5307, Rust twin of #5202). A `$` left in',
    '//! one is COUNTED, never filled (see the generator\'s module doc for why).',
    '//!',
    '//! Generated by `scripts/generate-ifc4-required-slots.mjs` from',
    '//! `packages/parser/src/generated/schema-registry.ts`, in the same pass as',
    '//! `packages/export/src/generated/ifc4-required-slots.ts`.',
    '//!',
    '//! DO NOT EDIT - regenerate with',
    '//!   node scripts/generate-ifc4-required-slots.mjs',
    '',
    '/// `(index, attribute name)`.',
    'pub type Ifc4RequiredSlot = (u8, &\'static str);',
    '',
    '/// `(UPPERCASE entity name, total attribute count, required slots)`.',
    'pub type Ifc4RequiredSlotRow = (&\'static str, u8, &\'static [Ifc4RequiredSlot]);',
    '',
    '/// Every concrete IFC4 entity with at least one mandatory slot, sorted by',
    '/// name for binary search.',
    'pub static IFC4_REQUIRED_SLOTS: &[Ifc4RequiredSlotRow] = &[',
  ];
  for (const row of rows) {
    const slots = row.slots.map((s) => `(${s.index}, "${s.name}")`).join(', ');
    lines.push(`    ("${row.type}", ${row.arity}, &[${slots}]),`);
  }
  lines.push('];', '');
  return lines.join('\n');
}

const rows = buildRows();
if (rows.length === 0) {
  console.error('generate-ifc4-required-slots: the registry yielded ZERO rows; refusing to write.');
  process.exit(1);
}

const outputs = [[TS_REL, renderTs(rows)], [RS_REL, renderRs(rows)]];

if (process.argv.includes('--check')) {
  for (const [rel, text] of outputs) {
    let committed;
    try {
      committed = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      console.error(`generate-ifc4-required-slots --check: ${rel} is missing.`);
      process.exit(1);
    }
    if (committed !== text) {
      console.error(`generate-ifc4-required-slots --check: ${rel} is out of date.`);
      console.error('Run: node scripts/generate-ifc4-required-slots.mjs');
      process.exit(1);
    }
  }
  const slots = rows.reduce((n, r) => n + r.slots.length, 0);
  console.log(`generate-ifc4-required-slots --check: OK (${rows.length} entities, ${slots} slots)`);
  process.exit(0);
}

for (const [rel, text] of outputs) {
  mkdirSync(dirname(join(ROOT, rel)), { recursive: true });
  writeFileSync(join(ROOT, rel), text);
  console.log(`generate-ifc4-required-slots: wrote ${rel}`);
}
