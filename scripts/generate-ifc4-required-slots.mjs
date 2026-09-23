#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate the IFC4 REQUIRED-SLOT table the TypeScript schema converter reads
 * when it downgrades a file to IFC4 (#5202):
 *
 *   packages/export/src/generated/ifc4-required-slots.ts
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
 * required slot, carrying the entity's total attribute count and, per
 * required slot, its index, its EXPRESS attribute name, and the value a
 * downgrade may write there when the record's own value is `$`:
 *
 *   - an enum whose IFC4 declaration has a `USERDEFINED` member -> no default
 *     value claims nothing for an enum with meaningful members, so this
 *     table does not attempt one; see the module doc in
 *     `schema-converter-ifc4-slots.ts` for why enum reconciliation is a
 *     separate, NOT-YET-ATTEMPTED problem (#5202 finding 1).
 *   - a BOOLEAN (directly, or through a defined type such as `IfcBoolean`) -> `.F.`
 *   - anything else -> NO fill. The slot keeps `$` and the converter counts
 *     it, so the caller learns the file is not valid IFC4 instead of
 *     receiving an invented measure, label, identifier or entity reference.
 *
 * Unlike the IFC2X3 table, this one does NOT fill enums with a NOTDEFINED
 * default: filling an IFC4-mandatory enum slot with an invented member would
 * be indistinguishable from the enum-reconciliation gap #5202 documents as a
 * SEPARATE, unfixed problem, and conflating the two would hide it. Every
 * enum-typed required slot is therefore left in the "no fill" group here,
 * counted like any other unfillable required slot.
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

// `pathToFileURL`, not the bare path: Node's ESM loader parses a Windows
// `C:\...` specifier as protocol `c:` and refuses it with
// ERR_UNSUPPORTED_ESM_URL_SCHEME (same fix as PR #4750 for the IFC2X3
// generator).
const { SCHEMA_REGISTRY: IFC4 } = await import(
  pathToFileURL(join(ROOT, 'packages/parser/src/generated/schema-registry.ts')).href
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

function buildRows() {
  const rows = [];
  for (const [name, entity] of Object.entries(IFC4.entities)) {
    if (entity.isAbstract) continue;
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

function renderTs(rows) {
  const lines = [];
  lines.push('/* This Source Code Form is subject to the terms of the Mozilla Public');
  lines.push(' * License, v. 2.0. If a copy of the MPL was not distributed with this');
  lines.push(' * file, You can obtain one at https://mozilla.org/MPL/2.0/. */');
  lines.push('');
  lines.push('/**');
  lines.push(' * Slots IFC4 declares MANDATORY, per concrete entity, for the schema');
  lines.push(' * downgrade in `schema-converter.ts` (#5202). A record the source wrote `$`');
  lines.push(' * in takes the recorded fill when the schema has an honest one (a BOOLEAN),');
  lines.push(' * and is COUNTED when it has none — including every enum-typed required');
  lines.push(' * slot, deliberately left unfilled (see the generator\'s module doc).');
  lines.push(' *');
  lines.push(' * Generated by `scripts/generate-ifc4-required-slots.mjs` from');
  lines.push(' * `packages/parser/src/generated/schema-registry.ts`.');
  lines.push(' *');
  lines.push(' * DO NOT EDIT - regenerate with');
  lines.push(' *   node scripts/generate-ifc4-required-slots.mjs');
  lines.push(' */');
  lines.push('');
  lines.push('/** `[index, attribute name, fill]`; a null fill means IFC4 requires a value');
  lines.push(' *  the downgrade must not invent. */');
  lines.push('export type Ifc4RequiredSlot = readonly [number, string, string | null];');
  lines.push('');
  lines.push('/** `[UPPERCASE entity name, total attribute count, required slots]`. */');
  lines.push('export type Ifc4RequiredSlotRow = readonly [string, number, readonly Ifc4RequiredSlot[]];');
  lines.push('');
  lines.push('export const IFC4_REQUIRED_SLOTS: readonly Ifc4RequiredSlotRow[] = [');
  for (const row of rows) {
    const slots = row.slots
      .map((s) => `[${s.index}, '${s.name}', ${s.fill === null ? 'null' : `'${s.fill}'`}]`)
      .join(', ');
    lines.push(`  ['${row.type}', ${row.arity}, [${slots}]],`);
  }
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

const rows = buildRows();
if (rows.length === 0) {
  console.error('generate-ifc4-required-slots: the registry yielded ZERO rows; refusing to write.');
  process.exit(1);
}

const text = renderTs(rows);

if (process.argv.includes('--check')) {
  let committed;
  try {
    committed = readFileSync(join(ROOT, TS_REL), 'utf8');
  } catch {
    console.error(`generate-ifc4-required-slots --check: ${TS_REL} is missing.`);
    process.exit(1);
  }
  if (committed !== text) {
    console.error(`generate-ifc4-required-slots --check: ${TS_REL} is out of date.`);
    console.error('Run: node scripts/generate-ifc4-required-slots.mjs');
    process.exit(1);
  }
  const slots = rows.reduce((n, r) => n + r.slots.length, 0);
  console.log(`generate-ifc4-required-slots --check: OK (${rows.length} entities, ${slots} slots)`);
  process.exit(0);
}

mkdirSync(dirname(join(ROOT, TS_REL)), { recursive: true });
writeFileSync(join(ROOT, TS_REL), text);
console.log(`generate-ifc4-required-slots: wrote ${TS_REL}`);
