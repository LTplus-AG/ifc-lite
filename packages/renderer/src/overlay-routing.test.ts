/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  shouldRouteMeshTransparent,
  shouldRouteBatchTransparent,
  splitVisibleIdsByPromotion,
} from './overlay-routing.ts';

type Overrides = Map<number, [number, number, number, number]>;

describe('shouldRouteMeshTransparent', () => {
  it('routes opaque meshes to the opaque pipeline', () => {
    assert.strictEqual(shouldRouteMeshTransparent(1.0, 0.0, 42, null), false);
    assert.strictEqual(shouldRouteMeshTransparent(0.995, 0.0, 42, null), false);
  });

  it('routes low-alpha meshes to the transparent pipeline by default', () => {
    assert.strictEqual(shouldRouteMeshTransparent(0.3, 0.0, 42, null), true);
    assert.strictEqual(shouldRouteMeshTransparent(0.5, 0.0, 42, null), true);
  });

  it('routes PBR-transparent meshes to the transparent pipeline', () => {
    // alpha near opaque but transparency > 0.01 still flags it transparent
    assert.strictEqual(shouldRouteMeshTransparent(1.0, 0.5, 42, null), true);
  });

  it('promotes a lens-overridden IfcSpace-like mesh to opaque (issue #677)', () => {
    // IfcSpace default alpha ~0.3 — without the override it would be transparent.
    // With a Pset/lens override, must route opaque so depth is written and the
    // overlay paint pass (depthCompare 'equal') can paint over it.
    const overrides: Overrides = new Map([[42, [1, 0, 0, 1]]]);
    assert.strictEqual(shouldRouteMeshTransparent(0.3, 0.0, 42, overrides), false);
  });

  it('does not promote unrelated meshes when overrides target other ids', () => {
    const overrides: Overrides = new Map([[7, [1, 0, 0, 1]]]);
    assert.strictEqual(shouldRouteMeshTransparent(0.3, 0.0, 42, overrides), true);
  });

  it('treats an empty override map as no overrides', () => {
    const overrides: Overrides = new Map();
    assert.strictEqual(shouldRouteMeshTransparent(0.3, 0.0, 42, overrides), true);
  });

  it('leaves ghost-tier overrides (alpha < 0.2) in the transparent path', () => {
    // Ghost colour (alpha 0.15) shouldn't promote — would turn faded IfcSpace
    // into opaque-cyan boxes whenever an unrelated lens rule was active.
    const overrides: Overrides = new Map([[42, [0.6, 0.6, 0.6, 0.15]]]);
    assert.strictEqual(shouldRouteMeshTransparent(0.3, 0.0, 42, overrides), true);
  });

  it('promotes "transparent" lens action (alpha 0.3) overrides', () => {
    // Lens "transparent" action emits alpha 0.3 — clearly deliberate, gets promoted.
    const overrides: Overrides = new Map([[42, [1, 0, 0, 0.3]]]);
    assert.strictEqual(shouldRouteMeshTransparent(0.3, 0.0, 42, overrides), false);
  });
});

describe('shouldRouteBatchTransparent', () => {
  it('routes opaque batches to opaque', () => {
    assert.strictEqual(shouldRouteBatchTransparent(1.0, [1, 2, 3], null), false);
  });

  it('routes transparent batches with no overrides to transparent', () => {
    assert.strictEqual(shouldRouteBatchTransparent(0.3, [1, 2, 3], null), true);
  });

  it('promotes a homogeneous overridden batch to opaque (post-split)', () => {
    // After upstream splitting, a "promoted" sub-batch contains only overridden
    // ids. The classifier sees every id has a deliberate override → opaque.
    const overrides: Overrides = new Map([
      [1, [1, 0, 0, 1]],
      [2, [0, 1, 0, 1]],
      [3, [0, 0, 1, 1]],
    ]);
    assert.strictEqual(shouldRouteBatchTransparent(0.3, [1, 2, 3], overrides), false);
  });

  it('keeps mixed batches transparent (must be split upstream)', () => {
    // Only id 2 is overridden — promoting the whole batch would turn ids 1 and
    // 3 opaque too. The renderer must split this batch upstream; the classifier
    // sees a residual mixed input and conservatively keeps it transparent.
    const overrides: Overrides = new Map([[2, [0, 1, 0, 1]]]);
    assert.strictEqual(shouldRouteBatchTransparent(0.3, [1, 2, 3], overrides), true);
  });

  it('keeps the batch transparent when no id is overridden', () => {
    const overrides: Overrides = new Map([[99, [0, 1, 0, 1]]]);
    assert.strictEqual(shouldRouteBatchTransparent(0.3, [1, 2, 3], overrides), true);
  });

  it('treats an empty override map as no overrides', () => {
    const overrides: Overrides = new Map();
    assert.strictEqual(shouldRouteBatchTransparent(0.3, [1, 2, 3], overrides), true);
  });

  it('handles empty batches safely', () => {
    assert.strictEqual(shouldRouteBatchTransparent(0.3, [], null), true);
    const overrides: Overrides = new Map([[1, [0, 1, 0, 1]]]);
    assert.strictEqual(shouldRouteBatchTransparent(0.3, [], overrides), true);
  });

  it('does not promote a batch whose only overridden id is ghost-tier', () => {
    // Lens auto-fade for unmatched entities (alpha 0.15) — leave batch in
    // transparent path so previously-faded IfcSpace stays faded.
    const overrides: Overrides = new Map([[2, [0.6, 0.6, 0.6, 0.15]]]);
    assert.strictEqual(shouldRouteBatchTransparent(0.3, [1, 2, 3], overrides), true);
  });

  it('does not promote when an id has only a ghost-tier override (mixed batch)', () => {
    // With strict all-or-none semantics, a single ghost-tier override
    // disqualifies the whole batch from promotion — the splitter would have
    // separated deliberate overrides into their own sub-batch.
    const overrides: Overrides = new Map([
      [1, [0.6, 0.6, 0.6, 0.15]], // ghost
      [2, [1, 0, 0, 1]],          // deliberate
    ]);
    assert.strictEqual(shouldRouteBatchTransparent(0.3, [1, 2, 3], overrides), true);
  });
});

describe('splitVisibleIdsByPromotion', () => {
  it('returns null when there are no overrides', () => {
    assert.strictEqual(splitVisibleIdsByPromotion([1, 2, 3], null), null);
    assert.strictEqual(splitVisibleIdsByPromotion([1, 2, 3], new Map()), null);
  });

  it('returns null when no input id is overridden', () => {
    const overrides: Overrides = new Map([[99, [1, 0, 0, 1]]]);
    assert.strictEqual(splitVisibleIdsByPromotion([1, 2, 3], overrides), null);
  });

  it('splits ids into promoted (deliberate) and remaining', () => {
    const overrides: Overrides = new Map([
      [1, [1, 0, 0, 1]],          // deliberate
      [3, [0, 1, 0, 0.5]],        // deliberate (transparent action)
    ]);
    const split = splitVisibleIdsByPromotion([1, 2, 3, 4], overrides);
    assert.ok(split != null);
    assert.deepStrictEqual([...split!.promoted].sort(), [1, 3]);
    assert.deepStrictEqual([...split!.remaining].sort(), [2, 4]);
  });

  it('keeps ghost-tier overrides in remaining', () => {
    const overrides: Overrides = new Map([
      [1, [1, 0, 0, 1]],            // deliberate
      [2, [0.6, 0.6, 0.6, 0.15]],   // ghost
    ]);
    const split = splitVisibleIdsByPromotion([1, 2, 3], overrides);
    assert.ok(split != null);
    assert.deepStrictEqual([...split!.promoted], [1]);
    assert.deepStrictEqual([...split!.remaining].sort(), [2, 3]);
  });

  it('returns empty remaining when every id is deliberately overridden', () => {
    // Caller should keep the whole input on the opaque path — no split needed.
    const overrides: Overrides = new Map([
      [1, [1, 0, 0, 1]],
      [2, [0, 1, 0, 1]],
    ]);
    const split = splitVisibleIdsByPromotion([1, 2], overrides);
    assert.ok(split != null);
    assert.deepStrictEqual([...split!.promoted].sort(), [1, 2]);
    assert.strictEqual(split!.remaining.size, 0);
  });
});
