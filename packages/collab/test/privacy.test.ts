/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { createCollabSession } from '../src/session.js';
import { createEntity, setAttribute, entityToJSON } from '../src/doc/entity.js';
import { entitiesMap } from '../src/doc/schema.js';
import { exportAndLeave, redactAuthorMeta } from '../src/privacy.js';

describe('privacy / GDPR helpers', () => {
  it('exportAndLeave returns IFCX, sets status offline, and disposes', async () => {
    const session = await createCollabSession({
      roomId: 'r',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    session.transact(() => {
      createEntity(session.doc, 'wall', { ifcClass: 'IfcWall' });
      setAttribute(session.doc, 'wall', 'Name', 'W1');
    });
    const result = await exportAndLeave(session);
    expect(result.ifcx.data.length).toBeGreaterThan(0);
    expect(result.serverDeletion).toBe('skipped');
  });

  it('exportAndLeave runs the optional serverDelete hook', async () => {
    const session = await createCollabSession({
      roomId: 'r2',
      user: { id: 'anna', name: 'Anna' },
      provider: 'memory',
    });
    const serverDelete = vi.fn(async () => {});
    const result = await exportAndLeave(session, { serverDelete });
    expect(serverDelete).toHaveBeenCalledOnce();
    expect(result.serverDeletion).toBe('ok');
  });

  it('exportAndLeave reports failed serverDelete without throwing', async () => {
    const session = await createCollabSession({
      roomId: 'r3',
      user: { id: 'mark', name: 'Mark' },
      provider: 'memory',
    });
    const result = await exportAndLeave(session, {
      serverDelete: async () => {
        throw new Error('upstream-down');
      },
    });
    expect(result.serverDeletion).toBe('failed');
    expect((result.serverDeletionError as Error).message).toBe('upstream-down');
  });

  it('redactAuthorMeta blanks createdBy / lastEditedBy on every entity', async () => {
    const session = await createCollabSession({
      roomId: 'r4',
      user: { id: 'sven', name: 'Sven' },
      provider: 'memory',
    });
    session.transact(() => {
      createEntity(session.doc, 'a', {
        ifcClass: 'IfcWall',
        meta: { createdBy: 'sven', lastEditedBy: 'sven' },
      });
      createEntity(session.doc, 'b', {
        ifcClass: 'IfcWall',
        meta: { createdBy: 'anna' },
      });
    });
    const touched = redactAuthorMeta(session);
    expect(touched).toBe(2);
    const a = entityToJSON(entitiesMap(session.doc).get('a')!);
    expect(a.meta.createdBy).toBeNull();
    expect(a.meta.lastEditedBy).toBeNull();
    session.dispose();
  });
});
