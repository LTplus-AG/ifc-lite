/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isMeshVisibleInViewMode } from './type-view-visibility.js';

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
