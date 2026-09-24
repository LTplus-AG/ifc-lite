#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate `docs/architecture/schema-enum-reconciliation.md`: the reviewed
 * ledger of every enum member a schema conversion can meet that the TARGET
 * schema does not define, and what the converter writes for it (#5365).
 *
 * WHY THIS EXISTS. The #5365 charter's stopping condition: every enum type
 * whose members differ between two bundled schemas is either mapped or
 * explicitly refused, and a generated check fails CI when a schema
 * regeneration introduces a difference nobody has seen. The converter applies
 * `packages/export/src/schema-enum-policy.ts` at runtime against the target
 * registry. This script runs the SAME function over the registries and writes
 * the outcome for every (direction, entity, attribute), so:
 *  - every refusal is listed by name, not left implicit;
 *  - a registry change that adds a member, an enum or an entity changes this
 *    file, and `--check` fails until the new rows are committed and reviewed.
 *
 * Rows are keyed by the TARGET entity's enum attribute: a member of the
 * source enum of the same name that the target enum lacks. Entities the
 * target does not declare at all are handled by entity conversion (rename,
 * `IFCPROXY`), not here.
 *
 * Run: `node scripts/generate-enum-reconciliation.mjs` to write the file,
 * `--check` to verify it is up to date.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

// The registries and the policy are TypeScript; re-exec under the workspace's
// `tsx` loader, the same pattern as `generate-ifc2x3-required-slots.mjs`.
if (!process.env.ENUM_RECONCILIATION_TSX) {
  const loader = createRequire(SELF).resolve('tsx');
  try {
    execFileSync(process.execPath, ['--import', loader, SELF, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, ENUM_RECONCILIATION_TSX: '1' },
    });
  } catch (err) {
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
  process.exit(0);
}

const OUT_REL = 'docs/architecture/schema-enum-reconciliation.md';
const load = async (rel) => (await import(pathToFileURL(join(ROOT, rel)).href)).SCHEMA_REGISTRY;
const REGISTRIES = {
  IFC2X3: await load('packages/parser/src/generated/ifc2x3/schema-registry.ts'),
  IFC4: await load('packages/parser/src/generated/schema-registry.ts'),
  IFC4X3: await load('packages/parser/src/generated/ifc4x3/schema-registry.ts'),
};
const { resolveMissingEnumMember } = await import(
  pathToFileURL(join(ROOT, 'packages/export/src/schema-enum-policy.ts')).href
);

const DIRECTIONS = [
  ['IFC4X3', 'IFC4'], ['IFC4X3', 'IFC2X3'], ['IFC4', 'IFC2X3'],
  ['IFC2X3', 'IFC4'], ['IFC2X3', 'IFC4X3'], ['IFC4', 'IFC4X3'],
];

function describe(resolution, attributes) {
  switch (resolution.kind) {
    case 'userdefined': return `\`.USERDEFINED.\`, name in \`${attributes[resolution.labelIndex].name}\``;
    case 'notdefined': return '`.NOTDEFINED.` (reported)';
    case 'omit': return '`$` (reported)';
    default: return '**refused**: kept as written, reported';
  }
}

const sections = [];
const totals = [];
for (const [from, to] of DIRECTIONS) {
  const source = REGISTRIES[from];
  const target = REGISTRIES[to];
  const rows = [];
  for (const [entityName, meta] of Object.entries(target.entities).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (meta.isAbstract) continue;
    const attributes = meta.allAttributes ?? meta.attributes;
    attributes.forEach((attribute, index) => {
      const members = Object.hasOwn(target.enums, attribute.type) ? target.enums[attribute.type] : undefined;
      const sourceMembers = members && Object.hasOwn(source.enums, attribute.type) ? source.enums[attribute.type] : undefined;
      if (!sourceMembers) return;
      const missing = sourceMembers.filter((m) => !members.includes(m));
      if (missing.length === 0) return;
      const resolution = resolveMissingEnumMember(attributes, index, members);
      rows.push({ entity: entityName, attribute: attribute.name, enumName: attribute.type, missing, resolution, attributes });
    });
  }
  const refused = rows.filter((r) => r.resolution.kind === 'refuse');
  totals.push(`| ${from} → ${to} | ${rows.length} | ${rows.reduce((n, r) => n + r.missing.length, 0)} | ${refused.length} |`);
  const lines = [`## ${from} → ${to}`, ''];
  if (rows.length === 0) {
    lines.push('No enum member of a shared enum is missing in this direction.', '');
  } else {
    lines.push('| Entity.Attribute | Enum | Members the target lacks | Written as |', '| --- | --- | --- | --- |');
    for (const r of rows) {
      lines.push(`| ${r.entity}.${r.attribute} | ${r.enumName} | ${r.missing.join(', ')} | ${describe(r.resolution, r.attributes)} |`);
    }
    lines.push('');
  }
  sections.push(lines.join('\n'));
}

const text = [
  '# Schema conversion: enum members the target lacks',
  '',
  '<!-- GENERATED by scripts/generate-enum-reconciliation.mjs; do not edit. CI runs it with --check. -->',
  '',
  'When a schema conversion meets an enum member the target schema does not define, the converter',
  '(`packages/export/src/schema-converter-enums.ts`) writes what `schema-enum-policy.ts` decides, in order:',
  '',
  '1. `.USERDEFINED.` with the member name moved into the entity\'s label slot (`ObjectType`,',
  '   `ElementType`, `ProcessType`, `ResourceType`, or `UserDefined<Attribute>`), when both exist.',
  '   The meaning survives.',
  '2. `.NOTDEFINED.`, when the target enum has it. The kind is lost and reported.',
  '3. `$`, when the attribute is optional in the target. The value is lost and reported.',
  '4. **Refused**: no valid output exists. The value is kept, the file is not valid against its header,',
  '   and the export names it in its warnings.',
  '',
  'Nothing is ever mapped to an invented member. Each row below is one target entity attribute whose',
  'enum lost members in that direction (#5365).',
  '',
  '| Direction | Entity attributes | Missing member entries | Refused |',
  '| --- | --- | --- | --- |',
  ...totals,
  '',
  ...sections,
].join('\n');

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(join(ROOT, OUT_REL), 'utf8');
  } catch {
    console.error(`generate-enum-reconciliation --check: ${OUT_REL} is missing.`);
    process.exit(1);
  }
  if (committed !== text) {
    console.error(`generate-enum-reconciliation --check: ${OUT_REL} is out of date.`);
    console.error('A schema regeneration changed which enum members a conversion can meet. Run');
    console.error('`node scripts/generate-enum-reconciliation.mjs`, review the new rows, and commit them.');
    process.exit(1);
  }
  console.log(`generate-enum-reconciliation --check: OK\n${totals.join('\n')}`);
} else {
  writeFileSync(join(ROOT, OUT_REL), text);
  console.log(`generate-enum-reconciliation: wrote ${OUT_REL}\n${totals.join('\n')}`);
}
