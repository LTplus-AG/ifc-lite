#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate, from one pass (#10847):
 *  - `docs/architecture/schema-value-forms.md`: the reviewed ledger of every
 *    target slot whose same-named source attribute can hold a STEP value
 *    form the target type cannot, and which forms;
 *  - `rust/export/src/generated/value_forms.rs`: the same rows as a table for
 *    the Rust converter, which has no attribute types at runtime. The
 *    TypeScript converter runs `packages/export/src/schema-value-form-policy.ts`
 *    against the registries directly, so the two agree by construction.
 *
 * A registry change that retypes an attribute changes these files, and
 * `--check` fails until the new rows are committed and reviewed.
 *
 * A target slot is paired with the source attribute the converter carries
 * into it: the same name, or the `renamed` pair of a reviewed attribute map
 * (`rust/export/tests/fixtures/schema_attribute_maps.json`). A map's
 * `retyped`, `upOnly` and `setOfOne` attributes are left out: the map already
 * decides them. Only types both schemas declare are compared; a renamed type
 * is converted by its own plan.
 *
 * Run: `node scripts/generate-value-forms.mjs` to write the files,
 * `--check` to verify they are up to date.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

// The registries and the policy are TypeScript; re-exec under the workspace's `tsx` loader.
if (!process.env.VALUE_FORMS_TSX) {
  const loader = createRequire(SELF).resolve('tsx');
  try {
    execFileSync(process.execPath, ['--import', pathToFileURL(loader).href, SELF, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, VALUE_FORMS_TSX: '1' },
    });
  } catch (err) {
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
  process.exit(0);
}

const OUT_REL = 'docs/architecture/schema-value-forms.md';
const RS_REL = 'rust/export/src/generated/value_forms.rs';
const load = async (rel) => (await import(pathToFileURL(join(ROOT, rel)).href)).SCHEMA_REGISTRY;
const REGISTRIES = {
  IFC2X3: await load('packages/parser/src/generated/ifc2x3/schema-registry.ts'),
  IFC4: await load('packages/parser/src/generated/schema-registry.ts'),
  IFC4X3: await load('packages/parser/src/generated/ifc4x3/schema-registry.ts'),
};
const { valueFormSlots } = await import(pathToFileURL(join(ROOT, 'packages/export/src/schema-value-form-policy.ts')).href);
const MAPS = JSON.parse(readFileSync(join(ROOT, 'rust/export/tests/fixtures/schema_attribute_maps.json'), 'utf8')).maps;

const DIRECTIONS = [
  ['IFC2X3', 'IFC4'], ['IFC2X3', 'IFC4X3'], ['IFC4', 'IFC2X3'],
  ['IFC4X3', 'IFC2X3'], ['IFC4', 'IFC4X3'], ['IFC4X3', 'IFC4'],
];

const rows = [];
for (const [from, to] of DIRECTIONS) {
  const here = valueFormSlots(REGISTRIES[from], REGISTRIES[to], from, to, MAPS);
  for (const slot of here) {
    // Both converters convert only a real payload to an integer; any other narrowing needs review.
    const payload = slot.rejected.find((f) => f.split('>')[0].endsWith(')') && !f.endsWith('(R)>I') && !f.endsWith('(R)>AI'));
    if (payload) throw new Error(`generate-value-forms: ${from} → ${to} ${slot.type}.${slot.attribute} has a payload row no converter handles: ${payload}.`);
    // Both converters clear a positional group by its own slots' rows, so each slot needs one, alike.
    for (const i of slot.whole) {
      const partner = here.find((s) => s.type === slot.type && s.index === i);
      if (!partner || partner.required !== slot.required || partner.empty !== slot.empty) {
        throw new Error(`generate-value-forms: ${from} → ${to} ${slot.type} positional slot ${i} has no row like ${slot.attribute}'s.`);
      }
    }
    rows.push({ from, to, ...slot });
  }
}
// Field by field in byte order, as Rust compares the tuple it binary-searches.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
rows.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.type, b.type) || a.index - b.index);

const inDirection = new Map(DIRECTIONS.map(([from, to]) => [`${from} → ${to}`, rows.filter((r) => r.from === from && r.to === to)]));
const sections = DIRECTIONS.map(([from, to]) => {
  const here = inDirection.get(`${from} → ${to}`);
  const lines = [`## ${from} → ${to}`, ''];
  if (!here.length) return [...lines, 'Every same-named attribute keeps a value form the target accepts.', ''].join('\n');
  lines.push('| Entity.Attribute | Source type | Target type | Required | Emptied as | Forms the target rejects |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of here) {
    const meta = REGISTRIES[to].entities[r.entity];
    const names = r.whole.map((i) => (meta.allAttributes ?? meta.attributes)[i].name);
    const emptied = [r.whole.length ? `whole: ${names.join(' + ')}` : '', r.empty ? '`()`' : ''].filter(Boolean).join('; ');
    lines.push(`| ${r.entity}.${r.attribute} | ${r.sourceType} | ${r.targetType} | ${r.required ? 'yes' : ''} | ${emptied} | ${r.rejected.map((f) => `\`${f}\``).join(', ')} |`);
  }
  return [...lines, ''].join('\n');
});

const text = [
  '# Schema conversion: value forms a target slot rejects',
  '',
  '<!-- GENERATED by scripts/generate-value-forms.mjs; do not edit. CI runs it with --check. -->',
  '',
  'An attribute that keeps its name across schemas can change type, so a value carried by name or',
  'position can be invalid in the target. Each row is a target slot whose same-named source attribute',
  'can hold a STEP value form the target type cannot (`packages/export/src/schema-value-form-policy.ts`).',
  'Both converters write such a value as `$`, count it dropped and name the slot in the export',
  'warnings (#10847), separately when the target requires the slot, since the record is then invalid.',
  'A value another pass already rewrote into an accepted form is kept. An aggregate loses only its',
  'rejected members, unless they are positional (`whole`: those slots are emptied together); a',
  'required aggregate that may be empty and loses every member is written `()`.',
  '',
  'Forms: `#` entity reference, `S` string, `R` real, `I` integer, `E` enumeration (and BOOLEAN /',
  'LOGICAL), `B` binary, `T:NAME` a typed select member, and `A` before a form for an aggregate member.',
  'A reference is rejected only when no entity the source names is related to one the target names.',
  'A `>TO` row converts instead of dropping. `T:NAME(F)` is a payload row: a typed member the target',
  'takes whose defined type no longer holds payload form F (IFC4X3 made IfcCountMeasure an INTEGER), so',
  '`T:NAME(R)>I` writes a whole payload as the integer and drops a fractional one.',
  '`TEXT` retains a typed string as `IfcText` when the target does not declare the original type.',
  '`D+` writes seconds as an ISO 8601 duration. `D-` writes fixed-length durations as seconds',
  'and reports calendar years or months as a loss because they depend on a starting date (#10879).',
  '',
  '| Direction | Slots |',
  '| --- | --- |',
  ...[...inDirection].map(([direction, here]) => `| ${direction} | ${here.length} |`),
  '',
  ...sections,
].join('\n');

function renderRs() {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.from}|${r.to}|${r.type}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const lines = [
    '// This Source Code Form is subject to the terms of the Mozilla Public',
    '// License, v. 2.0. If a copy of the MPL was not distributed with this',
    '// file, You can obtain one at https://mozilla.org/MPL/2.0/.',
    '',
    '//! Target slots whose same-named source attribute can hold a STEP value form',
    '//! the target type cannot (#10847). Same rows as',
    '//! `docs/architecture/schema-value-forms.md` and the TypeScript',
    '//! `schema-value-form-policy.ts`.',
    '//!',
    '//! DO NOT EDIT - regenerate with',
    '//!   node scripts/generate-value-forms.mjs',
    '',
    '/// `(slot index, attribute name, the target requires the slot, the target',
    '/// aggregate may be empty, slots emptied together when a positional member',
    '/// is rejected, rejected forms)`.',
    "pub type ValueFormSlot = (u8, &'static str, bool, bool, &'static [u8], &'static [&'static str]);",
    '',
    '/// `(source schema, target schema, UPPERCASE target type, slots)`, sorted.',
    "pub static VALUE_FORM_SLOTS: &[(&str, &str, &str, &[ValueFormSlot])] = &[",
  ];
  for (const [key, slots] of groups) {
    const [from, to, type] = key.split('|');
    const body = slots.map((s) => `(${s.index}, "${s.attribute}", ${s.required}, ${s.empty}, &[${s.whole.join(', ')}], &[${s.rejected.map((f) => `"${f}"`).join(', ')}])`).join(', ');
    lines.push(`    ("${from}", "${to}", "${type}", &[${body}]),`);
  }
  lines.push('];', '');
  return lines.join('\n');
}

const outputs = [[OUT_REL, text], [RS_REL, renderRs()]];
const totals = [...inDirection].map(([direction, here]) => `${direction}: ${here.length}`).join(', ');
if (process.argv.includes('--check')) {
  for (const [rel, content] of outputs) {
    let committed = '';
    try {
      committed = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      console.error(`generate-value-forms --check: ${rel} is missing.`);
      process.exit(1);
    }
    if (committed !== content) {
      console.error(`generate-value-forms --check: ${rel} is out of date.`);
      console.error('A schema or attribute-map change moved which value forms a conversion can meet. Run');
      console.error('`node scripts/generate-value-forms.mjs`, review the new rows, and commit them.');
      process.exit(1);
    }
  }
  console.log(`generate-value-forms --check: OK (${totals})`);
} else {
  for (const [rel, content] of outputs) writeFileSync(join(ROOT, rel), content);
  console.log(`generate-value-forms: wrote ${OUT_REL} and ${RS_REL} (${totals})`);
}
