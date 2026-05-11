/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, setAttribute, setChild } from '../src/doc/entity.js';
import { extractMinimalLayer } from '../src/snapshot/minimal-layer.js';

describe('extractMinimalLayer', () => {
  it('emits only entities created or updated since baseline', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
    setAttribute(doc, 'wall', 'Name', 'baseline-name');
    const baseline = Y.encodeStateAsUpdate(doc);

    // Mutate after baseline.
    createEntity(doc, 'window');
    setAttribute(doc, 'wall', 'Description', 'added-after-baseline');

    const layer = extractMinimalLayer(doc, baseline);
    const paths = layer.data.map((n) => n.path).sort();
    expect(paths).toEqual(['wall', 'window']);

    const wall = layer.data.find((n) => n.path === 'wall')!;
    // Description was added → must appear.
    expect(wall.attributes?.Description).toBe('added-after-baseline');
    // Name was unchanged → must NOT appear.
    expect(wall.attributes?.Name).toBeUndefined();

    const window = layer.data.find((n) => n.path === 'window')!;
    // New entity has whatever attributes it carries (here: bsi::ifc::class
    // was never set explicitly, so attributes may be empty / absent).
    expect(window.path).toBe('window');
  });

  it('treats updated values as diffs by default', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setAttribute(doc, 'wall', 'Name', 'first');
    const baseline = Y.encodeStateAsUpdate(doc);

    setAttribute(doc, 'wall', 'Name', 'second');

    const layer = extractMinimalLayer(doc, baseline);
    const wall = layer.data.find((n) => n.path === 'wall')!;
    expect(wall.attributes?.Name).toBe('second');
  });

  it('with includeUpdatedValues:false only emits brand-new keys', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setAttribute(doc, 'wall', 'Name', 'first');
    const baseline = Y.encodeStateAsUpdate(doc);

    setAttribute(doc, 'wall', 'Name', 'second');
    setAttribute(doc, 'wall', 'Description', 'new-key');

    const layer = extractMinimalLayer(doc, baseline, { includeUpdatedValues: false });
    const wall = layer.data.find((n) => n.path === 'wall');
    expect(wall?.attributes?.Description).toBe('new-key');
    expect(wall?.attributes?.Name).toBeUndefined();
  });

  it('captures children diffs', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'storey');
    createEntity(doc, 'wall');
    const baseline = Y.encodeStateAsUpdate(doc);

    setChild(doc, 'storey', 'Wall', 'wall');

    const layer = extractMinimalLayer(doc, baseline);
    const storey = layer.data.find((n) => n.path === 'storey');
    expect(storey?.children).toEqual({ Wall: 'wall' });
  });

  it('round-trip: baseline + minimal layer composes back to live state for entity set', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'a');
    createEntity(doc, 'b');
    setAttribute(doc, 'a', 'Name', 'A1');
    const baseline = Y.encodeStateAsUpdate(doc);

    createEntity(doc, 'c');
    setAttribute(doc, 'a', 'Description', 'A-desc');

    const layer = extractMinimalLayer(doc, baseline);
    // The live doc has {a, b, c}; the baseline doc has {a, b}; the
    // minimal layer must mention {a (changed), c (new)} and nothing
    // else.
    const layerPaths = new Set(layer.data.map((n) => n.path));
    expect(layerPaths.has('a')).toBe(true);
    expect(layerPaths.has('c')).toBe(true);
    expect(layerPaths.has('b')).toBe(false);
  });
});
