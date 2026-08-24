/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `applyIfcxOverlay` is the layer-application counterpart to
 * `seedFromIfcx`: it writes a file's opinions *onto* a doc that may
 * already hold the paths involved.
 *
 * The contract pinned here is the one the rest of the layer machinery
 * (`@ifc-lite/ifcx` composition, `bakeLayers`, the MCP layer store's
 * `seedDraftDoc`) already implements: values overwrite, `null` removes a
 * flat attribute / child / inherit, `ifclite::deleted: true` deletes, and
 * everything the file says nothing about is left exactly as it was.
 *
 * Structured removals (a pset or quantity property nulled as a flattened
 * `bsi::ifc::v5a::<Set>::<Prop>` key) are NOT applied — see the note on
 * `applyIfcxOverlay`. Nothing here should be read as covering them.
 *
 * `seedFromIfcx` deliberately keeps its own, different contract — it is
 * additive and idempotent, because `apps/viewer` and `snapshot/worker.ts`
 * seed live session docs with it. Those cases are pinned in
 * `from-ifcx-reset.test.ts`; nothing here may leak into them.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IFCLITE_ATTR, type IfcxFile } from '@ifc-lite/ifcx';
import { createCollabDoc, entitiesMap, ENTITY_KEY } from '../src/doc/schema.js';
import {
  addClassification,
  addMaterial,
  createEntity,
  getAttribute,
  getEntity,
  setAttribute,
} from '../src/doc/entity.js';
import { applyIfcxOverlay, seedFromIfcx } from '../src/snapshot/from-ifcx.js';

function layer(data: IfcxFile['data']): IfcxFile {
  return {
    header: {
      id: 'apply-overlay-fixture',
      ifcxVersion: 'IFCX-1.0',
      dataVersion: '1.0',
      author: 'test',
      timestamp: '2020-01-01T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data,
  };
}

describe('applyIfcxOverlay', () => {
  it('creates entities the doc does not have', () => {
    const doc = createCollabDoc();
    applyIfcxOverlay(doc, layer([{ path: 'wall', attributes: { 'ifclite::name': 'Wall A' } }]));
    expect(getAttribute(doc, 'wall', 'ifclite::name')).toBe('Wall A');
  });

  it('overwrites values on an entity the doc already has, and leaves the rest alone', () => {
    const doc = createCollabDoc();
    doc.transact(() => {
      createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
      setAttribute(doc, 'wall', 'ifclite::name', 'Wall A');
      setAttribute(doc, 'wall', 'ifclite::tag', 'keep-me');
    });

    applyIfcxOverlay(doc, layer([{ path: 'wall', attributes: { 'ifclite::name': 'Wall B' } }]));

    expect(getAttribute(doc, 'wall', 'ifclite::name')).toBe('Wall B');
    expect(getAttribute(doc, 'wall', 'ifclite::tag')).toBe('keep-me');
  });

  it('treats a null attribute value as a removal opinion', () => {
    const doc = createCollabDoc();
    doc.transact(() => {
      createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
      setAttribute(doc, 'wall', 'ifclite::name', 'Wall A');
    });

    applyIfcxOverlay(doc, layer([{ path: 'wall', attributes: { 'ifclite::name': null } }]));

    const attrs = getEntity(doc, 'wall')?.get(ENTITY_KEY.ATTRIBUTES) as Y.Map<unknown> | undefined;
    expect(attrs?.has('ifclite::name')).toBe(false);
  });

  // `extractMinimalLayer` expresses a deletion as this tombstone node.
  // `seedFromIfcx` cannot act on it — `createEntity` no-ops on the path
  // that already exists, so the delete is dropped and the marker is not
  // even stored. The overlay applier is the reader that must honour it.
  it('deletes an entity carrying an ifclite::deleted tombstone', () => {
    const doc = createCollabDoc({ gc: false });
    doc.transact(() => {
      createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
      createEntity(doc, 'door', { ifcClass: 'IfcDoor' });
    });

    applyIfcxOverlay(doc, layer([{ path: 'door', attributes: { [IFCLITE_ATTR.DELETED]: true } }]));

    expect(entitiesMap(doc).has('door')).toBe(false);
    expect(entitiesMap(doc).has('wall')).toBe(true);
  });

  it('never stores the tombstone marker as an ordinary attribute', () => {
    const doc = createCollabDoc({ gc: false });
    doc.transact(() => createEntity(doc, 'wall', { ifcClass: 'IfcWall' }));

    // `false` is the revert opinion: it must resurrect nothing and, more
    // to the point here, must not leave bookkeeping in the doc.
    applyIfcxOverlay(
      doc,
      layer([
        {
          path: 'wall',
          attributes: { [IFCLITE_ATTR.DELETED]: false, 'ifclite::name': 'Wall A' },
        },
      ]),
    );

    expect(entitiesMap(doc).has('wall')).toBe(true);
    expect(getAttribute(doc, 'wall', 'ifclite::name')).toBe('Wall A');
    const attrs = getEntity(doc, 'wall')?.get(ENTITY_KEY.ATTRIBUTES) as Y.Map<unknown> | undefined;
    expect(attrs?.has(IFCLITE_ATTR.DELETED)).toBe(false);
  });

  // Composition resolves the tombstone only after the whole file is
  // applied — the strongest (last) opinion wins — so deletion cannot run
  // per node. A file that deletes and then resurrects a path must leave
  // the doc's own state for that path intact: deleting inline and
  // recreating from the second node would silently drop everything the
  // resurrecting node does not itself re-state.
  it('resolves the last tombstone opinion in the file, not the first', () => {
    const doc = createCollabDoc({ gc: false });
    doc.transact(() => {
      createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
      setAttribute(doc, 'wall', 'ifclite::tag', 'from-base');
    });

    applyIfcxOverlay(
      doc,
      layer([
        { path: 'wall', attributes: { [IFCLITE_ATTR.DELETED]: true } },
        { path: 'wall', attributes: { [IFCLITE_ATTR.DELETED]: false, 'ifclite::name': 'back' } },
      ]),
    );

    expect(entitiesMap(doc).has('wall')).toBe(true);
    expect(getAttribute(doc, 'wall', 'ifclite::name')).toBe('back');
    // Base state the resurrecting node never mentions must still be there.
    expect(getAttribute(doc, 'wall', 'ifclite::tag')).toBe('from-base');
  });

  // Classifications, materials and geometry refs are "single-valued
  // opinions" per the comment in `overlayEntity`: a node that carries a
  // list replaces the doc's list wholesale, and a node that carries none
  // must say nothing, not clear it. Nothing exercised the "says nothing"
  // half before this.
  it('leaves classifications and materials untouched when the overlay node carries none', () => {
    const doc = createCollabDoc();
    doc.transact(() => {
      createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
      addClassification(doc, 'wall', { system: 'Uniclass', code: 'Pr_20_93_88' });
      addMaterial(doc, 'wall', { materialId: 'concrete' });
    });

    // A node that only touches an unrelated attribute — no classification
    // or material opinion at all.
    applyIfcxOverlay(doc, layer([{ path: 'wall', attributes: { 'ifclite::name': 'Wall B' } }]));

    const classifications = getEntity(doc, 'wall')?.get(ENTITY_KEY.CLASSIFICATIONS) as
      | Y.Array<unknown>
      | undefined;
    const materials = getEntity(doc, 'wall')?.get(ENTITY_KEY.MATERIALS) as
      | Y.Array<unknown>
      | undefined;
    expect(classifications?.toArray()).toEqual([{ system: 'Uniclass', code: 'Pr_20_93_88' }]);
    expect(materials?.toArray()).toEqual([{ materialId: 'concrete' }]);
  });

  // The overlay applier and the seeder share a node decoder, so the
  // decoder's new tombstone awareness must stay on the overlay side.
  // `seedFromIfcx` never interpreted `ifclite::deleted` and must go on
  // storing it verbatim — `apps/viewer` and `snapshot/worker.ts` seed
  // live session docs with it, and silently dropping an attribute there
  // would be a wider behaviour change than the merge fix this shares
  // code with.
  it('leaves seedFromIfcx unaffected: the seeder still stores the marker verbatim', () => {
    const doc = createCollabDoc({ gc: false });
    seedFromIfcx(doc, layer([{ path: 'ghost', attributes: { [IFCLITE_ATTR.DELETED]: true } }]));

    expect(entitiesMap(doc).has('ghost')).toBe(true);
    const attrs = getEntity(doc, 'ghost')?.get(ENTITY_KEY.ATTRIBUTES) as Y.Map<unknown> | undefined;
    expect(attrs?.get(IFCLITE_ATTR.DELETED)).toBe(true);
  });
});
