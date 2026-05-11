/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { parseIfcx } from './index.js';

const HELLO_WALL_PATH = 'tests/models/ifc5/Hello_Wall_hello-wall.ifcx';
// Per AGENTS.md §9 fixtures are fetched on demand; skip the suite cleanly
// when the bytes aren't on disk so a fresh checkout doesn't crash here.
const FIXTURES_AVAILABLE = existsSync(HELLO_WALL_PATH);
const STOREY_PATH = '44af358b-3160-4063-8a89-a868335ff3b5';
const SPACE_PATH = 'e3035b71-bd9f-4cdc-86fd-b56e2f4605b6';
const WALL_PATH = '93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b';
const WINDOW_A_PATH = '2c2d549f-f9fe-4e22-8590-562fda81a690';
const WINDOW_B_PATH = '592504dc-469a-44d6-9ae8-c801b591679b';

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe('buildHierarchy', { skip: !FIXTURES_AVAILABLE && 'tests/models/ifc5/Hello_Wall_hello-wall.ifcx missing — run `pnpm fixtures`' }, () => {
  it('maps Hello Wall space boundaries and nested windows into spatial containment', async () => {
    const buffer = readFileSync(HELLO_WALL_PATH);
    const result = await parseIfcx(toArrayBuffer(buffer));

    const storeyId = result.pathToId.get(STOREY_PATH);
    const spaceId = result.pathToId.get(SPACE_PATH);
    const wallId = result.pathToId.get(WALL_PATH);
    const windowAId = result.pathToId.get(WINDOW_A_PATH);
    const windowBId = result.pathToId.get(WINDOW_B_PATH);

    assert.ok(storeyId !== undefined);
    assert.ok(spaceId !== undefined);
    assert.ok(wallId !== undefined);
    assert.ok(windowAId !== undefined);
    assert.ok(windowBId !== undefined);

    const storeyElements = result.spatialHierarchy.byStorey.get(storeyId) ?? [];
    const spaceElements = result.spatialHierarchy.bySpace.get(spaceId) ?? [];

    assert.deepStrictEqual(
      [...storeyElements].sort((a, b) => a - b),
      [wallId, windowAId, windowBId].sort((a, b) => a - b)
    );
    assert.deepStrictEqual(
      [...spaceElements].sort((a, b) => a - b),
      [wallId, windowAId, windowBId].sort((a, b) => a - b)
    );
    assert.strictEqual(result.spatialHierarchy.getContainingSpace(windowAId), spaceId);
    assert.strictEqual(result.spatialHierarchy.getContainingSpace(windowBId), spaceId);
    assert.strictEqual(result.spatialHierarchy.elementToStorey.get(windowAId), storeyId);
    assert.strictEqual(result.spatialHierarchy.elementToStorey.get(windowBId), storeyId);
  });
});
