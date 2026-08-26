#!/usr/bin/env tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Emit `src/ifc-schema/generated/entity-names.ts` — the UPPERCASE STEP keyword
 * → PascalCase lookup published as `IFC_ENTITY_NAMES` — from the
 * `entities-*.ts` tables that `generate-ifc-schema.ts` writes.
 *
 * Runs as the second half of `generate:ifc-schema`, so a schema bump carries
 * the names along and there is no second list to fall behind. It is a separate
 * script rather than another `emit*` inside the generator because that file
 * sits at its module-size budget.
 *
 * Why emit a literal at all, when the map could be built at load from the same
 * three arrays: a runtime loop over them is not something a bundler can
 * tree-shake, so it keeps all three — ~630 KB minified, ~57 KB gzipped —
 * alive in every bundle that touches a name lookup, and `@ifc-lite/data` is
 * published for browser consumers. `src/ifc-entity-names.schema-parity.test.ts`
 * compares the emitted file against `entities-*.ts` in both directions, so the
 * failure mode a committed artefact introduces — this emit skipped, leaving a
 * stale file — fails there rather than degrading display names silently.
 *
 * Usage:
 *   pnpm --filter @ifc-lite/data run generate:ifc-schema
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTITIES_IFC2X3 } from '../src/ifc-schema/generated/entities-ifc2x3.js';
import { ENTITIES_IFC4 } from '../src/ifc-schema/generated/entities-ifc4.js';
import { ENTITIES_IFC4X3 } from '../src/ifc-schema/generated/entities-ifc4x3.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'src', 'ifc-schema', 'generated');

/**
 * Names reachable through `IfcTypeEnum` / `IfcTypeEnumToString` in
 * `src/types.ts` but absent from every `SchemaInfo.*.g.cs` block, so no amount
 * of parsing can produce them. Emitted alongside the derived ones so the
 * lookup still spells them; a fourth one appearing is a question about the
 * upstream dumps, not a line to add here quietly.
 */
const ENUM_ONLY_NAMES = ['IfcSolidStratum', 'IfcVoidStratum', 'IfcWaterStratum'];

const HEADER =
  '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
  ' * License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
  ' * file, You can obtain one at https://mozilla.org/MPL/2.0/. */\n\n' +
  '/**\n' +
  ' * Auto-generated from `scripts/upstream/SchemaInfo.*.g.cs` (buildingSMART/\n' +
  ' * IDS-Audit-tool, MIT). Do not edit by hand — regenerate via\n' +
  ' *   pnpm --filter @ifc-lite/data run generate:ifc-schema\n' +
  ' */\n\n' +
  '/**\n' +
  ' * UPPERCASE STEP keyword -> PascalCase entity name, unioned over the three\n' +
  ' * schema versions, plus the enum-only names listed in the emitter.\n' +
  ' *\n' +
  ' * Callers do `IFC_ENTITY_NAMES[upper] ?? upper`, so a missing key degrades\n' +
  ' * to the raw UPPERCASE keyword rather than failing — which is why\n' +
  ' * `ifc-entity-names.schema-parity.test.ts` pins this file against\n' +
  ' * `entities-*.ts` in both directions instead of trusting it.\n' +
  ' */\n';

function main(): void {
  // An empty source array means the generator misfiled a block — the emit
  // would then write a map missing a whole schema's names and exit 0, and the
  // schema→map half of the parity test would pass vacuously against it.
  const sources: [string, readonly { name: string }[]][] = [
    ['ENTITIES_IFC2X3', ENTITIES_IFC2X3],
    ['ENTITIES_IFC4', ENTITIES_IFC4],
    ['ENTITIES_IFC4X3', ENTITIES_IFC4X3],
  ];
  for (const [name, list] of sources) {
    if (list.length === 0) {
      throw new Error(`${name} is empty; refusing to emit a partial entity-name map`);
    }
  }

  const map = new Map<string, string>();
  for (const [, list] of sources) {
    for (const entity of list) map.set(entity.name.toUpperCase(), entity.name);
  }
  for (const name of ENUM_ONLY_NAMES) map.set(name.toUpperCase(), name);

  const lines = [HEADER, 'export const IFC_ENTITY_NAMES: Record<string, string> = {'];
  for (const [upper, pascal] of map) {
    lines.push(`  ${JSON.stringify(upper)}: ${JSON.stringify(pascal)},`);
  }
  lines.push('};\n');
  fs.writeFileSync(path.join(outDir, 'entity-names.ts'), lines.join('\n'));
  console.log(`  entity-names.ts — ${map.size} names`);
}

main();
