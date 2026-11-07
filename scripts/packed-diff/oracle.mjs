/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { semantics } from './semantics.mjs';

assert.match(process.version, /^v22\.13\./);
// Explicit tsx API, no --experimental-strip-types and no native stripping.
// This process never imports the packed facade and cannot initialize it.
const { tsImport } = await import(pathToFileURL(process.argv[2]).href);
const api = await tsImport(pathToFileURL(process.argv[3]).href, import.meta.url);
console.log(JSON.stringify({ mode: 'oracle', node: process.version, ...semantics(api) }));
