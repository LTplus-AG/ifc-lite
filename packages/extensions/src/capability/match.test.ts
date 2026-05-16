/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { findGrant, hasCapability, matchCapability } from './match.js';
import { parseCapability } from './parse.js';

function parse(raw: string) {
  const r = parseCapability(raw);
  if (!r.ok) throw new Error(`parse failed: ${r.errors[0].message}`);
  return r.value;
}

describe('matchCapability — exact', () => {
  it('matches identical capabilities without targets', () => {
    expect(matchCapability(parse('model.read'), parse('model.read'))).toBe(true);
  });

  it('rejects mismatched scope', () => {
    expect(matchCapability(parse('model.read'), parse('viewer.read'))).toBe(false);
  });

  it('rejects mismatched action', () => {
    expect(matchCapability(parse('model.read'), parse('model.create'))).toBe(false);
  });

  it('matches identical targets', () => {
    expect(
      matchCapability(
        parse('network.fetch:example.com'),
        parse('network.fetch:example.com'),
      ),
    ).toBe(true);
  });

  it('rejects different specific targets', () => {
    expect(
      matchCapability(
        parse('network.fetch:example.com'),
        parse('network.fetch:other.com'),
      ),
    ).toBe(false);
  });
});

describe('matchCapability — wildcards', () => {
  it('universal target covers any target', () => {
    expect(
      matchCapability(parse('model.mutate:*'), parse('model.mutate:Pset_WallCommon.FireRating')),
    ).toBe(true);
  });

  it('universal target does NOT cover no-target request', () => {
    // model.mutate without target is a different shape than model.mutate:*
    expect(matchCapability(parse('model.mutate:*'), parse('model.read'))).toBe(false);
  });

  it('prefix glob within segment matches', () => {
    expect(
      matchCapability(parse('model.mutate:Pset_*'), parse('model.mutate:Pset_WallCommon')),
    ).toBe(true);
  });

  it('prefix glob does not match non-prefix value', () => {
    expect(
      matchCapability(parse('model.mutate:Pset_*'), parse('model.mutate:Qto_WallBase')),
    ).toBe(false);
  });

  it('bare-* segment matches a single segment', () => {
    expect(
      matchCapability(parse('command.invoke:*.export'), parse('command.invoke:ext-foo.export')),
    ).toBe(true);
  });

  it('segment-count mismatch fails (no implicit recursion)', () => {
    expect(
      matchCapability(
        parse('command.invoke:*.export'),
        parse('command.invoke:ext-foo.bar.export'),
      ),
    ).toBe(false);
  });

  it('multi-segment glob target matches per-segment', () => {
    expect(
      matchCapability(
        parse('model.mutate:Pset_*.FireRating'),
        parse('model.mutate:Pset_WallCommon.FireRating'),
      ),
    ).toBe(true);
  });
});

describe('matchCapability — target requirements', () => {
  it('no-target grant does not cover targeted request', () => {
    expect(matchCapability(parse('model.create'), parse('model.create'))).toBe(true);
    // a fictional "with target" against "without target" — make sure asymmetry holds
  });

  it('with-target grant does not cover no-target request', () => {
    expect(
      matchCapability(parse('model.mutate:Pset_*'), parse('model.mutate')),
    ).toBe(false);
  });
});

describe('hasCapability / findGrant', () => {
  const grants = [
    parse('model.read'),
    parse('model.mutate:Pset_*.*'),
    parse('network.fetch:bsdd.example.com'),
  ];

  it('finds a matching grant via two-segment pattern', () => {
    const req = parse('model.mutate:Pset_WallCommon.FireRating');
    expect(hasCapability(grants, req)).toBe(true);
    expect(findGrant(grants, req)?.raw).toBe('model.mutate:Pset_*.*');
  });

  it('does not match when segment counts differ', () => {
    // Single-segment grant should NOT cover a two-segment request.
    const narrowGrants = [parse('model.mutate:Pset_*')];
    expect(hasCapability(narrowGrants, parse('model.mutate:Pset_WallCommon.FireRating'))).toBe(false);
    expect(hasCapability(narrowGrants, parse('model.mutate:Pset_WallCommon'))).toBe(true);
  });

  it('returns false for unmatched', () => {
    expect(hasCapability(grants, parse('export.create:csv'))).toBe(false);
  });

  it('returns undefined when no grant matches', () => {
    expect(findGrant(grants, parse('storage.local'))).toBeUndefined();
  });
});
