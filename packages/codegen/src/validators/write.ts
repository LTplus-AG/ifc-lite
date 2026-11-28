/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateValidators, type ValidatorCoverage } from './index.js';

/** Generate the validator modules for one EXPRESS schema into `outDir` (Node only; the generator itself is pure). */
export function writeValidators(schemaPath: string, outDir: string, runtimeImport?: string): ValidatorCoverage {
  const source = readFileSync(schemaPath, 'utf8').replace(/\r\n/g, '\n');
  const { files, coverage } = generateValidators(source, runtimeImport ? { runtimeImport } : {});
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);
  return coverage;
}
