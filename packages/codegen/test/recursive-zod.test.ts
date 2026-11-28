/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import ts from 'typescript';
import { generateValidators } from '../src/index.js';

it('imports recursive SELECT and aggregate authoring schemas as ES modules (#11646)', () => {
  const { files } = generateValidators(`SCHEMA S;
TYPE A = SELECT (B, Node); END_TYPE; TYPE B = LIST OF A; END_TYPE;
TYPE Plain = INTEGER; END_TYPE; ENTITY Node; END_ENTITY; END_SCHEMA;`,
    { runtimeImport: './runtime.js' });
  const dir = mkdtempSync(join(__dirname, '.recursive-zod-'));
  try {
    // These declarations have no runtime refinements. Use the real Zod loader and module ordering.
    writeFileSync(join(dir, 'runtime.js'), 'export class SchemaRuntime {}');
    for (const [name, source] of Object.entries(files)) {
      if (!name.endsWith('.ts')) continue;
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
      writeFileSync(join(dir, name.replace(/\.ts$/, '.js')), js.outputText);
    }
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { A, B, Plain } from './zod.js';
      const node = { ref: 1 }, branch = value => ({ typed: { type: 'B', value } });
      for (const value of [node, branch([]), branch([branch([node])])]) assert(A.safeParse(value).success);
      assert(B.safeParse([branch([node])]).success);
      for (const leaf of [0, { ref: 0 }, { typed: { type: 'X', value: [] } }]) assert(!A.safeParse(branch([leaf])).success);
      assert(Plain.safeParse(1).success && !Plain.safeParse('1').success);
    `], { cwd: dir, stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
