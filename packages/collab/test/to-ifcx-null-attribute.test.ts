/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `to-ifcx` and `from-ifcx` must agree on what a literal `null` flat
 * attribute value means.
 *
 * `from-ifcx.ts` documents (and enforces) that a `null` attribute value
 * is an IFCX "removal opinion": with no underlying layer to remove from,
 * it means "absent", so `seedFromIfcx` never stores it.
 *
 * A doc attribute can legitimately hold a literal `null` today —
 * `apps/viewer`'s `mutation-bridge.ts` writes exactly that when a user
 * clears a root attribute (`toScalar(null) === null`, fed straight into
 * `setAttribute`). Before this fix, `snapshotToIfcx` serialized that
 * `null` verbatim, so a snapshot → seed → snapshot cycle was NOT
 * idempotent: the first snapshot carries `"Description": null`, the
 * seed drops the key (per from-ifcx's own contract), and the second
 * snapshot of the re-seeded doc omits the key entirely — two snapshots
 * of "the same" doc state that disagree with each other.
 */

import { describe, expect, it } from 'vitest';
import { createEntity, setAttribute } from '../src/doc/entity.js';
import { createCollabDoc } from '../src/doc/schema.js';
import { seedFromIfcx } from '../src/snapshot/from-ifcx.js';
import { snapshotToIfcx } from '../src/snapshot/to-ifcx.js';

describe('to-ifcx / from-ifcx agreement on null attribute values', () => {
  it('keeps a snapshot -> seed -> snapshot cycle idempotent for a null attribute', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/e1', { ifcClass: 'IfcWall' });
    // Mirrors mutation-bridge.ts clearing a root attribute to null.
    setAttribute(doc, '/e1', 'Description', null);

    const snapshot1 = snapshotToIfcx(doc, { timestamp: 'T' });
    const node1 = snapshot1.data.find((n) => n.path === '/e1');

    const doc2 = createCollabDoc();
    seedFromIfcx(doc2, snapshot1);
    const snapshot2 = snapshotToIfcx(doc2, { timestamp: 'T' });
    const node2 = snapshot2.data.find((n) => n.path === '/e1');

    // The writer must not hand out a value its own reader treats as
    // "absent" (a literal `null`) — that produced a first snapshot that
    // disagreed with every snapshot taken after the first re-seed.
    expect(node1?.attributes?.Description).not.toBe(null);
    expect(node1).toEqual(node2);
  });
});
