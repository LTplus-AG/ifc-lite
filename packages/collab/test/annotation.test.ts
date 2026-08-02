/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity } from '../src/doc/entity.js';
import { snapshotToIfcx } from '../src/snapshot/to-ifcx.js';
import {
  annotationsMap,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  getAnnotation,
  iterAnnotations,
  type AnnotationFields,
} from '../src/doc/annotation.js';

const FIELDS: AnnotationFields = {
  position: { x: 1, y: 2, z: 3 },
  note: 'check this beam',
  entityPath: '/0aBcD',
  authorId: 'user-1',
  authorName: 'Anna',
  authorColor: '#5b8def',
  createdAt: 1000,
  updatedAt: 1000,
};

describe('annotations collection', () => {
  it('createCollabDoc initializes the annotations map empty', () => {
    const doc = createCollabDoc();
    expect(annotationsMap(doc).size).toBe(0);
  });

  it('create / get / update / delete round-trip', () => {
    const doc = createCollabDoc();
    createAnnotation(doc, 'a1', FIELDS);

    const got = getAnnotation(doc, 'a1');
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      id: 'a1',
      position: { x: 1, y: 2, z: 3 },
      note: 'check this beam',
      entityPath: '/0aBcD',
      authorName: 'Anna',
      authorColor: '#5b8def',
    });

    expect(updateAnnotation(doc, 'a1', { note: 'edited', updatedAt: 2000 })).toBe(true);
    expect(getAnnotation(doc, 'a1')?.note).toBe('edited');
    expect(getAnnotation(doc, 'a1')?.updatedAt).toBe(2000);

    expect(Array.from(iterAnnotations(doc)).map((a) => a.id)).toEqual(['a1']);

    expect(deleteAnnotation(doc, 'a1')).toBe(true);
    expect(getAnnotation(doc, 'a1')).toBeNull();
    expect(deleteAnnotation(doc, 'a1')).toBe(false);
  });

  it('is excluded from the IFCX snapshot (markup is not BIM)', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wall-1', { attributes: { 'bsi::ifc::class': { code: 'IfcWall' } } });
    createAnnotation(doc, 'a1', FIELDS);

    const ifcx = snapshotToIfcx(doc);
    const paths = (ifcx.data ?? []).map((n) => n.path);
    expect(paths).toContain('/wall-1');
    // The annotation id must NOT leak into the IFCX data graph.
    expect(paths).not.toContain('a1');
    expect(JSON.stringify(ifcx)).not.toContain('check this beam');
  });

  it('syncs across two docs over a Yjs update', async () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    const Y = await import('yjs');
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));

    createAnnotation(a, 'a1', FIELDS);
    expect(getAnnotation(b, 'a1')?.note).toBe('check this beam');
  });
});
