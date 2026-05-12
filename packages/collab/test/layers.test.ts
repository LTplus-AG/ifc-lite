/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer extraction: a per-user IFCX layer round-tripped through the
 * filter must contain only that user's contribution.
 */

import { describe, expect, it } from 'vitest';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, setAttribute } from '../src/doc/entity.js';
import { captureBaseline, extractUserLayer } from '../src/snapshot/layers.js';

describe('extractUserLayer', () => {
  it('captures one peer\'s edits since baseline', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setAttribute(doc, 'wall', 'Name', 'baseline');
    const baseline = captureBaseline(doc);

    setAttribute(doc, 'wall', 'Name', 'after');
    setAttribute(doc, 'wall', 'Description', 'extra');

    const layer = extractUserLayer(doc, baseline, { clientId: doc.clientID });
    // Layer must contain at least the wall and its post-baseline updates.
    expect(layer.data.find((n) => n.path === 'wall')).toBeTruthy();
    const wallNode = layer.data.find((n) => n.path === 'wall')!;
    expect(wallNode.attributes?.Name).toBe('after');
    expect(wallNode.attributes?.Description).toBe('extra');
  });
});
