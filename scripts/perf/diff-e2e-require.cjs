/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Proof-only audit includes CommonJS dependencies invisible to ESM hooks.
const Module = require('node:module');
const { appendFileSync, statSync } = require('node:fs');
const { isAbsolute } = require('node:path');
const original = Module._resolveFilename;
Module._resolveFilename = function(specifier, parent, ...rest) {
  const path = original.call(this, specifier, parent, ...rest);
  if (isAbsolute(path) && statSync(process.env.IFC_DIFF_RESOLUTION_LOG).size > 32 * 1024 * 1024) throw new Error('resolution audit exceeded bound');
  if (isAbsolute(path)) appendFileSync(process.env.IFC_DIFF_RESOLUTION_LOG,
    JSON.stringify({ specifier, parentURL: parent?.filename, path }) + '\n');
  return path;
};
