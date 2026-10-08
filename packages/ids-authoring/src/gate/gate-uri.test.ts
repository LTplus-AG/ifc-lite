/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The facet `@uri` (bSDD references): drafts, `facet.setUri`, and its structural gate rules (IDS-070). */

import { beforeAll, describe, expect, it } from 'vitest';
import { addFacet, eq, ids, specDoc } from '../../test/gate-helpers.js';
import type { StudioOp } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { checkOps } from './check.js';
import { createGateContext, type GateContext } from './context.js';

let ctx: GateContext;
beforeAll(async () => {
  ctx = await createGateContext();
});

const URI = 'https://identifier.example.org/uri/ifc-lite-test/demo/1.0/class/WAL';

describe('facet uri', () => {
  it('is accepted on classification, property and material requirements', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const ops: StudioOp[] = [
      addFacet(specId, { type: 'classification', system: eq('Demo'), uri: URI }),
      addFacet(specId, { type: 'material', value: eq('Concrete'), uri: 'urn:example:concrete' }),
      addFacet(specId, { type: 'property', propertySet: eq('Pset_WallCommon'), baseName: eq('IsExternal'), uri: 'https://example.org/prop/IsExternal' }),
    ];
    expect(checkOps(ops, doc, ctx)).toEqual({ ok: true, issues: [] });
  });

  it('GATE-STR-009: no uri in the applicability, also after a move there', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    expect(checkOps([addFacet(specId, { type: 'classification', uri: URI }, 'applicability')], doc, ctx).issues.map((i) => i.code)).toEqual(['GATE-STR-009']);
    const add = addFacet(specId, { type: 'classification', system: eq('Demo'), uri: URI });
    const facetId = add.kind === 'facet.add' ? add.payload.facetId : '';
    const after = apply(doc, [add]).doc;
    const move: StudioOp = { kind: 'facet.move', opId: ids(), payload: { facetId, toSection: 'applicability', toIndex: 0 } };
    expect(checkOps([move], after, ctx).issues.map((i) => i.code)).toEqual(['GATE-STR-009']);
  });

  it('GATE-VAL-009: the uri must be absolute', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    expect(checkOps([addFacet(specId, { type: 'classification', uri: 'class/WAL' })], doc, ctx).issues.map((i) => i.code)).toEqual(['GATE-VAL-009']);
    expect(checkOps([addFacet(specId, { type: 'classification', uri: 'https://x.org/a b' })], doc, ctx).issues.map((i) => i.code)).toEqual(['GATE-VAL-009']);
  });

  it('facet.setUri sets, replaces and removes the uri, and undo restores it', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const add = addFacet(specId, { type: 'classification', system: eq('Demo') });
    const facetId = add.kind === 'facet.add' ? add.payload.facetId : '';
    const base = apply(doc, [add]).doc;
    const set: StudioOp = { kind: 'facet.setUri', opId: ids(), payload: { facetId, uri: URI } };
    expect(checkOps([set], base, ctx).ok).toBe(true);
    const withUri = apply(base, [set]);
    expect(withUri.doc.ids.specifications[0].requirements[0].facet).toMatchObject({ uri: URI });
    expect(apply(withUri.doc, withUri.inverses).doc).toEqual(base);
    const cleared = apply(withUri.doc, [{ kind: 'facet.setUri', opId: ids(), payload: { facetId, uri: null } }]);
    expect('uri' in cleared.doc.ids.specifications[0].requirements[0].facet).toBe(false);
    expect(apply(cleared.doc, cleared.inverses).doc).toEqual(withUri.doc);
  });

  it('facet.setUri is refused on an entity facet', () => {
    const { doc } = specDoc(['IFC4'], 'IfcWall');
    const entityId = doc.nodes.specs[0].applicability[0].id;
    const r = checkOps([{ kind: 'facet.setUri', opId: ids(), payload: { facetId: entityId, uri: URI } }], doc, ctx);
    expect(r.issues.map((i) => i.code)).toEqual(['GATE-STR-002']);
  });
});
