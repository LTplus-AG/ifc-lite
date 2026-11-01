/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateManifest } from './manifest-validation.mjs';
const catalogue = JSON.parse(readFileSync(new URL('../../tests/models/manifest.json', import.meta.url), 'utf8'));
const source = catalogue.files.find(entry => entry.gaussian);

test('public Gaussian metadata is required even in a historical v1 catalogue (#8567)', () => {
  assert.ok(source);
  assert.deepEqual(validateManifest({ version: 1, files: [source] }), []);
  for (const mutate of [
    entry => delete entry.provenance,
    entry => delete entry.provenance.license,
    entry => { entry.provenance.source.blob_url = entry.provenance.source.blob_url.replace(entry.provenance.source.commit, 'main'); },
    entry => { entry.sha256 = 'a'.repeat(64); },
    entry => { entry.gaussian.sh_degree = 3; },
    entry => { entry.gaussian.count++; },
    entry => delete entry.gaussian.units,
  ]) {
    const entry = structuredClone(source); mutate(entry);
    assert.notDeepEqual(validateManifest({ version: 1, files: [entry] }), []);
  }
});
