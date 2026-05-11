/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Round-trip seed/snapshot tests against the buildingSMART hello-wall
 * fixture. Seeding → snapshotting → re-seeding must converge to the same
 * Y state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCollabDoc, entitiesMap } from '../src/doc/schema.js';
import { entityToJSON } from '../src/doc/entity.js';
import { seedFromIfcx } from '../src/snapshot/from-ifcx.js';
import { snapshotToIfcx } from '../src/snapshot/to-ifcx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixturesDir = path.join(repoRoot, 'tests/models/ifc5');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

function summarise(doc: ReturnType<typeof createCollabDoc>): {
  entityPaths: string[];
  attrCount: number;
} {
  const ents = entitiesMap(doc);
  const paths = Array.from(ents.keys()).sort();
  let attrCount = 0;
  for (const [, e] of ents.entries()) {
    const json = entityToJSON(e);
    attrCount += Object.keys(json.attributes).length;
  }
  return { entityPaths: paths, attrCount };
}

describe('seedFromIfcx + snapshotToIfcx', () => {
  it('preserves entity set and attributes across one round-trip', () => {
    const text = loadFixture('Hello_Wall_hello-wall.ifcx');
    const docA = createCollabDoc();
    seedFromIfcx(docA, text);
    const summaryA = summarise(docA);
    expect(summaryA.entityPaths.length).toBeGreaterThan(0);

    const ifcx = snapshotToIfcx(docA);
    expect(ifcx.data.length).toBe(summaryA.entityPaths.length);

    const docB = createCollabDoc();
    seedFromIfcx(docB, ifcx);
    const summaryB = summarise(docB);

    expect(summaryB.entityPaths).toEqual(summaryA.entityPaths);
    expect(summaryB.attrCount).toBe(summaryA.attrCount);
  });

  it('idempotent re-seed against same source', () => {
    const text = loadFixture('Hello_Wall_hello-wall.ifcx');
    const doc = createCollabDoc();
    seedFromIfcx(doc, text);
    const before = summarise(doc);
    seedFromIfcx(doc, text);
    const after = summarise(doc);
    expect(after.entityPaths).toEqual(before.entityPaths);
    expect(after.attrCount).toBe(before.attrCount);
  });
});
