/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getProvenance } from '@ifc-lite/ifcx';
import { createCollabSession, createEntity, setAttribute } from '@ifc-lite/collab';
import { extractStackState } from '@ifc-lite/merge';
import { BrowserLayerStore } from './browser-store.js';
import { publishCollabDraft } from './publish.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';

describe('collab session draft publishing (#1717)', () => {
  it('freezes Y.Doc edits since the fork point into a hybrid-authored layer on the local ref', async () => {
    const session = await createCollabSession({
      roomId: 'test-room',
      user: { id: 'u1', name: 'alice' },
      provider: 'memory',
    });
    try {
      createEntity(session.doc, 'wall-guid-1', { ifcClass: 'IfcWall' });
      const baseline = session.captureDocState();
      setAttribute(session.doc, 'wall-guid-1', FIRE, 'REI90');

      const store = await BrowserLayerStore.open();
      const result = await publishCollabDraft({
        store,
        doc: session.doc,
        baseline,
        stackFiles: [],
        intent: 'Session fire-rating pass',
        authorPrincipal: 'alice',
        hybrid: true,
        refName: 'local',
      });
      assert.ok(result.layerId.startsWith('blake3:'));
      assert.ok(result.opCount > 0);
      // Stored, appended to the ref, and provenance-stamped as hybrid.
      assert.deepStrictEqual(store.getRef('local')?.layers, [result.layerId]);
      const manifest = getProvenance(store.loadLayer(result.layerId));
      assert.strictEqual(manifest?.author.kind, 'hybrid');
      assert.strictEqual(manifest?.intent, 'Session fire-rating pass');
      // The delta carries ONLY the post-baseline edit, on the GUID path.
      const state = extractStackState([result.file]);
      assert.strictEqual(state.get('wall-guid-1')?.components.get('pset:Pset_FireSafety')?.[FIRE], 'REI90');

      // Nothing new since the last fork point: refuse an empty layer.
      const forward = session.captureDocState();
      await assert.rejects(
        publishCollabDraft({
          store,
          doc: session.doc,
          baseline: forward,
          stackFiles: [],
          intent: 'Nothing changed',
          authorPrincipal: 'alice',
          hybrid: false,
          refName: 'local',
        }),
        /No session edits/,
      );

      // A fresh edit after the moved fork point publishes delta-only.
      setAttribute(session.doc, 'wall-guid-1', FIRE, 'REI120');
      const second = await publishCollabDraft({
        store,
        doc: session.doc,
        baseline: forward,
        stackFiles: [result.file],
        intent: 'Bump to REI120',
        authorPrincipal: 'alice',
        hybrid: false,
        refName: 'local',
      });
      const secondManifest = getProvenance(store.loadLayer(second.layerId));
      assert.strictEqual(secondManifest?.author.kind, 'human');
      assert.strictEqual(secondManifest?.base?.kind, 'stack');
      assert.deepStrictEqual(store.getRef('local')?.layers, [result.layerId, second.layerId]);
      const composed = extractStackState([result.file, second.file]);
      assert.strictEqual(composed.get('wall-guid-1')?.components.get('pset:Pset_FireSafety')?.[FIRE], 'REI120');
    } finally {
      session.dispose();
    }
  });
});
