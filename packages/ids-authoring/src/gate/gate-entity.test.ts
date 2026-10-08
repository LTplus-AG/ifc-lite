/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'vitest';
import { addFacet, eq, ids, specDoc } from '../../test/gate-helpers.js';
import { checkOps } from './check.js';
import { createGateContext, type GateContext } from './context.js';
import { osaDistance, rankCandidates } from './rank.js';

let ctx: GateContext;
beforeAll(async () => {
  ctx = await createGateContext();
});

const codes = (r: ReturnType<typeof checkOps>) => r.issues.map((i) => i.code);

describe('GATE-ENT-001: entity exists in every version of the spec', () => {
  it.each([
    ['IFC2X3', 'IfcWall'],
    ['IFC4', 'IFCWALL'],
    ['IFC4X3_ADD2', 'ifcwall'],
    ['IFC4X3', 'IfcAlignment'],
    ['IFC4', 'IfcBuildingStorey'],
  ] as const)('accepts %s %s (any case on input)', (v, name) => {
    const { doc, specId } = specDoc([v]);
    expect(checkOps([addFacet(specId, { type: 'entity', name: eq(name) }, 'applicability')], doc, ctx).issues).toEqual([]);
  });

  // Literal entity names are stored upper-case (as in IDS XML), so `value` echoes that form.
  it('rejects an entity missing from one of the spec versions and names the version', () => {
    // IfcAlignment exists in IFC4X3 but not in IFC2X3.
    const { doc, specId } = specDoc(['IFC2X3', 'IFC4X3_ADD2']);
    const r = checkOps([addFacet(specId, { type: 'entity', name: eq('IfcAlignment') }, 'applicability')], doc, ctx);
    expect(codes(r)).toEqual(['GATE-ENT-001']);
    expect(r.issues[0]).toMatchObject({ versions: ['IFC2X3'], value: 'IFCALIGNMENT', path: 'ops[0].payload.facet.name', field: 'entity.name' });
    expect(r.ok).toBe(false);
  });

  it('rejects a hallucinated entity with ranked candidates', () => {
    const { doc, specId } = specDoc(['IFC4']);
    const r = checkOps([addFacet(specId, { type: 'entity', name: eq('IfcWal') }, 'applicability')], doc, ctx);
    expect(r.issues[0].code).toBe('GATE-ENT-001');
    expect(r.issues[0].candidates[0].value).toBe('IfcWall');
  });

  it('rejects EXPRESS defined types used as entities', () => {
    const { doc, specId } = specDoc(['IFC4']);
    expect(codes(checkOps([addFacet(specId, { type: 'entity', name: eq('IfcLabel') }, 'applicability')], doc, ctx))).toEqual(['GATE-ENT-001']);
  });

  it('checks every enumeration value and never blocks patterns', () => {
    const { doc, specId } = specDoc(['IFC4']);
    const r = checkOps(
      [
        addFacet(specId, { type: 'entity', name: { kind: 'oneOf', values: ['IfcWall', 'IfcWindoww'] } }, 'applicability'),
        addFacet(specId, { type: 'entity', name: { kind: 'pattern', pattern: 'IFCWALL.*' } }, 'applicability'),
      ],
      doc,
      ctx,
    );
    expect(r.issues.map((i) => [i.code, i.value])).toEqual([['GATE-ENT-001', 'IFCWINDOWW']]);
    expect(r.issues[0].candidates[0].value).toBe('IfcWindow');
  });

  it('re-grounds every facet when the spec versions change', () => {
    const { doc, specId } = specDoc(['IFC4X3_ADD2'], 'IfcAlignment');
    const r = checkOps([{ kind: 'spec.setIfcVersions', opId: ids(), payload: { specId, versions: ['IFC4X3_ADD2', 'IFC2X3'] } }], doc, ctx);
    expect(r.issues.map((i) => [i.code, i.value, i.versions])).toEqual([['GATE-ENT-001', 'IFCALIGNMENT', ['IFC2X3']]]);
  });

  it('grounds partOf related entities too', () => {
    const { doc, specId } = specDoc(['IFC4'], 'IfcWall');
    const r = checkOps([addFacet(specId, { type: 'partOf', relation: 'IfcRelContainedInSpatialStructure', entity: { name: eq('IfcBuildingStory') } })], doc, ctx);
    expect(r.issues[0]).toMatchObject({ code: 'GATE-ENT-001', field: 'partOf.entity.name' });
    expect(r.issues[0].candidates[0].value).toBe('IfcBuildingStorey');
  });
});

describe('GATE-PDT-001: predefined type is a member of the entity enumeration', () => {
  it('accepts members (case-insensitive) and USERDEFINED / NOTDEFINED', () => {
    const { doc, specId } = specDoc(['IFC4']);
    for (const pdt of ['SOLIDWALL', 'shear', 'USERDEFINED', 'NOTDEFINED']) {
      const r = checkOps([addFacet(specId, { type: 'entity', name: eq('IfcWall'), predefinedType: eq(pdt) }, 'applicability')], doc, ctx);
      expect(r.issues, pdt).toEqual([]);
    }
  });

  it('rejects a non-member with the enumeration as candidates', () => {
    const { doc, specId } = specDoc(['IFC4']);
    const r = checkOps([addFacet(specId, { type: 'entity', name: eq('IfcWall'), predefinedType: eq('SOLIDWAL') }, 'applicability')], doc, ctx);
    expect(codes(r)).toEqual(['GATE-PDT-001']);
    expect(r.issues[0].candidates[0].value).toBe('SOLIDWALL');
  });

  it('re-checks the predefined type when the entity name changes', () => {
    const { doc, specId } = specDoc(['IFC4']);
    const facetId = ids();
    const built = checkOps([{ kind: 'facet.add', opId: ids(), payload: { specId, section: 'applicability', facetId, facet: { type: 'entity', name: eq('IfcWall'), predefinedType: eq('SHEAR') } } }], doc, ctx);
    expect(built.ok).toBe(true);
    const r = checkOps(
      [
        { kind: 'facet.add', opId: ids(), payload: { specId, section: 'applicability', facetId, facet: { type: 'entity', name: eq('IfcWall'), predefinedType: eq('SHEAR') } } },
        { kind: 'facet.setField', opId: ids(), payload: { facetId, field: 'entity.name', value: eq('IfcDoor') } },
      ],
      doc,
      ctx,
    );
    expect(r.issues.map((i) => [i.opIndex, i.code, i.field])).toEqual([[1, 'GATE-PDT-001', 'entity.predefinedType']]);
  });
});

describe('GATE-ATT-001: attribute exists on the entity, inherited attributes included', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3_ADD2'] as const)('%s: accepts own and inherited, rejects unknown', (v) => {
    const { doc, specId } = specDoc([v], 'IfcWall');
    const ok = checkOps(
      [addFacet(specId, { type: 'attribute', name: eq('Name') }), addFacet(specId, { type: 'attribute', name: eq('GlobalId') }), addFacet(specId, { type: 'attribute', name: eq('tag') })],
      doc,
      ctx,
    );
    expect(ok.issues).toEqual([]);
    const bad = checkOps([addFacet(specId, { type: 'attribute', name: eq('FireRating') })], doc, ctx);
    expect(codes(bad)).toEqual(['GATE-ATT-001']);
    expect(bad.issues[0].message).toContain('on IfcWall');
  });

  it('without a literal applicability entity, checks against all attributes of the version', () => {
    const { doc, specId } = specDoc(['IFC4']);
    expect(checkOps([addFacet(specId, { type: 'attribute', name: eq('LongName') })], doc, ctx).ok).toBe(true);
    const r = checkOps([addFacet(specId, { type: 'attribute', name: eq('LongNmae') })], doc, ctx);
    expect(codes(r)).toEqual(['GATE-ATT-001']);
    expect(r.issues[0].candidates[0].value).toBe('LongName');
  });
});

describe('candidate ranking', () => {
  it('computes optimal-string-alignment distance', () => {
    expect(osaDistance('FireRating', 'FireRating')).toBe(0);
    expect(osaDistance('FireRaitng', 'FireRating')).toBe(1); // transposition
    expect(osaDistance('Fire', 'FireRating')).toBe(6);
  });

  it('ranks typos, missing prefixes and reordered tokens first', () => {
    const pool = ['Pset_WallCommon', 'Pset_DoorCommon', 'Pset_SlabCommon', 'Qto_WallBaseQuantities'];
    expect(rankCandidates('Pset_WalCommon', pool)[0].value).toBe('Pset_WallCommon');
    expect(rankCandidates('WallCommon', pool)[0].value).toBe('Pset_WallCommon');
    expect(rankCandidates('CommonWall', pool)[0].value).toBe('Pset_WallCommon');
  });

  it('applies the caller boost and reports its reason', () => {
    const r = rankCandidates('Pset_Common', ['Pset_WallCommon', 'Pset_DoorCommon'], {
      boost: (c) => (c === 'Pset_DoorCommon' ? { boost: 0.25, reason: 'applicable to IfcDoor' } : undefined),
    });
    expect(r[0]).toMatchObject({ value: 'Pset_DoorCommon', reason: 'applicable to IfcDoor' });
  });
});
