/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How `generate-ifc-schema.ts` writes one generated schema table: the value
 * encoded by `../src/ifc-schema/table-codec.ts`, a getter and the constant.
 */

import { encodeSchemaTable } from '../src/ifc-schema/table-codec.js';

/** `ENTITIES_IFC4` -> `getEntitiesIfc4`, `IFC_DATA_TYPES` -> `getIfcDataTypes`. */
function getterName(constName: string): string {
  return 'get' + constName.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/**
 * One table as the generated module carries it: the value encoded by
 * `../src/ifc-schema/table-codec.ts`, a getter that decodes it on first call,
 * and the exported constant (decoded on load; `@__PURE__` so a bundle that
 * never reads it drops it; its `eagerSchemaTable` marker shows where one was kept).
 */
export function tableModuleSection(constName: string, typeName: string, value: unknown): string {
  const getter = getterName(constName);
  const encoded = `ENCODED_${constName}`;
  const cache = getter.charAt(3).toLowerCase() + getter.slice(4);
  return [
    `const ${encoded} = ${JSON.stringify(encodeSchemaTable(value))};`,
    '',
    `let ${cache}: ${typeName} | undefined;`,
    '',
    `/** \`${constName}\`, decoded on first call and the same value afterwards. */`,
    `export function ${getter}(): ${typeName} {`,
    `  if (${cache} === undefined) ${cache} = decodeSchemaTable(${encoded}) as ${typeName};`,
    `  return ${cache};`,
    '}',
    '',
    `export const ${constName}: ${typeName} = /* @__PURE__ */ eagerSchemaTable('ifc-lite-eager-table:${constName}', ${getter});`,
    '',
  ].join('\n');
}

/** The import every generated table module starts with. */
export const DECODER_IMPORT = "import { decodeSchemaTable, eagerSchemaTable } from '../table-codec.js';\n";
