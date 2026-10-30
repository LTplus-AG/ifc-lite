/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IFCX store the viewer builds, read the way an IFC store is: the unit consumers derive from
 * `source` + `entityIndex` does not warn about an IfcProject the format cannot have, and the store's
 * space is enumerable. Real fixture: the committed hello-wall sample.
 */

import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { iterateEffectiveEntities } from '@ifc-lite/data';
import { extractLengthUnitScale, parseIfcx } from '@ifc-lite/parser';

import { buildIfcxDataStore } from './viewerModelIngest.js';

const SAMPLE = fileURLToPath(new URL('../../../public/samples/hello-wall.ifcx', import.meta.url));

async function helloWallStore() {
  const bytes = readFileSync(SAMPLE);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return buildIfcxDataStore(await parseIfcx(buffer), buffer);
}

describe('the viewer IFCX store reads hello-wall.ifcx like hello-wall.ifc', () => {
  afterEach(() => mock.restoreAll());

  it('answers the unit from source + entityIndex without the "No IFCPROJECT" warning', async () => {
    const warn = mock.method(console, 'warn', () => undefined);
    const store = await helloWallStore();
    assert.equal(extractLengthUnitScale(store.source, store.entityIndex), 1);
    assert.equal(store.lengthUnitScale, 1);
    assert.equal(store.lengthUnitSource, 'default');
    assert.equal(warn.mock.callCount(), 0);
  });

  it('enumerates the space (the IFCX store has no STEP type index)', async () => {
    const store = await helloWallStore();
    const spaces = [...iterateEffectiveEntities(store, null, ['IfcSpace'])];
    assert.equal(spaces.length, 1);
    assert.equal(store.entities.getName(spaces[0].expressId), 'My_Space');
  });

  it('carries what the reader derived, so export can write the file\'s classes', async () => {
    const store = await helloWallStore();
    assert.equal(store.derivedEntities?.retyped.size, 1);
    assert.equal(store.derivedEntities?.added.size, 3);
  });
});
