/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLayerId,
  createProvenanceManifest,
  setProvenance,
} from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode, ProvenanceCheck } from '@ifc-lite/ifcx';
import { PROVENANCE_KEY } from '@ifc-lite/ifcx';
import { computeLayerContribution, layerStackEntry, pathTail, shortContentId } from './stack.js';
import type { FederationLayerLike } from './stack.js';
import type { LayerStackEntry } from '@/store/slices/layerStackSlice';

function file(
  data: IfcxNode[],
  manifest?: Parameters<typeof createProvenanceManifest>[0],
): IfcxFile {
  const bare: IfcxFile = {
    header: { id: '', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: '2026-08-23T00:00:00Z' },
    imports: [],
    schemas: {},
    data,
  };
  if (!manifest) return bare;
  const withManifest = setProvenance(bare, createProvenanceManifest(manifest));
  const id = computeLayerId(withManifest);
  return { ...withManifest, header: { ...withManifest.header, id } };
}

function layer(over: Partial<FederationLayerLike> & { file: IfcxFile }): FederationLayerLike {
  return {
    id: 'layer-1',
    name: 'layer.ifcx',
    buffer: new ArrayBuffer(128),
    ...over,
  };
}

describe('layerStackEntry', () => {
  it('carries the content id only for a blake3-addressed header', () => {
    const f = file([{ path: 'a', attributes: {} }]);
    f.header.id = 'blake3:deadbeef';
    const entry = layerStackEntry(layer({ file: f }));
    assert.equal(entry.contentId, 'blake3:deadbeef');
  });

  it('omits contentId for a non-blake3 header id', () => {
    const f = file([{ path: 'a', attributes: {} }]);
    f.header.id = 'not-a-hash';
    const entry = layerStackEntry(layer({ file: f }));
    assert.equal(entry.contentId, undefined,
      'a header id that does not start with blake3: is not a content address');
  });

  it('counts nodeCount from the data array length, zero when data is not an array', () => {
    const f = file([{ path: 'a', attributes: {} }, { path: 'b', attributes: {} }]);
    const entry = layerStackEntry(layer({ file: f }));
    assert.equal(entry.nodeCount, 2);

    const withoutArray = layer({ file: { ...f, data: undefined as unknown as IfcxNode[] } });
    assert.equal(layerStackEntry(withoutArray).nodeCount, 0);
  });

  it('degrades a malformed manifest instead of throwing', () => {
    const f = file([{ path: 'a', attributes: {} }], {
      author: { kind: 'human', principal: 'alice' },
      intent: 'test',
      base: null,
    });
    // Corrupt the manifest the way untrusted foreign JSON could: checks
    // holding a null, and author missing entirely.
    (f.header as unknown as Record<string, unknown>)[PROVENANCE_KEY] = {
      ...(f.header as unknown as Record<string, unknown>)[PROVENANCE_KEY] as object,
      author: undefined,
      checks: [null],
    };
    assert.doesNotThrow(() => layerStackEntry(layer({ file: f })));
    const entry = layerStackEntry(layer({ file: f }));
    assert.equal(entry.authorKind, undefined, 'no author.kind to read');
    assert.equal(entry.checksTotal, 1, 'the null check still counts toward the total');
    assert.equal(entry.checksPassed, 0, 'a null check is never a pass');
  });

  it('rejects an author kind outside the known set', () => {
    const f = file([{ path: 'a', attributes: {} }], {
      author: { kind: 'human', principal: 'alice' },
      intent: 'test',
      base: null,
    });
    (f.header as unknown as Record<string, unknown>)[PROVENANCE_KEY] = {
      ...(f.header as unknown as Record<string, unknown>)[PROVENANCE_KEY] as object,
      author: { kind: 'rogue-kind', principal: 'mallory' },
    };
    const entry = layerStackEntry(layer({ file: f }));
    assert.equal(entry.authorKind, undefined, 'an unrecognized kind must not be trusted onto the panel entry');
    assert.equal(entry.authorPrincipal, 'mallory', 'principal is a plain string field, independent of the kind guard');
  });

  it('sets isMerge only when the manifest records a merge, and never sets it false', () => {
    const withoutMerge = file([{ path: 'a', attributes: {} }], {
      author: { kind: 'human', principal: 'alice' },
      intent: 'plain edit',
      base: null,
    });
    const entryPlain = layerStackEntry(layer({ file: withoutMerge }));
    assert.equal(entryPlain.isMerge, undefined, 'a non-merge layer must not carry isMerge: false either');

    const withMerge = file([{ path: 'a', attributes: {} }], {
      author: { kind: 'human', principal: 'alice' },
      intent: 'merge',
      base: null,
      merge: { candidate: 'c', into: 'main', resolutions: [], waived_checks: [], resolver: 'alice' },
    });
    const entryMerge = layerStackEntry(layer({ file: withMerge }));
    assert.equal(entryMerge.isMerge, true);
  });

  it('counts checksPassed against checksTotal, not the other way round', () => {
    const checks: ProvenanceCheck[] = [
      { tool: 't1', result: 'pass' },
      { tool: 't2', result: 'fail' },
      { tool: 't3', result: 'pass' },
    ];
    const f = file([{ path: 'a', attributes: {} }], {
      author: { kind: 'human', principal: 'alice' },
      intent: 'checked',
      base: null,
      checks,
    });
    const entry = layerStackEntry(layer({ file: f }));
    assert.equal(entry.checksTotal, 3);
    assert.equal(entry.checksPassed, 2, 'exactly the checks with result "pass"');
  });

  it('leaves checksTotal/checksPassed unset for zero checks', () => {
    const f = file([{ path: 'a', attributes: {} }], {
      author: { kind: 'human', principal: 'alice' },
      intent: 'no checks',
      base: null,
      checks: [],
    });
    const entry = layerStackEntry(layer({ file: f }));
    assert.equal(entry.checksTotal, undefined);
    assert.equal(entry.checksPassed, undefined);
  });
});

describe('computeLayerContribution', () => {
  const entries: LayerStackEntry[] = [
    { id: 'L1', name: 'base', file: file([{ path: 'a', attributes: { x: 1 } }]), nodeCount: 1, byteLength: 1 },
    { id: 'L2', name: 'second', file: file([{ path: 'a', attributes: { x: 2 } }]), nodeCount: 1, byteLength: 1 },
    // L3 writes a DIFFERENT path on purpose. While all three layers touched
    // path `a`, the L2 test below could not tell a correct diff from a
    // whole-stack one -- both report `a` modified, just to a different value.
    { id: 'L3', name: 'third', file: file([{ path: 'b', attributes: { x: 3 } }]), nodeCount: 1, byteLength: 1 },
  ];

  it('returns null for a layer id not present in the stack', async () => {
    const result = await computeLayerContribution(entries, 'nope');
    assert.equal(result, null);
  });

  it('diffs the prefix WITHOUT the layer against the prefix WITH it, not the whole stack', async () => {
    // The bug shape is [0, index) against the FULL stack rather than against
    // [0, index+1) -- L1 against L1..L3 instead of L1 against L1..L2. Only the
    // right-hand side is wrong; the left stays [L1].
    //
    // An earlier version of this comment said that diff "would be empty:
    // L1..L3 vs L1..L3 sees no change", which describes a different bug and
    // overstated what the assertions caught. The whole-stack diff is not empty
    // -- it still reports path `a` modified, just to L3's value instead of
    // L2's -- and because this test asserted only the path and never the
    // value, BOTH implementations satisfied it.
    //
    // L3 writing path `b` is what separates them: the correct diff cannot see
    // L3 at all, so `added` stays empty, while the whole-stack diff surfaces
    // `b`.
    const result = await computeLayerContribution(entries, 'L2');
    assert.ok(result);
    assert.deepEqual(result.added, [], 'L3 sits past the layer being diffed and must not appear');
    assert.equal(result.modified.length, 1);
    assert.equal(result.modified[0]?.path, 'a');
  });

  it('diffs the FIRST layer against an empty prefix, not against itself', async () => {
    // Diffing L1 against itself (index 0 to index 0) would report no change;
    // an empty base correctly shows L1 as newly added.
    const result = await computeLayerContribution(entries, 'L1');
    assert.ok(result);
    assert.deepEqual(result.added, ['a']);
    assert.equal(result.modified.length, 0);
  });
});

describe('shortContentId', () => {
  it('strips the blake3: prefix before truncating', () => {
    assert.equal(shortContentId('blake3:0123456789abcdef'), '01234567');
  });

  it('truncates a bare hex id the same way', () => {
    assert.equal(shortContentId('0123456789abcdef'), '01234567');
  });
});

describe('pathTail', () => {
  it('returns the segment after the last slash', () => {
    assert.equal(pathTail('/a/b/c'), 'c');
  });

  it('returns the whole string when there is no slash', () => {
    assert.equal(pathTail('c'), 'c');
  });

  it('returns empty string for a path ending in a slash, not the segment before it', () => {
    assert.equal(pathTail('/a/b/'), '', 'lastIndexOf finds the trailing slash, not the previous one');
  });
});
