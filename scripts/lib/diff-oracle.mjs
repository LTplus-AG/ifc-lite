/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { tsImport } from 'tsx/esm/api';

/** #8042: private pre-cutover TS oracle. Never import the public Rust facade
 * to generate its own expectations. Explicit tsx loading supports Node 22.13. */
export function loadDiffOracle(module = 'index') {
  return tsImport(new URL(`../../packages/diff/test/oracle/${module}.ts`, import.meta.url).href, import.meta.url);
}
