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

    const relationship = backend.store.addEntity('default', {
      type: 'IfcRelAggregates',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzz'", null, null, null, `#${parent.ref.expressId}`, [`#${child.ref.expressId}`]],
    });

    // forward: the parent's queued children include the child.
    const forward = backend.query.related(parent.ref, 'IfcRelAggregates', 'forward');
    expect(forward.some((r) => r.expressId === child.ref.expressId)).toBe(true);

    // inverse: the child's queued parent resolves back to the parent.
    const inverse = backend.query.related(child.ref, 'IfcRelAggregates', 'inverse');
    expect(inverse.some((r) => r.expressId === parent.ref.expressId)).toBe(true);

    // The detailed relationship surface must describe the same effective graph.
    expect(backend.query.relationships(parent.ref).relations).toContainEqual(expect.objectContaining({
      relationshipId: relationship.expressId,
      relationshipType: 'IfcRelAggregates',
      direction: 'forward',
      entity: expect.objectContaining({ id: child.ref.expressId, type: 'IfcWall' }),
    }));
    expect(backend.query.relationships(child.ref).relations).toContainEqual(expect.objectContaining({
      relationshipId: relationship.expressId,
      relationshipType: 'IfcRelAggregates',
      direction: 'inverse',
      entity: expect.objectContaining({ id: parent.ref.expressId, type: 'IfcWall' }),
    }));

    backend.store.removeEntity(relationship);
    expect(backend.query.relationships(parent.ref).relations?.some(
      (edge) => edge.relationshipId === relationship.expressId,
    )).toBe(false);
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

  it('uses positional endpoint overrides on a queued relationship', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const [parent, originalChild, replacementChild] = backend.query.entities({ types: ['IfcWall'] });

    const relationship = backend.store.addEntity('default', {
      type: 'IfcRelAggregates',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzz'", null, null, null, `#${parent.ref.expressId}`, [`#${originalChild.ref.expressId}`]],
    });
    backend.store.setPositionalAttribute(relationship, 5, [`#${replacementChild.ref.expressId}`]);

    const related = backend.query.related(parent.ref, 'IfcRelAggregates', 'forward');
    expect(related.some((ref) => ref.expressId === originalChild.ref.expressId)).toBe(false);
    expect(related.some((ref) => ref.expressId === replacementChild.ref.expressId)).toBe(true);
    const rows = backend.query.relationships(parent.ref).relations ?? [];
    expect(rows.some((edge) => edge.relationshipId === relationship.expressId
      && edge.entity.id === originalChild.ref.expressId)).toBe(false);
    expect(rows.some((edge) => edge.relationshipId === relationship.expressId
      && edge.entity.id === replacementChild.ref.expressId)).toBe(true);

    // Export applies positional overrides after named overrides. Readback must
    // describe that same eventual file even when the named write happened last.
    backend.mutate.setAttribute(relationship, 'RelatedObjects', `#${originalChild.ref.expressId}`);
    expect(backend.query.related(parent.ref, 'IfcRelAggregates', 'forward'))
      .not.toContainEqual(originalChild.ref);
    expect(backend.query.related(parent.ref, 'IfcRelAggregates', 'forward'))
      .toContainEqual(replacementChild.ref);
  });

  it('keeps legacy relationship projections in sync with overlay deletes and creates', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const [host, target] = backend.query.entities({ types: ['IfcWall'] });
    expect(host).toBeDefined();
    expect(target).toBeDefined();

    const relationship = backend.store.addEntity('default', {
      type: 'IfcRelVoidsElement',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzz'", null, null, null, `#${host.ref.expressId}`, `#${target.ref.expressId}`],
    });
    const duplicate = backend.store.addEntity('default', {
      type: 'IfcRelVoidsElement',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzy'", null, null, null, `#${host.ref.expressId}`, `#${target.ref.expressId}`],
    });
    expect(backend.query.relationships(host.ref).voids).toContainEqual(expect.objectContaining({
      id: target.ref.expressId,
      type: 'IfcWall',
    }));
    expect(backend.query.relationships(host.ref).voids).toHaveLength(1);
    expect(backend.query.relationships(host.ref).relations?.filter(
      edge => edge.relationshipType === 'IfcRelVoidsElement' && edge.entity.id === target.ref.expressId,
    )).toHaveLength(2);

    backend.store.removeEntity(relationship);
    expect(backend.query.relationships(host.ref).voids).toHaveLength(1);
    backend.store.removeEntity(duplicate);
    expect(backend.query.relationships(host.ref).voids).toEqual([]);

    backend.store.removeEntity(host.ref);
    expect(backend.query.relationships(host.ref)).toEqual({
      voids: [], fills: [], groups: [], connections: [], relations: [],
    });
  });

  it('keeps factor-weighted assignments in the legacy groups projection', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const [member, group] = backend.query.entities({ types: ['IfcWall'] });
    backend.store.addEntity('default', {
      type: 'IfcRelAssignsToGroupByFactor',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzy'", null, null, null,
        [`#${member.ref.expressId}`], null, `#${group.ref.expressId}`, 0.5],
    });

    expect(backend.query.relationships(member.ref).groups).toContainEqual({
      id: group.ref.expressId,
      name: group.name,
    });
  });

  it('hydrates positional metadata edits on a created relationship endpoint', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const [member] = backend.query.entities({ types: ['IfcWall'] });
    const group = backend.store.addEntity('default', {
      type: 'IfcGroup',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzx'", null, "'Initial group'", null, null],
    });
    backend.store.addEntity('default', {
      type: 'IfcRelAssignsToGroup',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzw'", null, null, null,
        [`#${member.ref.expressId}`], null, `#${group.expressId}`],
    });
    backend.store.setPositionalAttribute(group, 2, "'Renamed group'");

    expect(backend.query.relationships(member.ref).groups).toContainEqual({
      id: group.expressId,
      name: 'Renamed group',
    });
  });
});
