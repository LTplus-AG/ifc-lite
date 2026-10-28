/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseCapability } from '../capability/parse.js';
import { attributeSelectorPath, targetMatchesAttribute } from './attribute-path.js';
import { findGoverningRule, parseCharter, type Charter } from './charter.js';
import { canonicalValueKey, resolveAttribute, type Opinion } from './resolve.js';

const FIRE = 'bsi::ifc::v5a::Pset_WallCommon::FireRating';
const EXTERNAL = 'bsi::ifc::v5a::Pset_WallCommon::IsExternal';
const ARCH = 'arch@studio.example';
const FIRE_A = 'fire@consult.example';
const FIRE_B = 'fire2@consult.example';

/** The example charter from 12-authority.md §12.3. */
const SPEC_CHARTER = {
  v: 1,
  basis: 'BEP rev C, responsibility matrix §4.2',
  roles: {
    architect: [ARCH],
    'fire-consultant': [FIRE_A, FIRE_B],
    'information-manager': ['im@client.example'],
  },
  rules: [
    { id: 'fire-rating-walls', selector: 'model.mutate:Pset_WallCommon.FireRating@IfcWall*', role: 'fire-consultant' },
    { id: 'fire-rating-doors', selector: 'model.mutate:Pset_DoorCommon.FireRating@IfcDoor*', role: 'fire-consultant' },
    { id: 'wall-geometry', selector: 'model.mutate:geometry@IfcWall*', role: 'architect' },
  ],
};

function charter(raw: unknown = SPEC_CHARTER): Charter {
  const result = parseCharter(raw);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '));
  return result.value;
}

function errorCodes(raw: unknown): string[] {
  const result = parseCharter(raw);
  return result.ok ? [] : result.errors.map((e) => e.code);
}

function target(raw: string) {
  const parsed = parseCapability(`model.mutate:${raw}`);
  if (!parsed.ok || !parsed.value.target) throw new Error(raw);
  return parsed.value.target;
}

const op = (layerId: string, principal: string | undefined, value: unknown): Opinion =>
  principal === undefined ? { layerId, value } : { layerId, principal, value };

describe('attributeSelectorPath', () => {
  it('maps IFCX attribute keys onto selector paths', () => {
    expect(attributeSelectorPath(FIRE)).toEqual(['Pset_WallCommon', 'FireRating']);
    expect(attributeSelectorPath('bsi::ifc::prop::FireRating')).toEqual(['prop', 'FireRating']);
    expect(attributeSelectorPath('bsi::ifc::class')).toEqual(['attr', 'class']);
    expect(attributeSelectorPath('bsi::ifc::material')).toEqual(['material']);
    expect(attributeSelectorPath('usd::xformop')).toEqual(['placement']);
    expect(attributeSelectorPath('usd::usdgeom::mesh')).toEqual(['geometry', 'mesh']);
    expect(attributeSelectorPath('bsi::ifc::presentation::diffuseColor')).toBeUndefined();
    expect(attributeSelectorPath('vendor::thing')).toBeUndefined();
  });

  it('matches a target against a prefix of the path: a set covers its members', () => {
    expect(targetMatchesAttribute(target('Pset_WallCommon.FireRating'), FIRE)).toBe(true);
    expect(targetMatchesAttribute(target('Pset_WallCommon'), FIRE)).toBe(true);
    expect(targetMatchesAttribute(target('Pset_Wall*'), FIRE)).toBe(true);
    expect(targetMatchesAttribute(target('Pset_WallCommon.FireRating'), EXTERNAL)).toBe(false);
    expect(targetMatchesAttribute(target('geometry'), 'usd::usdgeom::mesh')).toBe(true);
    expect(targetMatchesAttribute(target('geometry.mesh'), 'usd::usdgeom::basiscurves')).toBe(false);
    expect(targetMatchesAttribute(target('*'), 'vendor::thing')).toBe(true);
    expect(targetMatchesAttribute(target('attr'), 'vendor::thing')).toBe(false);
  });
});

describe('parseCharter', () => {
  it('accepts the spec example', () => {
    const parsed = charter();
    expect(parsed.basis).toBe('BEP rev C, responsibility matrix §4.2');
    expect(parsed.rules.map((r) => r.id)).toEqual(['fire-rating-walls', 'fire-rating-doors', 'wall-geometry']);
    expect([...(parsed.roles.get('fire-consultant') ?? [])]).toEqual([FIRE_A, FIRE_B]);
  });

  it('rejects malformed charters with every error at once', () => {
    expect(errorCodes(null)).toEqual(['type_mismatch']);
    expect(errorCodes({ ...SPEC_CHARTER, v: 2 })).toEqual(['invalid_manifest_version']);
    expect(errorCodes({
      v: 1,
      roles: { architect: [ARCH], Bad: ['x'] },
      rules: [
        { id: 'a', selector: 'model.mutate:geometry', role: 'ghost' },
        { id: 'b', selector: 'model.read:geometry', role: 'architect' },
        { id: 'c', selector: 'model.mutate:geometry', role: 'architect' },
        { id: 'c', selector: 'model.mutate:material', role: 'architect' },
        { id: 'd', selector: 'model.mutate:geometry@wall', role: 'architect' },
      ],
    })).toEqual(['invalid_id', 'invalid_reference', 'invalid_capability', 'invalid_id', 'invalid_capability']);
  });

  it('rejects two equally specific overlapping rules with different roles', () => {
    const ambiguous = (a: string, b: string) => ({
      v: 1,
      roles: { architect: [ARCH], 'fire-consultant': [FIRE_A] },
      rules: [
        { id: 'one', selector: a, role: 'architect' },
        { id: 'two', selector: b, role: 'fire-consultant' },
      ],
    });
    expect(errorCodes(ambiguous('model.mutate:Pset_WallCommon@IfcWall', 'model.mutate:Pset_WallCommon@IfcWall'))).toEqual(['ambiguous_authority']);
    expect(errorCodes(ambiguous('model.mutate:Pset_Wall*@IfcWall*', 'model.mutate:Pset_*@IfcWallStandard*'))).toEqual(['ambiguous_authority']);
    // Disjoint types, disjoint members, conflicting constraints, or one rule more specific: fine.
    expect(errorCodes(ambiguous('model.mutate:Pset_WallCommon@IfcWall', 'model.mutate:Pset_WallCommon@IfcDoor'))).toEqual([]);
    expect(errorCodes(ambiguous('model.mutate:Pset_WallCommon.FireRating', 'model.mutate:Pset_WallCommon.IsExternal'))).toEqual([]);
    expect(errorCodes(ambiguous('model.mutate:geometry@IfcWall&storey=EG', 'model.mutate:geometry@IfcWall&storey=OG1'))).toEqual([]);
    expect(errorCodes(ambiguous('model.mutate:Pset_WallCommon@IfcWall', 'model.mutate:Pset_WallCommon.FireRating@IfcWall'))).toEqual([]);
    // Same role is never ambiguous.
    expect(errorCodes({
      v: 1,
      roles: { architect: [ARCH] },
      rules: [
        { id: 'one', selector: 'model.mutate:geometry@IfcWall', role: 'architect' },
        { id: 'two', selector: 'model.mutate:geometry@IfcWall', role: 'architect' },
      ],
    })).toEqual([]);
  });
});

describe('findGoverningRule', () => {
  const layered = charter({
    v: 1,
    roles: { architect: [ARCH], 'fire-consultant': [FIRE_A], 'structural-engineer': ['se@eng.example'] },
    rules: [
      { id: 'walls', selector: 'model.mutate:*@IfcWall*', role: 'architect' },
      { id: 'wall-pset', selector: 'model.mutate:Pset_WallCommon@IfcWall*', role: 'architect' },
      { id: 'wall-fire', selector: 'model.mutate:Pset_WallCommon.FireRating@IfcWall*', role: 'fire-consultant' },
      { id: 'core-fire', selector: 'model.mutate:Pset_WallCommon.FireRating@IfcWall', role: 'structural-engineer' },
      { id: 'eg-fire', selector: 'model.mutate:Pset_WallCommon.FireRating@IfcWall&storey=EG', role: 'fire-consultant' },
    ],
  });
  const governing = (attributeKey: string, ifcType?: string, tags?: Record<string, string>) =>
    findGoverningRule(layered, { attributeKey, ifcType, tags })?.id;

  it('picks the most specific match: member, then exact type, then constraints', () => {
    expect(governing(EXTERNAL, 'IfcWall')).toBe('wall-pset');
    expect(governing('usd::usdgeom::mesh', 'IfcWall')).toBe('walls');
    expect(governing(FIRE, 'IfcWallStandardCase')).toBe('wall-fire');
    expect(governing(FIRE, 'IfcWall')).toBe('core-fire');
    expect(governing(FIRE, 'IfcWall', { storey: 'EG' })).toBe('eg-fire');
    expect(governing(FIRE, 'IfcWall', { storey: 'OG1' })).toBe('core-fire');
  });

  it('never matches a typed rule without a known type', () => {
    expect(governing(FIRE)).toBeUndefined();
    expect(governing(FIRE, 'IfcSlab')).toBeUndefined();
  });
});

describe('resolveAttribute (§12.5 golden table)', () => {
  const spec = charter();
  const wallFire = { attributeKey: FIRE, ifcType: 'IfcWall' };
  const ungoverned = { attributeKey: EXTERNAL, ifcType: 'IfcWall' };

  it('row 1 agreed: no rule, one value, even across principals', () => {
    const opinions = [op('arch-1', ARCH, true), op('fire-1', FIRE_A, true)];
    expect(resolveAttribute(ungoverned, opinions, spec)).toEqual({
      state: 'agreed', shown: opinions[1], authoritative: [], dissent: [],
    });
    expect(resolveAttribute(ungoverned, [], spec).state).toBe('agreed');
  });

  it('row 2 divergent: no rule, values differ, stack order shows', () => {
    const opinions = [op('fire-1', FIRE_A, true), op('arch-1', ARCH, false)];
    const result = resolveAttribute(ungoverned, opinions, spec);
    expect(result.state).toBe('divergent');
    expect(result.shown).toBe(opinions[1]);
    // Without any charter, a governed attribute is just divergent too.
    expect(resolveAttribute(wallFire, [op('a', ARCH, 'EI 60'), op('f', FIRE_A, 'EI 90')]).state).toBe('divergent');
  });

  it('row 3 unconfirmed: rule applies, nobody in the role spoke', () => {
    const opinions = [op('arch-1', ARCH, 'EI 60'), op('import', undefined, 'EI 30')];
    const result = resolveAttribute(wallFire, opinions, spec);
    expect(result).toMatchObject({ state: 'unconfirmed', ruleId: 'fire-rating-walls', role: 'fire-consultant', authoritative: [], dissent: [] });
    expect(result.shown).toBe(opinions[1]);
  });

  it('row 4 authority-split: two principals in the role disagree', () => {
    const opinions = [op('fire-a', FIRE_A, 'EI 90'), op('fire-b', FIRE_B, 'EI 120'), op('arch-1', ARCH, 'EI 60')];
    const result = resolveAttribute(wallFire, opinions, spec);
    expect(result.state).toBe('authority-split');
    expect(result.shown).toBe(opinions[1]);
    expect(result.authoritative).toEqual([opinions[0], opinions[1]]);
    expect(result.dissent).toEqual([opinions[2]]);
  });

  it('row 5 contested: the authoritative value shows, regardless of stack order', () => {
    const opinions = [op('fire-1', FIRE_A, 'EI 90'), op('arch-1', ARCH, 'EI 60'), op('arch-2', ARCH, 'EI 90')];
    const result = resolveAttribute(wallFire, opinions, spec);
    expect(result.state).toBe('contested');
    expect(result.shown).toBe(opinions[0]);
    expect(result.dissent).toEqual([opinions[1]]);
  });

  it('row 6 authoritative: the role spoke and nobody differs', () => {
    const opinions = [op('arch-1', ARCH, { value: 'EI 90', type: 'IfcLabel' }), op('fire-1', FIRE_A, { type: 'IfcLabel', value: 'EI 90' })];
    const result = resolveAttribute(wallFire, opinions, spec);
    expect(result.state).toBe('authoritative');
    expect(result.shown).toBe(opinions[1]);
    expect(result.dissent).toEqual([]);
  });

  it('treats a removal (null) as a value like any other', () => {
    const result = resolveAttribute(wallFire, [op('fire-1', FIRE_A, 'EI 90'), op('arch-1', ARCH, null)], spec);
    expect(result.state).toBe('contested');
    expect(result.shown?.value).toBe('EI 90');
  });

  it('at trust level 3 only signed opinions are authoritative', () => {
    const unsigned = [op('fire-1', FIRE_A, 'EI 90'), op('arch-1', ARCH, 'EI 60')];
    expect(resolveAttribute(wallFire, unsigned, spec, { requireSignature: true }).state).toBe('unconfirmed');
    const signed = [{ ...unsigned[0], signatureVerified: true }, unsigned[1]];
    expect(resolveAttribute(wallFire, signed, spec, { requireSignature: true }).state).toBe('contested');
  });

  it('compares values canonically', () => {
    expect(canonicalValueKey({ b: [1, { d: 2, c: 3 }], a: undefined })).toBe(canonicalValueKey({ a: null, b: [1, { c: 3, d: 2 }] }));
    expect(canonicalValueKey('1')).not.toBe(canonicalValueKey(1));
    expect(canonicalValueKey(Number.NaN)).not.toBe(canonicalValueKey(null));
    expect(canonicalValueKey(Infinity)).not.toBe(canonicalValueKey(-Infinity));
    expect(canonicalValueKey([Number.NaN])).not.toBe(canonicalValueKey([null]));
    expect(canonicalValueKey(1n)).not.toBe(canonicalValueKey(1));
    expect(resolveAttribute({ attributeKey: EXTERNAL }, [op('a', ARCH, null), op('b', ARCH, Number.NaN)]).state).toBe('divergent');
  });
});
