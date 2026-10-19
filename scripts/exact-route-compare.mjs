/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { validateCapture, OPTIONS } from './exact-route-schema.mjs';

export function difference(a, b, path = '$') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null) return path;
  if (Array.isArray(a) !== Array.isArray(b)) return path;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) {
      const diff = difference(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (typeof a === 'object') {
    // Objects are keyed collections. Arrays are NEVER sorted or deduplicated.
    const keys = Object.keys(a).sort();
    if (difference(keys, Object.keys(b).sort())) return `${path}.keys`;
    for (const key of keys) {
      const diff = difference(a[key], b[key], `${path}.${key}`);
      if (diff) return diff;
    }
    return null;
  }
  return path;
}
export function compare(a, b, expectedOptions = OPTIONS) {
  for (const capture of [a, b]) validateCapture(capture, expectedOptions);
  for (const field of ['protocol', 'fixture_sha256', 'options', 'scene']) {
    const diff = difference(a[field], b[field], `$.${field}`);
    if (diff) return { equal: false, firstDifference: diff };
  }
  return { equal: true, scope: 'full ordered scene; execution_only excluded; source receipts required separately' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw Error('usage: node scripts/exact-route-compare.mjs BASE.json BRANCH.json');
    const result = compare(...process.argv.slice(2).map(p => JSON.parse(readFileSync(p, 'utf8'))));
    console.log(JSON.stringify(result));
    process.exitCode = result.equal ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
