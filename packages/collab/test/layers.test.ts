/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer extraction: a per-user IFCX layer round-tripped through the
 * filter must contain only that user's contribution.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
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

  it('excludes a second peer\'s edits — the single-client fixture above cannot observe this', () => {
    // With only one clientID ever touching `doc`, the test above passes
    // whether or not `filterUpdateByClient` actually filters anything —
    // "everything belongs to the only client" is true either way. This
    // fixture needs two distinct clientIDs to discriminate "filtered
    // correctly" from "filtering is a no-op".
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setAttribute(doc, 'wall', 'Name', 'from-peer-A');
    const clientA = doc.clientID;

    const peerDoc = createCollabDoc();
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(doc));
    peerDoc.clientID = clientA + 1; // distinct from doc's clientID
    setAttribute(peerDoc, 'wall', 'Description', 'from-peer-B');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peerDoc, Y.encodeStateVector(doc)));

    const layer = extractUserLayer(doc, undefined, { clientId: clientA });
    const wallNode = layer.data.find((n) => n.path === 'wall');
    expect(wallNode?.attributes?.Name).toBe('from-peer-A');
    expect(wallNode?.attributes?.Description).toBeUndefined();
  });
});
