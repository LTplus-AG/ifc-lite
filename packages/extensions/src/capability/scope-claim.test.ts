/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  findCoveringClaim,
  opMatchesScopeClaim,
  parseScopeClaim,
  parseScopeClaims,
  scopeClaimCovers,
} from './scope-claim.js';
import type { ScopeClaim } from './scope-claim.js';

function claim(raw: string): ScopeClaim {
  const result = parseScopeClaim(raw);
  if (!result.ok) throw new Error(`expected valid claim: ${raw}`);
  return result.value;
}

describe('parseScopeClaim', () => {
  it('parses capability + selector + constraints', () => {
    const parsed = claim('model.mutate:Pset_FireSafety*@IfcWall&storey=EG');
    expect(parsed.capability.scope).toBe('model');
    expect(parsed.capability.action).toBe('mutate');
    expect(parsed.capability.target?.raw).toBe('Pset_FireSafety*');
    expect(parsed.selector).toEqual({ ifcType: 'IfcWall', constraints: { storey: 'EG' } });
  });

  it('tolerates the spec rendering with spaces', () => {
    const parsed = claim('model.mutate : Pset_FireSafety* @ IfcWall & storey=EG');
    expect(parsed.capability.target?.raw).toBe('Pset_FireSafety*');
    expect(parsed.selector).toEqual({ ifcType: 'IfcWall', constraints: { storey: 'EG' } });
  });

  it('parses plain capabilities without selector', () => {
    const parsed = claim('model.create:IfcPropertySet');
    expect(parsed.selector).toBeUndefined();
  });

  it('rejects empty selectors, bad constraints, and bad capabilities', () => {
    expect(parseScopeClaim('model.mutate:Pset_*@').ok).toBe(false);
    expect(parseScopeClaim('model.mutate:Pset_*@IfcWall&storey').ok).toBe(false);
    expect(parseScopeClaim('nonsense@IfcWall').ok).toBe(false);
    expect(parseScopeClaims(['model.read', 'bogus..claim']).ok).toBe(false);
  });
});

describe('scopeClaimCovers (claim within grant)', () => {
  it('grants without selector cover any selector; not vice versa', () => {
    const broad = claim('model.mutate:Pset_FireSafety*');
    const narrow = claim('model.mutate:Pset_FireSafety*@IfcWall&storey=EG');
    expect(scopeClaimCovers(broad, narrow)).toBe(true);
    expect(scopeClaimCovers(narrow, broad)).toBe(false);
  });

  it('requires claim constraints to include grant constraints', () => {
    const grant = claim('model.mutate:Pset_*@IfcWall&storey=EG');
    expect(scopeClaimCovers(grant, claim('model.mutate:Pset_FireSafety*@IfcWall&storey=EG'))).toBe(true);
    expect(scopeClaimCovers(grant, claim('model.mutate:Pset_FireSafety*@IfcWall&storey=OG1'))).toBe(false);
    expect(scopeClaimCovers(grant, claim('model.mutate:Pset_FireSafety*@IfcWall'))).toBe(false);
  });

  it('requires EVERY grant constraint to match, not just the first', () => {
    // Regression: the constraint check is a loop over multiple key=value
    // pairs. A claim that satisfies the first constraint but fails a
    // later one must still be denied — a loop that only inspects the
    // first entry would wrongly grant coverage here.
    const grant = claim('model.mutate:Pset_*@IfcWall&storey=EG&fireRating=required');
    // Counterfactual: matching only the first constraint is NOT enough.
    expect(
      scopeClaimCovers(grant, claim('model.mutate:Pset_*@IfcWall&storey=EG&fireRating=optional')),
    ).toBe(false);
    // Both constraints must match for coverage to hold.
    expect(
      scopeClaimCovers(grant, claim('model.mutate:Pset_*@IfcWall&storey=EG&fireRating=required')),
    ).toBe(true);
  });

  it('matches IFC type prefix globs one-way', () => {
    const grant = claim('model.mutate:Pset_*@IfcWall*');
    expect(scopeClaimCovers(grant, claim('model.mutate:Pset_*@IfcWallStandardCase'))).toBe(true);
    expect(scopeClaimCovers(claim('model.mutate:Pset_*@IfcWall'), claim('model.mutate:Pset_*@IfcWall*'))).toBe(false);
  });
});

describe('opMatchesScopeClaim (write/publish-time enforcement)', () => {
  const fireSafety = claim('model.mutate:Pset_FireSafety*@IfcWall&storey=EG');

  it('accepts in-scope ops', () => {
    expect(
      opMatchesScopeClaim(fireSafety, {
        capability: 'model.mutate:Pset_FireSafety',
        ifcType: 'IfcWall',
        tags: { storey: 'EG' },
      }),
    ).toBe(true);
  });

  it('rejects out-of-scope action, type, constraint, and unknown tags (fail closed)', () => {
    expect(
      opMatchesScopeClaim(fireSafety, {
        capability: 'model.delete',
        ifcType: 'IfcWall',
        tags: { storey: 'EG' },
      }),
    ).toBe(false);
    expect(
      opMatchesScopeClaim(fireSafety, {
        capability: 'model.mutate:Pset_FireSafety',
        ifcType: 'IfcDoor',
        tags: { storey: 'EG' },
      }),
    ).toBe(false);
    expect(
      opMatchesScopeClaim(fireSafety, {
        capability: 'model.mutate:Pset_FireSafety',
        ifcType: 'IfcWall',
        tags: { storey: 'OG1' },
      }),
    ).toBe(false);
    expect(
      opMatchesScopeClaim(fireSafety, {
        capability: 'model.mutate:Pset_FireSafety',
        ifcType: 'IfcWall',
      }),
    ).toBe(false);
  });

  it('requires EVERY claim constraint to match an op tag, not just the first', () => {
    // Regression: same multi-constraint loop as scopeClaimCovers, on the
    // op-enforcement side. A single satisfied constraint must not be
    // enough when the claim has more than one.
    const twoConstraint = claim('model.mutate:Pset_FireSafety*@IfcWall&storey=EG&zone=A');
    // Counterfactual: op satisfies "storey" but fails "zone" — must deny.
    expect(
      opMatchesScopeClaim(twoConstraint, {
        capability: 'model.mutate:Pset_FireSafety',
        ifcType: 'IfcWall',
        tags: { storey: 'EG', zone: 'B' },
      }),
    ).toBe(false);
    // Both constraints satisfied — must accept.
    expect(
      opMatchesScopeClaim(twoConstraint, {
        capability: 'model.mutate:Pset_FireSafety',
        ifcType: 'IfcWall',
        tags: { storey: 'EG', zone: 'A' },
      }),
    ).toBe(true);
  });

  it('findCoveringClaim returns the matching claim or undefined', () => {
    const claims = [claim('model.read'), fireSafety];
    expect(
      findCoveringClaim(claims, {
        capability: 'model.mutate:Pset_FireSafetyZones',
        ifcType: 'IfcWall',
        tags: { storey: 'EG' },
      }),
    ).toBe(fireSafety);
    expect(findCoveringClaim(claims, { capability: 'model.delete' })).toBeUndefined();
  });
});
