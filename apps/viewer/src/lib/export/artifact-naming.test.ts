/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mapStepSchema, uniqueArtifactBase } from './artifact-naming.js';

describe('uniqueArtifactBase', () => {
  it('dedupes same name+ext, leaves different ext alone', () => {
    const used = new Set<string>();
    assert.strictEqual(uniqueArtifactBase('model', 'ifc', used), 'model');
    assert.strictEqual(uniqueArtifactBase('model', 'ifc', used), 'model-2');
    assert.strictEqual(uniqueArtifactBase('model', 'ifc', used), 'model-3');
    // same base, different extension is a distinct filename -> no suffix.
    assert.strictEqual(uniqueArtifactBase('model', 'ifcx', used), 'model');
  });
});

describe('mapStepSchema', () => {
  it('maps schema versions to STEP tokens', () => {
    assert.strictEqual(mapStepSchema('IFC2X3'), 'IFC2X3');
    assert.strictEqual(mapStepSchema('IFC4'), 'IFC4');
    assert.strictEqual(mapStepSchema('IFC4X3'), 'IFC4X3');
    assert.strictEqual(mapStepSchema('IFC5'), 'IFC4'); // caller routes IFC5 elsewhere
  });
});
