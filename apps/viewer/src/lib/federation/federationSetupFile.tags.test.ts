/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model tags in the portable federation setup file (issue #4215, format 2).
 *
 *  - a format-1 file (no tags) still reads, as format 2 with no tags;
 *  - a format-2 round trip keeps tag ids verbatim (saved rules hold them),
 *    declares only the tags a slot carries, and is byte-deterministic;
 *  - a slot naming an undeclared tag, or a malformed tag list, fails loudly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FederatedModel } from '../../store/types.js';
import {
  buildFederationSetupFile,
  serializeFederationSetupFile,
  parseFederationSetupFile,
  FEDERATION_SETUP_FORMAT_VERSION,
} from './federationSetupFile.js';

function makeModel(name: string, bytes: string): FederatedModel {
  const file = new File([bytes], name, { type: 'application/octet-stream' });
  return {
    id: crypto.randomUUID(), name, ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 1, fileSize: file.size, sourceFile: file, idOffset: 0, maxExpressId: 0,
  } as FederatedModel;
}

const STRUCT = 'b-structure';
const ARCH = 'a-architecture';
const UNUSED = 'c-unused';

const V1_FILE = JSON.stringify({
  formatVersion: 1,
  slots: [{ name: 'ARCH.ifc', fileSize: 3, fingerprintHex: null, visible: true, collapsed: false, anchor: true }],
});

describe('federation setup file — model tags (#4215)', () => {
  it('reads a format-1 file as format 2 with no tags', () => {
    const parsed = parseFederationSetupFile(V1_FILE);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.setup.formatVersion, FEDERATION_SETUP_FORMAT_VERSION);
    assert.deepEqual(parsed.setup.tags, []);
    assert.deepEqual(parsed.setup.slots[0].tagIds, []);
  });

  it('round-trips tag definitions and per-slot assignments with ids verbatim, declaring only used tags', async () => {
    const arch = makeModel('ARCH.ifc', 'architecture-bytes');
    const struct = makeModel('STRUCT.ifc', 'structure-bytes');
    const plain = makeModel('MEP.ifc', 'mep-bytes');
    const tagState = {
      modelTags: new Map([
        [STRUCT, { id: STRUCT, name: 'Structure', color: '#f00' }],
        [ARCH, { id: ARCH, name: 'Architecture' }],
        [UNUSED, { id: UNUSED, name: 'Tender' }],
      ]),
      modelTagAssignments: new Map([
        [arch.id, new Set([ARCH])],
        [struct.id, new Set([STRUCT, ARCH])],
      ]),
    };
    const setup = await buildFederationSetupFile([arch, struct, plain], arch.id, tagState);
    assert.deepEqual(setup.tags.map((t) => t.id), [ARCH, STRUCT], 'sorted by id; the unused Tender tag is not declared');
    assert.deepEqual(setup.tags[1], { id: STRUCT, name: 'Structure', color: '#f00' });
    assert.deepEqual(setup.slots.map((s) => s.tagIds), [[ARCH], [ARCH, STRUCT], []]);

    const json = serializeFederationSetupFile(setup);
    const parsed = parseFederationSetupFile(json);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.setup.tags, setup.tags);
    assert.deepEqual(parsed.setup.slots.map((s) => s.tagIds), [[ARCH], [ARCH, STRUCT], []]);
    assert.equal(serializeFederationSetupFile(parsed.setup), json, 'parse → serialize is byte-stable');
  });

  it('is deterministic with tags: two saves of the same state are byte-identical', async () => {
    const m = makeModel('A.ifc', 'a');
    const tagState = {
      modelTags: new Map([[STRUCT, { id: STRUCT, name: 'Structure' }]]),
      modelTagAssignments: new Map([[m.id, new Set([STRUCT])]]),
    };
    const a = serializeFederationSetupFile(await buildFederationSetupFile([m], m.id, tagState));
    const b = serializeFederationSetupFile(await buildFederationSetupFile([m], m.id, tagState));
    assert.equal(a, b);
  });

  it('drops an assignment whose tag definition is gone rather than declaring a nameless tag', async () => {
    const m = makeModel('A.ifc', 'a');
    const setup = await buildFederationSetupFile([m], null, {
      modelTags: new Map(),
      modelTagAssignments: new Map([[m.id, new Set(['deleted-tag'])]]),
    });
    assert.deepEqual(setup.tags, []);
    assert.deepEqual(setup.slots[0].tagIds, []);
  });

  it('fails loudly on a slot naming an undeclared tag, and on a malformed tag list', () => {
    const base = JSON.parse(V1_FILE) as { formatVersion: number; tags?: unknown; slots: Array<Record<string, unknown>> };
    base.formatVersion = 2;
    base.tags = [{ id: STRUCT, name: 'Structure' }];
    base.slots[0].tagIds = [STRUCT, 'ghost'];
    const undeclared = parseFederationSetupFile(JSON.stringify(base));
    assert.equal(undeclared.ok, false);
    if (!undeclared.ok) assert.match(undeclared.error, /slots\[0\]\.tagIds references an undeclared tag "ghost"/);

    base.slots[0].tagIds = [STRUCT];
    base.tags = [{ id: STRUCT, name: 'Structure' }, { id: STRUCT, name: 'Again' }];
    const dup = parseFederationSetupFile(JSON.stringify(base));
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.match(dup.error, /tags\[1\] repeats the id/);

    base.tags = [{ id: STRUCT }];
    const malformed = parseFederationSetupFile(JSON.stringify(base));
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.match(malformed.error, /tags\[0\]/);

    base.tags = 'nope';
    assert.equal(parseFederationSetupFile(JSON.stringify(base)).ok, false);

    base.formatVersion = 3;
    const future = parseFederationSetupFile(JSON.stringify(base));
    assert.equal(future.ok, false);
    if (!future.ok) assert.match(future.error, /expected 1 or 2/);
  });
});
