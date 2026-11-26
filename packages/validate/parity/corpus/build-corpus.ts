/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Writes the crafted corpus: the valid base model and one broken file per
 * mutation, once as IFC4 and once as IFC4X3_ADD2, plus manifest.json. A
 * target is kept for a release only when that release declares the rule;
 * the oracle comparison runs on every file either way.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSchema, type SchemaRelease } from '../../src/index.js';
import type { SchemaRuntime } from '../../src/runtime/schema-runtime.js';
import { baseRecords, DEFAULT_HEADER, serialize } from './base-model.js';
import { MUTATIONS } from './mutations.js';

const RELEASES: Array<{ release: SchemaRelease; fileSchema: string; dir: string }> = [
  { release: 'IFC4', fileSchema: 'IFC4', dir: '' },
  { release: 'IFC4X3', fileSchema: 'IFC4X3_ADD2', dir: 'ifc4x3' },
];

function declares(schema: SchemaRuntime, target: string): boolean {
  if (target.startsWith('global:')) return schema.rules.global.some((g) => g.name.toUpperCase() === target.slice(7).toUpperCase());
  const dot = target.indexOf('.');
  if (dot < 0 || target.startsWith('FILE_')) return true;
  const [owner, label] = [target.slice(0, dot), target.slice(dot + 1)];
  const rules = schema.rules.entity[owner] ?? schema.rules.type[owner] ?? [];
  return rules.some((r) => r.label === label) || (schema.entity(owner)?.meta.unique ?? []).some((u) => u.label === label);
}

const here = import.meta.dirname;
const manifest: Array<{ file: string; schema: string; targets: string | null }> = [];
for (const { release, fileSchema, dir } of RELEASES) {
  const schema = await loadSchema(release);
  const root = join(here, dir);
  rmSync(join(root, 'broken'), { recursive: true, force: true });
  mkdirSync(join(root, 'broken'), { recursive: true });
  writeFileSync(join(root, dir ? 'base.ifc' : 'base-ifc4.ifc'), serialize(baseRecords(), { ...DEFAULT_HEADER, schema: fileSchema }));
  for (const m of MUTATIONS) {
    const records = baseRecords();
    const result = m.apply(records);
    const header = { ...(result ? result.header : DEFAULT_HEADER), schema: fileSchema };
    const file = `${dir ? `${dir}/` : ''}broken/${m.name}.ifc`;
    writeFileSync(join(here, file), serialize(records, header));
    manifest.push({ file, schema: fileSchema, targets: declares(schema, m.targets) ? m.targets : null });
  }
}
writeFileSync(join(here, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}
`);
console.log(`wrote ${manifest.length} broken files for ${RELEASES.length} releases`);
