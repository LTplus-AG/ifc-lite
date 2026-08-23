/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provenance across a snapshot round trip.
 *
 * The rule these tests pin is "absent beats invented": a field the wire
 * does not carry must come back MISSING, never filled in from the
 * snapshot's own header or from the read clock. A missing `createdBy`
 * renders as "unknown"; a fabricated one is indistinguishable from real
 * attribution and is therefore trusted.
 *
 * Both directions matter, so the genuine-data cases are pinned here too:
 * a freshly authored entity still gets a real `createdAt`, and an
 * `ifcClass` set through the doc API still reaches the wire.
 */

import { describe, expect, it } from 'vitest';
import { ATTR } from '@ifc-lite/ifcx';
import { createCollabDoc } from '../src/doc/schema.js';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import { createEntity, entityToJSON, getEntity } from '../src/doc/entity.js';
import { PROVENANCE_META_KEYS } from '../src/snapshot/structured-attrs.js';
import { seedFromIfcx } from '../src/snapshot/from-ifcx.js';
import { snapshotToIfcx } from '../src/snapshot/to-ifcx.js';

function metaOf(doc: ReturnType<typeof createCollabDoc>, path: string): Record<string, unknown> {
  const entity = getEntity(doc, path);
  if (!entity) throw new Error(`entity ${path} missing`);
  return entityToJSON(entity).meta;
}

describe('snapshot round trip: provenance', () => {
  it('does not name the snapshot author as the creator of an entity it did not create', () => {
    const source = createCollabDoc();
    source.transact(() => {
      createEntity(source, 'wall', {
        ifcClass: 'IfcWall',
        meta: { createdBy: 'ada', createdAt: '2019-05-05T00:00:00.000Z' },
      });
    });

    const file = snapshotToIfcx(source, {
      author: 'snapshotter',
      timestamp: '2026-08-22T13:45:43.000Z',
    });

    const restored = createCollabDoc();
    seedFromIfcx(restored, file);
    const meta = metaOf(restored, 'wall');

    // The snapshot author authored the FILE, not the wall.
    expect(meta.createdBy).not.toBe('snapshotter');
    // The snapshot timestamp is when the file was written, not when the
    // wall was created.
    expect(meta.createdAt).not.toBe('2026-08-22T13:45:43.000Z');
  });

  it('carries real per-entity provenance across the round trip', () => {
    const source = createCollabDoc();
    source.transact(() => {
      createEntity(source, 'wall', {
        ifcClass: 'IfcWall',
        meta: {
          createdBy: 'ada',
          createdAt: '2019-05-05T00:00:00.000Z',
          lastEditedBy: 'grace',
          lastEditedAt: '2020-06-06T00:00:00.000Z',
          previousPath: 'old-wall',
        },
      });
    });

    const file = snapshotToIfcx(source, { author: 'snapshotter' });
    const restored = createCollabDoc();
    seedFromIfcx(restored, file);

    expect(metaOf(restored, 'wall')).toMatchObject({
      createdBy: 'ada',
      createdAt: '2019-05-05T00:00:00.000Z',
      lastEditedBy: 'grace',
      lastEditedAt: '2020-06-06T00:00:00.000Z',
      previousPath: 'old-wall',
    });
  });

  it('folds provenance out of the flat attributes branch, both ways', () => {
    const source = createCollabDoc();
    source.transact(() =>
      createEntity(source, 'wall', { ifcClass: 'IfcWall', meta: { createdBy: 'ada' } }),
    );

    const file = snapshotToIfcx(source);
    const wall = file.data.find((n) => n.path === 'wall');
    // The wire keys are exactly the carrier's, no more.
    expect(Object.keys(wall?.attributes?.[IFCLITE_ATTR.META] as object)).toEqual([
      'createdBy',
      'createdAt',
    ]);

    const restored = createCollabDoc();
    seedFromIfcx(restored, file);
    // ...and it does not linger as a user-visible flat attribute.
    expect(
      Object.keys(entityToJSON(getEntity(restored, 'wall')!).attributes),
    ).not.toContain(IFCLITE_ATTR.META);
  });

  it('emits no carrier at all for an entity that knows nothing about its origin', () => {
    const source = createCollabDoc();
    source.transact(() =>
      createEntity(source, 'wall', { ifcClass: 'IfcWall', stampCreatedAt: false }),
    );
    const wall = snapshotToIfcx(source).data.find((n) => n.path === 'wall');
    expect(wall?.attributes?.[IFCLITE_ATTR.META]).toBeUndefined();
  });

  it('does not read a foreign value under the provenance key as provenance', () => {
    const source = createCollabDoc();
    source.transact(() => createEntity(source, 'wall', { ifcClass: 'IfcWall' }));
    const file = snapshotToIfcx(source);
    const wall = file.data.find((n) => n.path === 'wall')!;
    wall.attributes = { ...wall.attributes, [IFCLITE_ATTR.META]: 'not-an-object' };

    const restored = createCollabDoc();
    seedFromIfcx(restored, file);
    const json = entityToJSON(getEntity(restored, 'wall')!);
    // Unrecognized shape stays flat; it never becomes doc provenance.
    expect(json.attributes[IFCLITE_ATTR.META]).toBe('not-an-object');
    expect(json.meta.createdBy).toBeUndefined();
  });

  it('never writes a meta key with nothing behind it', () => {
    // `seedFromIfcx` passes `ifcClass: undefined` for a node with no
    // class attribute. Storing that would make `'ifcClass' in meta` and
    // `meta.has('ifcClass')` true for a key holding nothing — which is
    // what `privacy.ts`'s redaction and every `has`-guarded reader take
    // as "present".
    const source = createCollabDoc();
    source.transact(() => createEntity(source, 'thing'));
    const restored = createCollabDoc();
    seedFromIfcx(restored, snapshotToIfcx(source));

    const meta = metaOf(restored, 'thing');
    expect('ifcClass' in meta).toBe(false);
    expect('createdBy' in meta).toBe(false);
    // `createdAt` is genuinely known here — the source entity was created
    // in this process — so it rides the carrier and must come back.
    expect(typeof meta.createdAt).toBe('string');
  });

  it('ignores a provenance field the wire spells with the wrong type', () => {
    const source = createCollabDoc();
    source.transact(() => createEntity(source, 'wall', { ifcClass: 'IfcWall' }));
    const file = snapshotToIfcx(source);
    const wall = file.data.find((n) => n.path === 'wall')!;
    wall.attributes = {
      ...wall.attributes,
      // A number where a principal name belongs, and a nested object
      // where a timestamp belongs. Neither is provenance; storing them
      // would put a shape in the doc that no reader expects.
      [IFCLITE_ATTR.META]: { createdBy: 42, createdAt: { when: 'later' }, previousPath: 'old' },
    };

    const restored = createCollabDoc();
    seedFromIfcx(restored, file);
    const meta = metaOf(restored, 'wall');
    expect('createdBy' in meta).toBe(false);
    expect('createdAt' in meta).toBe(false);
    // The well-typed sibling still lands — one bad field is not a reason
    // to drop the rest.
    expect(meta.previousPath).toBe('old');
  });

  it('the carrier key set is closed — adding one is a deliberate wire change', () => {
    expect([...PROVENANCE_META_KEYS]).toEqual([
      'createdBy',
      'createdAt',
      'lastEditedBy',
      'lastEditedAt',
      'previousPath',
    ]);
    // `ifcClass` has its own wire key and `schemaVersion` is re-derived —
    // two writers for one fact is how they drift.
    expect(PROVENANCE_META_KEYS as readonly string[]).not.toContain('ifcClass');
    expect(PROVENANCE_META_KEYS as readonly string[]).not.toContain('schemaVersion');
  });

  it('leaves createdBy / createdAt absent rather than inventing them when the wire is silent', () => {
    const source = createCollabDoc();
    source.transact(() => createEntity(source, 'wall', { ifcClass: 'IfcWall' }));
    const file = snapshotToIfcx(source, { author: 'snapshotter' });
    // Strip every attribute so the wire carries no provenance at all —
    // the shape a foreign IFCX file has.
    for (const node of file.data) delete node.attributes;

    const restored = createCollabDoc();
    seedFromIfcx(restored, file);
    const meta = metaOf(restored, 'wall');

    // `in`, not `=== undefined`: a key set to `undefined` still reports
    // as present to `has`-guarded readers, which is the state this whole
    // change is about avoiding.
    expect('createdBy' in meta).toBe(false);
    expect('createdAt' in meta).toBe(false);
  });

  it('an ifcClass set through the doc API survives the round trip', () => {
    const source = createCollabDoc();
    source.transact(() => createEntity(source, 'wall', { ifcClass: 'IfcWall' }));

    const file = snapshotToIfcx(source);
    const wall = file.data.find((n) => n.path === 'wall');
    expect(wall?.attributes?.[ATTR.CLASS]).toEqual({ code: 'IfcWall' });

    const restored = createCollabDoc();
    seedFromIfcx(restored, file);
    expect(metaOf(restored, 'wall').ifcClass).toBe('IfcWall');
  });

  it('still stamps a real createdAt on a freshly authored entity', () => {
    const doc = createCollabDoc();
    const before = Date.now();
    doc.transact(() => createEntity(doc, 'wall', { ifcClass: 'IfcWall' }));
    const stamp = metaOf(doc, 'wall').createdAt;

    expect(typeof stamp).toBe('string');
    expect(Date.parse(stamp as string)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('a caller-supplied ifcClass attribute is not overwritten by the ifcClass option', () => {
    const doc = createCollabDoc();
    doc.transact(() => {
      createEntity(doc, 'wall', {
        ifcClass: 'IfcWall',
        attributes: { [ATTR.CLASS]: { code: 'IfcWall', uri: 'https://example.invalid/wall' } },
      });
    });
    expect(entityToJSON(getEntity(doc, 'wall')!).attributes[ATTR.CLASS]).toEqual({
      code: 'IfcWall',
      uri: 'https://example.invalid/wall',
    });
  });
});
