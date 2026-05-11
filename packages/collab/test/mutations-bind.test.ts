/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { createCollabSession } from '../src/session.js';
import { createEntity, getPropertyValue } from '../src/doc/entity.js';
import { bindMutationsToCollab } from '../src/mutations/bind.js';

describe('bindMutationsToCollab', () => {
  it('mirrors setProperty into the Y.Doc', async () => {
    const session = await createCollabSession({
      roomId: 'r',
      user: { id: 'u', name: 'U' },
      provider: 'memory',
    });

    // Pre-create the wall entity in the Y.Doc; the resolver maps the
    // numeric id 42 to the path 'wall-uuid'.
    session.transact(() => createEntity(session.doc, 'wall-uuid', { ifcClass: 'IfcWall' }));

    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);

    const bound = bindMutationsToCollab(view, session, {
      resolveEntity: (id) => (id === 42 ? 'wall-uuid' : null),
    });

    bound.setProperty(42, 'Pset_WallCommon', 'FireRating', 'EI60', PropertyValueType.Label);

    // Local view sees the new property.
    expect(view.getPropertyValue(42, 'Pset_WallCommon', 'FireRating')).toBe('EI60');
    // Y.Doc sees it too.
    const yv = getPropertyValue(session.doc, 'wall-uuid', 'Pset_WallCommon', 'FireRating');
    expect(yv?.value).toBe('EI60');
    expect(yv?.type).toBe('IfcLabel');
    expect(yv?.source).toBe('mutation');

    session.dispose();
  });

  it('skips Y.Doc mirror when resolveEntity returns null', async () => {
    const session = await createCollabSession({
      roomId: 'r2',
      user: { id: 'u', name: 'U' },
      provider: 'memory',
    });

    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);

    const bound = bindMutationsToCollab(view, session, {
      resolveEntity: () => null,
    });

    bound.setProperty(99, 'P', 'X', 'value', PropertyValueType.Label);
    expect(view.getPropertyValue(99, 'P', 'X')).toBe('value');

    session.dispose();
  });

  it('deleteProperty mirrors into the Y.Doc', async () => {
    const session = await createCollabSession({
      roomId: 'r3',
      user: { id: 'u', name: 'U' },
      provider: 'memory',
    });

    session.transact(() => createEntity(session.doc, 'w', { ifcClass: 'IfcWall' }));

    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);

    const bound = bindMutationsToCollab(view, session, {
      resolveEntity: () => 'w',
    });

    bound.setProperty(1, 'P', 'X', 'v', PropertyValueType.Label);
    bound.deleteProperty(1, 'P', 'X');

    expect(getPropertyValue(session.doc, 'w', 'P', 'X')).toBeUndefined();

    session.dispose();
  });
});
