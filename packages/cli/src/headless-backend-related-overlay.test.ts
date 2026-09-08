/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `HeadlessBackend.query.related()` read `store.relationships` alone — the
 * parsed file's immutable graph. `bim.store.addEntity('default', { type:
 * 'IfcRelAggregates', ... })` deliberately never touches that graph; the
 * queued record lives only in the session's `MutablePropertyView` overlay
 * until an export. So a script that related two entities this way and then
 * asked `related()` to confirm — from either end — was told its own write
 * had not happened.
 *
 * `@ifc-lite/mcp`'s parallel `HeadlessLikeBackend` already folds queued
 * relationships into `related()` for exactly this reason
 * (`packages/mcp/src/overlay.ts`, #2014) — this backend did not, so the same
 * script produced different `related()` results depending on whether it ran
 * under the CLI or under MCP.
 *
 * Exercised against `HeadlessBackend.query` directly (not `BimContext`):
 * `BimContext.related()` maps each `EntityRef` through
 * `backend.query.entityData()`, and `entityData()` for a newly-*created*
 * entity is a separate, already-tracked gap (#3498). Relating two walls the
 * *file* already defines — only the `IfcRelAggregates` record between them is
 * queued, and this fixture aggregates no wall to another — isolates the
 * defect this test is pinning from that one.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadIfcFile } from './loader.js';
import { HeadlessBackend } from './headless-backend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = join(__dirname, '../../../apps/viewer/public/samples/building-architecture.ifc');

describe('HeadlessBackend query.related() overlay visibility', () => {
  it('sees a queued IfcRelAggregates both ways in the same session', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');

    const [parent, child] = backend.query.entities({ types: ['IfcWall'] });
    expect(parent).toBeDefined();
    expect(child).toBeDefined();

    // Confirm the file itself relates neither direction between these two —
    // otherwise the fold below could pass by coincidence.
    expect(backend.query.related(parent.ref, 'IfcRelAggregates', 'forward')).toEqual([]);
    expect(backend.query.related(child.ref, 'IfcRelAggregates', 'inverse')).toEqual([]);

    backend.store.addEntity('default', {
      type: 'IfcRelAggregates',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzz'", null, null, null, `#${parent.ref.expressId}`, [`#${child.ref.expressId}`]],
    });

    // forward: the parent's queued children include the child.
    const forward = backend.query.related(parent.ref, 'IfcRelAggregates', 'forward');
    expect(forward.some((r) => r.expressId === child.ref.expressId)).toBe(true);

    // inverse: the child's queued parent resolves back to the parent.
    const inverse = backend.query.related(child.ref, 'IfcRelAggregates', 'inverse');
    expect(inverse.some((r) => r.expressId === parent.ref.expressId)).toBe(true);
  });

  it('a deleted entity relates to nothing, even via a queued relationship', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');

    const [parent, child] = backend.query.entities({ types: ['IfcWall'] });

    backend.store.addEntity('default', {
      type: 'IfcRelAggregates',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzz'", null, null, null, `#${parent.ref.expressId}`, [`#${child.ref.expressId}`]],
    });
    backend.store.removeEntity(child.ref);

    const forward = backend.query.related(parent.ref, 'IfcRelAggregates', 'forward');
    expect(forward.some((r) => r.expressId === child.ref.expressId)).toBe(false);
  });
});
