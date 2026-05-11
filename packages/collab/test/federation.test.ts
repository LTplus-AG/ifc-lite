/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  createFederationSession,
  type FederationRecord,
} from '../src/federation/session.js';
import { createEntity, setAttribute } from '../src/doc/entity.js';

describe('FederationSession', () => {
  it('hosts multiple model rooms and a shared `_federation` doc', async () => {
    const fed = await createFederationSession({
      projectId: 'proj-1',
      user: { id: 'louis', name: 'Louis' },
      models: ['arch', 'mep'],
      provider: 'memory',
    });

    expect(fed.modelIds().sort()).toEqual(['arch', 'mep']);
    expect(fed.federationRoomId).toBe('proj-1/_federation');
    expect(fed.models.get('arch')!.roomId).toBe('proj-1/arch');
    expect(fed.models.get('mep')!.roomId).toBe('proj-1/mep');

    // Edits go to the per-model Y.Doc; presence rides on _federation.
    fed.models.get('arch')!.transact(() => {
      const doc = fed.models.get('arch')!.doc;
      createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
      setAttribute(doc, 'wall', 'Name', 'arch-wall');
    });

    fed.upsertRecord({
      recordId: 'clash-1',
      type: 'clash',
      refs: [
        { modelId: 'arch', globalId: 'wall' },
        { modelId: 'mep', globalId: 'duct' },
      ],
      resolution: 'open',
    });
    expect(fed.listRecords()).toEqual<FederationRecord[]>([
      {
        recordId: 'clash-1',
        type: 'clash',
        refs: [
          { modelId: 'arch', globalId: 'wall' },
          { modelId: 'mep', globalId: 'duct' },
        ],
        resolution: 'open',
        bcfTopicId: undefined,
        meta: undefined,
      },
    ]);

    expect(fed.getRecord('clash-1')?.type).toBe('clash');
    expect(fed.removeRecord('clash-1')).toBe(true);
    expect(fed.listRecords()).toEqual([]);

    await fed.dispose();
  });

  it('addModel / removeModel work after construction', async () => {
    const fed = await createFederationSession({
      projectId: 'proj-2',
      user: { id: 'anna', name: 'Anna' },
      models: ['arch'],
      provider: 'memory',
    });
    expect(fed.modelIds()).toEqual(['arch']);
    await fed.addModel('struct');
    expect(fed.modelIds().sort()).toEqual(['arch', 'struct']);
    await fed.removeModel('arch');
    expect(fed.modelIds()).toEqual(['struct']);
    await fed.dispose();
  });

  it('observeRecords notifies on changes', async () => {
    const fed = await createFederationSession({
      projectId: 'proj-3',
      user: { id: 'sven', name: 'Sven' },
      models: [],
      provider: 'memory',
    });
    const seen: number[] = [];
    const off = fed.observeRecords((records) => seen.push(records.length));
    fed.upsertRecord({ recordId: 'r1', type: 'rfi', refs: [] });
    fed.upsertRecord({ recordId: 'r2', type: 'rfi', refs: [] });
    fed.removeRecord('r1');
    // Y observer fires synchronously after each transaction.
    expect(seen).toEqual([1, 2, 1]);
    off();
    await fed.dispose();
  });
});
