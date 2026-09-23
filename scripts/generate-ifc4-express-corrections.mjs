#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate `packages/data/src/ifc-schema/generated/ifc4-express-corrections.ts`:
 * where `@ifc-lite/data`'s C#-derived IFC4 entity table disagrees with the IFC4
 * EXPRESS schema (#5204).
 *
 * `entities-ifc4.ts` comes from buildingSMART's C# `SchemaInfo` source, which
 * files the draft alignment-extension entities under IFC4 and gives
 * `IfcCartesianPointList2D`/`3D` an IFC4X3-only `TagList`. `@ifc-lite/data`
 * cannot import `@ifc-lite/parser` (parser depends on data), so it cannot ask
 * the EXPRESS-derived registry at runtime. This script asks it at generation
 * time and records the answer, and `ENTITIES_IFC4_EXPRESS` in
 * `packages/data/src/ifc-schema/entities-ifc4-express.ts` applies it:
 *
 *   - UNDECLARED: rows that carry attributes but that IFC4 EXPRESS does not
 *     declare. They describe entities IFC4 does not have, so they are dropped.
 *     Attribute-less rows (the STEP defined types and selects the C# source
 *     lists alongside entities) are not the registry's to confirm, and are kept;
 *   - OVERRIDES: declared rows whose attribute list, parent or abstractness
 *     differs from the EXPRESS declaration. EXPRESS wins. The parent matters as
 *     much as the attributes: the C# table parents `IfcOffsetCurve2D`/`3D` under
 *     the IFC4X3-only `IfcOffsetCurve`, so dropping that row would orphan them
 *     unless their IFC4 parent, `IfcCurve`, is restored.
 *
 * Sources: `packages/parser/src/generated/schema-registry.ts` (IFC4, parsed from
 * `packages/codegen/schemas/IFC4_ADD2_TC1.exp`) and
 * `packages/data/src/ifc-schema/generated/entities-ifc4.ts`.
 *
 * Run: `node scripts/generate-ifc4-express-corrections.mjs` to write the file,
 * `--check` to verify it is up to date (CI runs the check).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parseEntityTable } from './lib/entity-table.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

// The registry is TypeScript; re-exec under the workspace's `tsx` loader, the
// same pattern as `generate-ifc2x3-required-slots.mjs`.
if (!process.env.IFC4_EXPRESS_CORRECTIONS_TSX) {
  const loader = createRequire(SELF).resolve('tsx');
  try {
    execFileSync(process.execPath, ['--import', loader, SELF, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, IFC4_EXPRESS_CORRECTIONS_TSX: '1' },
    });
  } catch (err) {
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
  process.exit(0);
}

const SRC_REL = 'packages/data/src/ifc-schema/generated/entities-ifc4.ts';
const OUT_REL = 'packages/data/src/ifc-schema/generated/ifc4-express-corrections.ts';

const { SCHEMA_REGISTRY: IFC4 } = await import(
  pathToFileURL(join(ROOT, 'packages/parser/src/generated/schema-registry.ts')).href
);
const table = parseEntityTable(readFileSync(join(ROOT, SRC_REL), 'utf8'));
if (table.size === 0) {
  console.error(`generate-ifc4-express-corrections: parsed ZERO rows from ${SRC_REL}; refusing to write.`);
  process.exit(1);
}

const undeclared = [];
const overrides = [];
for (const [name, row] of table) {
  const meta = Object.hasOwn(IFC4.entities, name) ? IFC4.entities[name] : undefined;
  if (meta === undefined) {
    if (row.attributes.length > 0) undeclared.push(name);
    continue;
  }
  const fields = [];
  const express = (meta.allAttributes ?? meta.attributes).map((a) => a.name);
  const sameAttributes = express.length === row.attributes.length && express.every((n, i) => n === row.attributes[i]);
  if (!sameAttributes) fields.push(`attributes: [${express.map((a) => `'${a}'`).join(', ')}]`);
  if ((meta.parent ?? undefined) !== row.parent) fields.push(`parent: ${meta.parent ? `'${meta.parent}'` : 'undefined'}`);
  if (Boolean(meta.isAbstract) !== row.isAbstract) fields.push(`abstract: ${Boolean(meta.isAbstract)}`);
  if (fields.length > 0) overrides.push([name, fields]);
}
undeclared.sort();
overrides.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const lines = [
  '/* This Source Code Form is subject to the terms of the Mozilla Public',
  ' * License, v. 2.0. If a copy of the MPL was not distributed with this',
  ' * file, You can obtain one at https://mozilla.org/MPL/2.0/. */',
  '',
  '/**',
  ' * Where `entities-ifc4.ts` (C# `SchemaInfo`) disagrees with the IFC4 EXPRESS',
  ' * schema (#5204). Applied by `../entities-ifc4-express.ts`.',
  ' *',
  ' * DO NOT EDIT - regenerate with',
  ' *   node scripts/generate-ifc4-express-corrections.mjs',
  ' */',
  '',
  '/** Rows with attributes that IFC4 EXPRESS does not declare: dropped. */',
  'export const IFC4_UNDECLARED_ENTITIES: ReadonlySet<string> = new Set([',
  ...undeclared.map((n) => `  '${n}',`),
  ']);',
  '',
  '/** Declared rows whose attributes, parent or abstractness differ from EXPRESS. */',
  'export const IFC4_EXPRESS_OVERRIDES: Readonly<Record<string, {',
  '  readonly attributes?: readonly string[];',
  '  readonly parent?: string;',
  '  readonly abstract?: boolean;',
  '}>> = {',
  ...overrides.map(([n, fields]) => `  ${n}: { ${fields.join(', ')} },`),
  '};',
  '',
];
const text = lines.join('\n');

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(join(ROOT, OUT_REL), 'utf8');
  } catch {
    console.error(`generate-ifc4-express-corrections --check: ${OUT_REL} is missing.`);
    process.exit(1);
  }
  if (committed !== text) {
    console.error(
      `generate-ifc4-express-corrections --check: ${OUT_REL} is stale; ` +
        'run `node scripts/generate-ifc4-express-corrections.mjs` and commit the result.',
    );
    process.exit(1);
  }
  console.log(`generate-ifc4-express-corrections --check: OK (${undeclared.length} undeclared, ${overrides.length} overrides)`);
} else {
  writeFileSync(join(ROOT, OUT_REL), text);
  console.log(`generate-ifc4-express-corrections: wrote ${OUT_REL} (${undeclared.length} undeclared, ${overrides.length} overrides)`);
}
