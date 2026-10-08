/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'vitest';
import { addFacet, eq, ids, prop, specDoc } from '../../test/gate-helpers.js';
import { apply } from '../reducer/apply.js';
import { checkOps } from './check.js';
import { createGateContext, type GateContext } from './context.js';

let ctx: GateContext;
beforeAll(async () => {
  ctx = await createGateContext();
});

const summary = (r: ReturnType<typeof checkOps>) => r.issues.map((i) => [i.code, i.value]);

describe('GATE-PSET-001: reserved-prefix sets must be standard in every version', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3_ADD2'] as const)('%s accepts Pset_WallCommon.FireRating', (v) => {
    const { doc, specId } = specDoc([v], 'IfcWall');
    expect(checkOps([addFacet(specId, prop('Pset_WallCommon', 'FireRating'))], doc, ctx).issues).toEqual([]);
  });

  it('rejects an invented Pset_ with candidates boosted by applicability', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcDoor');
    const r = checkOps([addFacet(specId, prop('Pset_DoorCommons', 'FireRating'))], doc, ctx);
    expect(summary(r)).toEqual([['GATE-PSET-001', 'Pset_DoorCommons']]);
    expect(r.issues[0].candidates[0]).toMatchObject({ value: 'Pset_DoorCommon', reason: 'applicable to IFCDOOR' });
  });

  it('Qto_: verified where the tables have quantity sets (IFC4X3), accepted where they do not', () => {
    const v43 = specDoc(['IFC4X3_ADD2'], 'IfcWall');
    expect(checkOps([addFacet(v43.specId, prop('Qto_WallBaseQuantities', 'NetVolume'))], v43.doc, ctx).ok).toBe(true);
    expect(summary(checkOps([addFacet(v43.specId, prop('Qto_WallBaseQuantity', 'NetVolume'))], v43.doc, ctx))).toEqual([
      ['GATE-PSET-001', 'Qto_WallBaseQuantity'],
    ]);
    expect(summary(checkOps([addFacet(v43.specId, prop('Qto_WallBaseQuantities', 'NetVolumen'))], v43.doc, ctx))).toEqual([
      ['GATE-PROP-001', 'NetVolumen'],
    ]);
    // IFC4 / IFC2X3 tables carry no Qto_ rows (IDS-009): the name cannot be verified, so it is not blocked.
    const v4 = specDoc(['IFC4', 'IFC2X3'], 'IfcWall');
    expect(checkOps([addFacet(v4.specId, prop('Qto_WallBaseQuantities', 'NetVolume'))], v4.doc, ctx).ok).toBe(true);
  });
});

describe('GATE-PROP-001: property belongs to the standard set', () => {
  it('rejects a typo and suggests the property and same-named properties elsewhere', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const r = checkOps([addFacet(specId, prop('Pset_WallCommon', 'FireRatng'))], doc, ctx);
    expect(summary(r)).toEqual([['GATE-PROP-001', 'FireRatng']]);
    expect(r.issues[0].candidates[0].value).toBe('FireRating');
    const elsewhere = checkOps([addFacet(specId, prop('Pset_WallCommon', 'HandicapAccessible'))], doc, ctx);
    expect(elsewhere.issues[0].candidates.some((c) => c.value.endsWith('.HandicapAccessible') && c.reason?.includes('defined in'))).toBe(true);
  });

  it('IFC2X3 specifics: Pset_WallCommon.Status exists in IFC4 but not in IFC2X3', () => {
    const { doc, specId } = specDoc(['IFC2X3', 'IFC4'], 'IfcWall');
    const r = checkOps([addFacet(specId, prop('Pset_WallCommon', 'Status'))], doc, ctx);
    expect(r.issues.map((i) => [i.code, i.versions])).toEqual([['GATE-PROP-001', ['IFC2X3']]]);
  });

  it('re-checks the property name when the property set changes', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const facetId = ids();
    const built = apply(doc, [{ kind: 'facet.add', opId: ids(), payload: { specId, section: 'requirements', facetId, facet: prop('Pset_WallCommon', 'IsExternal') } }]).doc;
    const r = checkOps([{ kind: 'facet.setField', opId: ids(), payload: { facetId, field: 'property.propertySet', value: eq('Pset_SpaceCommon') } }], built, ctx);
    expect(r.ok).toBe(true); // IsExternal exists in Pset_SpaceCommon too
    const bad = checkOps([{ kind: 'facet.setField', opId: ids(), payload: { facetId, field: 'property.propertySet', value: eq('Pset_BuildingStoreyCommon') } }], built, ctx);
    expect(summary(bad)).toEqual([['GATE-PROP-001', 'IsExternal']]);
  });
});

describe('GATE-ENUM-001: enumeration values of standard enumerated properties', () => {
  it('accepts members and rejects others, suggesting a case-folded match first', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    expect(checkOps([addFacet(specId, prop('Pset_WallCommon', 'Status', { value: { kind: 'oneOf', values: ['NEW', 'EXISTING'] } }))], doc, ctx).ok).toBe(true);
    const r = checkOps([addFacet(specId, prop('Pset_WallCommon', 'Status', { value: eq('existing') }))], doc, ctx);
    expect(summary(r)).toEqual([['GATE-ENUM-001', 'existing']]);
    expect(r.issues[0].candidates[0]).toEqual({ value: 'EXISTING', score: 1, reason: 'same value, different case' });
    expect(summary(checkOps([addFacet(specId, prop('Pset_WallCommon', 'Status', { value: eq('REFURBISHED') }))], doc, ctx))).toEqual([
      ['GATE-ENUM-001', 'REFURBISHED'],
    ]);
  });

  it('does not constrain values of non-enumerated properties', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    expect(checkOps([addFacet(specId, prop('Pset_WallCommon', 'FireRating', { value: eq('anything') }))], doc, ctx).ok).toBe(true);
  });
});

describe('GATE-DT-001: data types', () => {
  it('accepts the standard type in any case', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    for (const dt of ['IFCLABEL', 'IfcLabel']) {
      expect(checkOps([addFacet(specId, prop('Pset_WallCommon', 'FireRating', { dataType: eq(dt) }))], doc, ctx).issues, dt).toEqual([]);
    }
    // Enumerated properties serialise as IfcLabel.
    expect(checkOps([addFacet(specId, prop('Pset_WallCommon', 'Status', { dataType: eq('IFCLABEL') }))], doc, ctx).ok).toBe(true);
  });

  it('rejects unknown types and types inconsistent with the standard property', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const unknown = checkOps([addFacet(specId, prop('Pset_WallCommon', 'FireRating', { dataType: eq('IFCLABLE') }))], doc, ctx);
    expect(summary(unknown)).toEqual([['GATE-DT-001', 'IFCLABLE']]);
    expect(unknown.issues[0].candidates[0].value).toBe('IFCLABEL');
    const wrong = checkOps([addFacet(specId, prop('Pset_WallCommon', 'IsExternal', { dataType: eq('IFCLABEL') }))], doc, ctx);
    expect(summary(wrong)).toEqual([['GATE-DT-001', 'IFCLABEL']]);
    expect(wrong.issues[0].candidates).toEqual([{ value: 'IFCBOOLEAN', score: 1, reason: 'standard data type' }]);
  });

  it('accepts any known data type on custom properties', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const r = checkOps(
      [
        { kind: 'meta.custom.declarePset', opId: ids(), payload: { decl: { name: 'Acme_Wall' } } },
        addFacet(specId, prop('Acme_Wall', 'Code', { dataType: eq('IFCIDENTIFIER') })),
      ],
      doc,
      ctx,
    );
    expect(r.issues).toEqual([]);
  });
});
