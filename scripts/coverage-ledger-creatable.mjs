/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function exportedStringSet(src, name) {
  const start = src.indexOf(`export const ${name}`);
  const open = src.indexOf('[', start);
  const close = src.indexOf(']);', open);
  if (start === -1 || open === -1 || close === -1) {
    throw new Error(`coverage-ledger: could not bound ${name} in cost-authoring-rules.ts`);
  }
  return new Set([...src.slice(open, close).matchAll(/'(Ifc[A-Za-z0-9]+)'/g)].map((m) => m[1].toUpperCase()));
}

/** Derive static and schema-selected entity creation paths from their implementation sources. */
export function deriveCreatableTypes(root, read, assertNonEmpty) {
  const creatorTypes = new Set([
    ...read('packages/create/src/ifc-creator.ts')
      .matchAll(/this\.line\([^,]+,\s*'([A-Z0-9]+)'/g),
  ].map((match) => match[1].toUpperCase()));
  assertNonEmpty('creatable(IfcCreator.this.line)', creatorTypes);
  const writableTypes = new Set(creatorTypes);

  const costQuantityTypes = exportedStringSet(
    read('packages/create/src/cost-authoring-rules.ts'), 'QUANTITY_KINDS',
  );
  assertNonEmpty('creatable(dynamic cost quantity kinds)', costQuantityTypes);
  for (const type of costQuantityTypes) creatorTypes.add(type);

  const inStoreDir = join(root, 'packages/create/src/in-store');
  const inStoreFiles = existsSync(inStoreDir)
    ? readdirSync(inStoreDir)
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
        .sort()
    : [];
  const inStoreTypes = new Set();
  for (const file of inStoreFiles) {
    const src = readFileSync(join(inStoreDir, file), 'utf8');
    for (const match of src.matchAll(/editor\.addEntity\('(Ifc[A-Za-z0-9]+)'/g)) {
      creatorTypes.add(match[1].toUpperCase());
      inStoreTypes.add(match[1].toUpperCase());
    }
  }
  assertNonEmpty('creatable(in-store editor.addEntity)', inStoreTypes);
  return {
    creatorTypes,
    writableTypes,
    costQuantityTypes,
    ifc2x3RefusedCostTypes: new Set([
      'IFCCOSTITEM', 'IFCCOSTSCHEDULE', 'IFCCOSTVALUE', ...costQuantityTypes,
    ]),
  };
}
