/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins the `seedFromIfcx(doc, ifcx, { reset })` contract.
 *
 * `reset: true` must clear `entities`/`relationships`/`geometry` before
 * reseeding; `reset: false` must preserve whatever was already on the doc.
 * `mergeBranch('layer')` deliberately calls seedFromIfcx with
 * `reset: false` (see branch.ts) so a branch merge never wipes the
 * parent's own content — that is a data-loss risk, not a mere ordering
 * detail, so it gets a dedicated regression test too.
 */

import { describe, expect, it } from 'vitest';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { createCollabDoc, entitiesMap, geometryMap, relationshipsMap } from '../src/doc/schema.js';
import { createEntity, getEntity } from '../src/doc/entity.js';
import { createGeometry } from '../src/doc/geometry.js';
import { createRelationship } from '../src/doc/relationship.js';
import { seedFromIfcx } from '../src/snapshot/from-ifcx.js';
import { createCollabSession } from '../src/session.js';
import { forkSession, mergeBranch } from '../src/branch/branch.js';

function minimalIfcx(paths: string[]): IfcxFile {
  return {
    header: { version: '5.0' } as IfcxFile['header'],
    data: paths.map((path) => ({ path, attributes: {} })),
  } as IfcxFile;
}

describe('seedFromIfcx reset contract', () => {
  it('reset: true clears entities, relationships and geometry before reseeding', () => {
    const doc = createCollabDoc();
    doc.transact(() => {
      createEntity(doc, 'old-wall', { ifcClass: 'IfcWall' });
      createRelationship(doc, 'old-rel', { ifcClass: 'IfcRelAggregates', source: 'old-wall' });
      createGeometry(doc, 'old-geom', { type: 'parametric', source: 'extruded-area-solid' });
    });
    expect(entitiesMap(doc).has('old-wall')).toBe(true);
    expect(relationshipsMap(doc).has('old-rel')).toBe(true);
    expect(geometryMap(doc).has('old-geom')).toBe(true);

    seedFromIfcx(doc, minimalIfcx(['new-wall']), { reset: true });

    // Old content in all three maps is gone.
    expect(entitiesMap(doc).has('old-wall')).toBe(false);
    expect(relationshipsMap(doc).has('old-rel')).toBe(false);
    expect(geometryMap(doc).has('old-geom')).toBe(false);
    // New content from the reseed landed.
    expect(entitiesMap(doc).has('new-wall')).toBe(true);
  });

  it('reset: false preserves pre-existing entities, relationships and geometry', () => {
    const doc = createCollabDoc();
    doc.transact(() => {
      createEntity(doc, 'old-wall', { ifcClass: 'IfcWall' });
      createRelationship(doc, 'old-rel', { ifcClass: 'IfcRelAggregates', source: 'old-wall' });
      createGeometry(doc, 'old-geom', { type: 'parametric', source: 'extruded-area-solid' });
    });

    seedFromIfcx(doc, minimalIfcx(['new-wall']), { reset: false });

    expect(entitiesMap(doc).has('old-wall')).toBe(true);
    expect(relationshipsMap(doc).has('old-rel')).toBe(true);
    expect(geometryMap(doc).has('old-geom')).toBe(true);
    expect(entitiesMap(doc).has('new-wall')).toBe(true);
  });

  it('mergeBranch("layer") does not reset the parent — content added to the parent after the fork survives', async () => {
    const parent = await createCollabSession({
      roomId: 'parent-reset-check',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => createEntity(parent.doc, 'wall', { ifcClass: 'IfcWall' }));

    const branch = await forkSession(parent, { name: 'add-window' });
    branch.session.transact(() => createEntity(branch.session.doc, 'window'));

    // Parent gains content *after* the fork, so the branch never carries
    // it — the branch's IFCX snapshot has no idea `door` exists. If the
    // 'layer' merge resets the parent before reseeding, this is exactly
    // the content that would be silently dropped.
    parent.transact(() => createEntity(parent.doc, 'door', { ifcClass: 'IfcDoor' }));

    mergeBranch(parent, branch, 'layer');

    // The branch's own addition landed...
    expect(entitiesMap(parent.doc).has('window')).toBe(true);
    // ...but the parent's post-fork content, which the branch snapshot
    // does not carry, must not have been wiped by the re-seed.
    expect(entitiesMap(parent.doc).has('door')).toBe(true);
    expect(getEntity(parent.doc, 'door')).toBeDefined();

    branch.session.dispose();
    parent.dispose();
  });
});
