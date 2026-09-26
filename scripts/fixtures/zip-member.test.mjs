/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractZipMember } from './zip-member.mjs';

// A one-member DEFLATE ZIP generated with Python's standard zipfile module.
// The bytes exercise the ZIP envelope; the expected IFC member is checked
// independently rather than pinning this archive's byte layout as an API.
const zip = Buffer.from(
  'UEsDBBQAAAAIAAtiOl1no/6XFwAAACAAAAAJAAAAbW9kZWwuaWZj8wz21zU0MDYw1jUytOZy9XPR9UQRAQBQSwECFAMUAAAACAALYjpdZ6P+lxcAAAAgAAAACQAAAAAAAAAAAAAAgAEAAAAAbW9kZWwuaWZjUEsFBgAAAAABAAEANwAAAD4AAAAAAA==',
  'base64',
);

test('extracts a bounded IFC member from a pinned ZIP archive', () => {
  assert.equal(extractZipMember(zip, 'model.ifc', 32).toString(), 'ISO-10303-21;\nEND-ISO-10303-21;\n');
  assert.throws(() => extractZipMember(zip, 'model.ifc', 31), /exceeds declared size/);
  assert.throws(() => extractZipMember(zip, 'missing.ifc', 32), /ZIP member missing/);
});

test('rejects malformed archive metadata before attempting extraction', () => {
  assert.throws(() => extractZipMember(zip.subarray(0, -1), 'model.ifc', 32), /end-of-directory/);
});
