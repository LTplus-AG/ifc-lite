/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  isMeshVisibleInViewMode,
  meshClassIsPlaced,
  meshIsNonOccurrence,
  selectModelMeshes,
} from './type-view-visibility.js';

describe('meshClassIsPlaced (#1353 layer-slice follow-up)', () => {
  it('counts occurrences (0) AND material-layer slices (3) as placed geometry', () => {
    assert.equal(meshClassIsPlaced(0), true);
    assert.equal(meshClassIsPlaced(3), true);
  });
  it('does NOT count type-library geometry (orphan 1 / instanced 2) as placed', () => {
    // else a pure type-library file would wrongly think it has occurrences.
    assert.equal(meshClassIsPlaced(1), false);
    assert.equal(meshClassIsPlaced(2), false);
  });
});

describe('meshIsNonOccurrence — the Model/Types toggle gate', () => {
  it('treats a missing class as an occurrence, so it does not offer the toggle', () => {
    // `?? occurrence` is the long-standing default at every call site: a mesh
    // predating the tag is real geometry. Getting this wrong would offer the
    // Types toggle on a model that has no type geometry at all.
    assert.equal(meshIsNonOccurrence({}), false);
    assert.equal(meshIsNonOccurrence({ geometryClass: undefined }), false);
    assert.equal(meshIsNonOccurrence({ geometryClass: 0 }), false);
  });

  it('counts orphan, instanced AND layer-slice geometry as non-occurrence', () => {
    // Deliberately broader than `isTypeLibraryGeometryClass` (orphan +
    // instanced only): class 3 is placed geometry, yet this gate has always
    // counted it. That is the shipped behaviour of the toggle and is
    // preserved exactly here rather than quietly tightened — whether a
    // layered wall alone should offer the toggle is a separate question.
    assert.equal(meshIsNonOccurrence({ geometryClass: 1 }), true);
    assert.equal(meshIsNonOccurrence({ geometryClass: 2 }), true);
    assert.equal(meshIsNonOccurrence({ geometryClass: 3 }), true);
  });

  it('disagrees with meshClassIsPlaced exactly on the layer slice', () => {
    // The two predicates are NOT complements, and the one place they differ is
    // the one worth pinning: class 3 is both "placed" and "non-occurrence".
    assert.equal(meshClassIsPlaced(3), true);
    assert.equal(meshIsNonOccurrence({ geometryClass: 3 }), true);
  });
});

describe('isMeshVisibleInViewMode (#1353)', () => {
  describe('Model view of a real model (has occurrences)', () => {
    const vis = (c: number) => isMeshVisibleInViewMode(c, 'model', true);
    it('shows occurrences and layer slices', () => {
      assert.equal(vis(0), true);
      assert.equal(vis(3), true);
    });
    it('hides instanced-type duplicates', () => {
      assert.equal(vis(2), false);
    });
    it('hides ORPHAN type-library geometry (the #1353 fix)', () => {
      // Bonsai-authored unplaced IfcXxxType defs must not clutter the Model view.
      assert.equal(vis(1), false);
    });
  });

  describe('Model view of a pure type-library file (no occurrences — annex-E)', () => {
    const vis = (c: number) => isMeshVisibleInViewMode(c, 'model', false);
    it('STILL shows orphan types so the view is not blank (no regression)', () => {
      assert.equal(vis(1), true);
    });
    it('still hides instanced-type duplicates', () => {
      assert.equal(vis(2), false);
    });
  });

  describe('Types view', () => {
    const vis = (c: number) => isMeshVisibleInViewMode(c, 'types', true);
    it('shows orphan + instanced type geometry', () => {
      assert.equal(vis(1), true);
      assert.equal(vis(2), true);
    });
    it('hides occurrences and layer slices', () => {
      assert.equal(vis(0), false);
      assert.equal(vis(3), false);
    });
  });

  it('the Model/Types switch now actually changes what renders for a Bonsai model', () => {
    // An orphan type flips visibility between the two modes (it was stuck-on before).
    assert.notEqual(
      isMeshVisibleInViewMode(1, 'model', true),
      isMeshVisibleInViewMode(1, 'types', true),
    );
  });
});

describe('selectModelMeshes — the mesh set a 2D drawing cuts (#2058)', () => {
  const m = (expressId: number, geometryClass?: number) => ({ expressId, geometryClass });

  it('keeps occurrences and layer slices, drops the type library', () => {
    const kept = selectModelMeshes([m(1, 0), m(2, 2), m(3, 1), m(4, 3)]);
    assert.deepEqual(kept.map((x) => x.expressId), [1, 4]);
  });

  it('treats an absent geometryClass as an occurrence (legacy caches)', () => {
    const kept = selectModelMeshes([m(7), m(8, 2)]);
    assert.deepEqual(kept.map((x) => x.expressId), [7]);
  });

  it('keeps orphan types when the file has no placed occurrence at all', () => {
    // Pure type-library file: dropping class 1 here would blank the drawing,
    // the same trap `isMeshVisibleInViewMode` already guards for 3D.
    const kept = selectModelMeshes([m(1, 1), m(2, 2)]);
    assert.deepEqual(kept.map((x) => x.expressId), [1]);
  });
});
