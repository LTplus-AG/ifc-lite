/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Proof-only Node ESM loader. No audit writes are allowed in timing children.
import { appendFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith('file:')) {
    if (statSync(process.env.IFC_DIFF_RESOLUTION_LOG).size > 32 * 1024 * 1024) throw new Error('resolution audit exceeded bound');
    appendFileSync(process.env.IFC_DIFF_RESOLUTION_LOG,
      JSON.stringify({ specifier, parentURL: context.parentURL, path: fileURLToPath(result.url) }) + '\n');
  }
  return result;
}
