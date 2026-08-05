/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shape gates in `snapshot/structured-attrs.ts` (#1031).
 *
 * `inflateStructuredAttributes` only lifts an attribute into a structured
 * CRDT branch when its value matches the branch's wire shape; anything
 * else must stay in the flat attribute record so a foreign or truncated
 * payload survives the snapshot → seed round-trip verbatim instead of
 * being silently reinterpreted.
 *
 * The happy paths are covered indirectly (minimal-layer, to-ifcx,
 * from-ifcx). The REJECTION paths were not: mutations that made the
 * classification gate ignore `code`, the material gate accept anything,
 * and an empty geometryRef list "recognized" all survived the suite.
 */

import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import { describe, expect, it } from 'vitest';
import { createGeometry } from '../src/doc/geometry.js';
import { createCollabDoc } from '../src/doc/schema.js';
import {
  flattenStructuredBranches,
  geometryRecordLookup,
  inflateStructuredAttributes,
} from '../src/snapshot/structured-attrs.js';

const EMPTY = {
  psets: {},
  quantities: {},
  classifications: [],
  materials: [],
  geometryRefs: [],
};

describe('classification shape gate', () => {
  it('inflates refs that carry both system and code', () => {
    const out = inflateStructuredAttributes({
      [IFCLITE_ATTR.CLASSIFICATIONS]: [{ system: 'Uniclass', code: 'Pr_20' }],
    });
    expect(out.classifications).toEqual([{ system: 'Uniclass', code: 'Pr_20' }]);
    expect(out.attributes).toEqual({});
  });

  it('leaves the attribute FLAT when a ref has no code', () => {
    // A ref without a code is not a classification reference in the wire
    // contract. Accepting it would put a `code: undefined` entry in the
    // CRDT branch, and re-flattening would emit a different value than
    // the one that arrived — breaking the documented inverse property.
    const attrs = { [IFCLITE_ATTR.CLASSIFICATIONS]: [{ system: 'Uniclass' }] };
    const out = inflateStructuredAttributes(attrs);
    expect(out.classifications).toEqual([]);
    expect(out.attributes).toEqual(attrs);
  });

  it('rejects the WHOLE array when one member is malformed', () => {
    const attrs = {
      [IFCLITE_ATTR.CLASSIFICATIONS]: [
        { system: 'Uniclass', code: 'Pr_20' },
        { system: 'Uniclass' },
      ],
    };
    const out = inflateStructuredAttributes(attrs);
    expect(out.classifications).toEqual([]);
    expect(out.attributes).toEqual(attrs);
  });
});

describe('material shape gate', () => {
  it('inflates assignments that carry a materialId', () => {
    const out = inflateStructuredAttributes({
      [IFCLITE_ATTR.MATERIALS]: [{ materialId: 'mat-1' }],
    });
    expect(out.materials).toEqual([{ materialId: 'mat-1' }]);
    expect(out.attributes).toEqual({});
  });

  it.each([
    ['a bare string list', ['Concrete']],
    ['objects with no materialId', [{ name: 'Concrete' }]],
    ['a non-string materialId', [{ materialId: 7 }]],
  ])('leaves the attribute FLAT for %s', (_label, value) => {
    const attrs = { [IFCLITE_ATTR.MATERIALS]: value };
    const out = inflateStructuredAttributes(attrs);
    expect(out.materials).toEqual([]);
    expect(out.attributes).toEqual(attrs);
  });
});

describe('geometryRef shape gate', () => {
  it('accepts a bare id, a carrier, and a mixed list', () => {
    expect(inflateStructuredAttributes({ [IFCLITE_ATTR.GEOMETRY_REF]: 'g1' }).geometryRefs).toEqual(['g1']);

    const carried = inflateStructuredAttributes({
      [IFCLITE_ATTR.GEOMETRY_REF]: [{ geomId: 'g1', type: 'mesh' }, 'g2'],
    });
    expect(carried.geometryRefs).toEqual(['g1', 'g2']);
    expect(carried.geometryCarriers).toEqual([{ geomId: 'g1', type: 'mesh' }]);
  });

  it('leaves an EMPTY list flat rather than recognising a ref-less entity', () => {
    // `[]` carries no reference at all. Treating it as recognised writes
    // an empty `geometryRefs` AND drops the original attribute, so an
    // entity that had a (malformed but present) marker loses it on the
    // round-trip. It must stay flat and untouched.
    const attrs = { [IFCLITE_ATTR.GEOMETRY_REF]: [] as unknown[] };
    const out = inflateStructuredAttributes(attrs);
    expect(out.geometryRefs).toEqual([]);
    expect(out.geometryRefRecord).toBeUndefined();
    expect(out.attributes).toEqual(attrs);
  });

  it('leaves the whole attribute flat when any entry is neither an id nor a carrier', () => {
    const attrs = { [IFCLITE_ATTR.GEOMETRY_REF]: ['g1', { notAGeomId: true }] };
    const out = inflateStructuredAttributes(attrs);
    expect(out.geometryRefs).toEqual([]);
    expect(out.geometryCarriers).toEqual([]);
    expect(out.attributes).toEqual(attrs);
  });
});

describe('geometryRecordLookup', () => {
  it('carries type, source, blobHash, bbox and params for a known geometry', () => {
    const doc = createCollabDoc();
    createGeometry(doc, 'g1', {
      type: 'mesh',
      source: 'import',
      blobHash: 'sha256:abc',
      params: { radius: 2 },
      bbox: [0, 0, 0, 1, 1, 1],
    });

    expect(geometryRecordLookup(doc)('g1')).toEqual({
      type: 'mesh',
      source: 'import',
      blobHash: 'sha256:abc',
      params: { radius: 2 },
      bbox: [0, 0, 0, 1, 1, 1],
    });
  });

  it('omits `params` entirely when the geometry has none', () => {
    // `createGeometry` always installs a params Y.Map, empty or not.
    // Emitting `params: {}` for parameter-less geometry would make every
    // imported mesh snapshot differ from the same mesh seeded back, so
    // flatten(inflate(x)) would stop being an identity.
    const doc = createCollabDoc();
    createGeometry(doc, 'g1', { type: 'mesh', source: 'import' });

    const record = geometryRecordLookup(doc)('g1');
    expect(record).toEqual({ type: 'mesh', source: 'import' });
    expect(record && 'params' in record).toBe(false);
  });

  it('returns undefined for an unknown geometry, so only the id travels', () => {
    const doc = createCollabDoc();
    expect(geometryRecordLookup(doc)('missing')).toBeUndefined();

    const flat = flattenStructuredBranches(
      { attributes: {}, ...EMPTY, geometryRefs: ['missing'] },
      { geometryRecordFor: geometryRecordLookup(doc) },
    );
    expect(flat[IFCLITE_ATTR.GEOMETRY_REF]).toBe('missing');
  });
});
