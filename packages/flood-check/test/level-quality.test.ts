/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The quality of a candidate's level and position (`locate.ts`) over the whole
 * readability matrix, the earlier instances pinned as rows of the same table,
 * and end to end: an upper-estimate level never yields a reassuring outcome.
 */

import { describe, expect, it } from 'vitest';
import { locate, NO_BODY, type LocateKind, type LocationSources, type MapBody } from '../src/model/locate.js';
import { type MapPoint } from '../src/types.js';

type Body = 'none' | 'readable' | 'partly readable' | 'wholly unreadable';
const BODIES: Body[] = ['none', 'readable', 'partly readable', 'wholly unreadable'];

/** A body over x 0..1, y 0..1, z from `bottom` to `bottom + 2`. */
function body(state: Body, bottom = 500, x = 0): MapBody {
  const corners: Array<[number, number, number]> = [
    [x, 0, bottom], [x + 1, 0, bottom], [x + 1, 1, bottom], [x, 1, bottom],
    [x, 0, bottom + 2], [x + 1, 0, bottom + 2], [x + 1, 1, bottom + 2], [x, 1, bottom + 2],
  ];
  switch (state) {
    case 'none': return { ...NO_BODY };
    case 'readable': return { items: 1, readable: 1, corners };
    case 'partly readable': return { items: 2, readable: 1, corners };
    case 'wholly unreadable': return { items: 1, readable: 0, corners: [] };
  }
}

const placement = (level = 501, position: MapPoint = { x: 0.5, y: 0.5 }) => ({ position, level });

/** The quality the specification gives (README, `locate.ts`). */
function expected(kind: LocateKind, placed: boolean, own: Body, filled: Body | 'n/a'): 'refused' | 'exact' | 'upper-estimate' {
  if (!placed) return 'refused';
  if (kind === 'stair' || kind === 'ramp') return 'upper-estimate';
  const unreadable = (b: Body | 'n/a') => b === 'partly readable' || b === 'wholly unreadable';
  if (unreadable(own) || unreadable(filled)) return 'upper-estimate';
  if ((kind === 'opening' || kind === 'slab-opening' || kind === 'light-well') && own === 'none') return 'upper-estimate';
  // A placement alone is never exact: a door or window needs its own readable body or a readable filled opening, equipment its body.
  if ((kind === 'door' || kind === 'window') && own !== 'readable' && filled !== 'readable') return 'upper-estimate';
  if (kind === 'equipment' && own !== 'readable') return 'upper-estimate';
  return 'exact';
}

describe('the readability matrix', () => {
  const kinds: LocateKind[] = ['door', 'window', 'opening', 'slab-opening', 'light-well', 'stair', 'ramp', 'equipment'];
  const rows: Array<[LocateKind, boolean, Body, Body | 'n/a']> = [];
  for (const kind of kinds) {
    const filledStates: Array<Body | 'n/a'> = kind === 'door' || kind === 'window' ? ['n/a', 'readable', 'partly readable', 'wholly unreadable'] : ['n/a'];
    for (const placed of [true, false]) for (const own of BODIES) for (const filled of filledStates) rows.push([kind, placed, own, filled]);
  }

  it.each(rows)('%s, placement %s, own body %s, filled opening %s', (kind, placed, own, filled) => {
    const s: LocationSources = {
      placement: placed ? placement() : null,
      own: body(own),
      filled: filled === 'n/a' ? null : body(filled, 499.5),
      hostLevel: kind === 'slab-opening' ? 500 : undefined,
      groundLevel: 500,
    };
    const loc = locate(kind, s);
    const quality = 'refused' in loc ? 'refused' : loc.quality;
    expect(quality).toBe(expected(kind, placed, own, filled));
    // Nothing unreadable ever yields `exact`.
    if (own === 'partly readable' || own === 'wholly unreadable' || filled === 'partly readable' || filled === 'wholly unreadable') {
      expect(quality).not.toBe('exact');
    }
    // No row yields `exact` without a readable body or a readable filled opening.
    if (own !== 'readable' && filled !== 'readable') expect(quality).not.toBe('exact');
    if (quality === 'upper-estimate' && !('refused' in loc) && kind !== 'stair' && kind !== 'ramp') {
      expect(loc.notes.join()).toMatch(/upper estimate/);
    }
  });

  it('covers every class and every combination', () => {
    expect(rows).toHaveLength(2 * (2 * 4 * 4) + 6 * (2 * 4));
  });
});

describe('the earlier instances, as rows of the same table', () => {
  it('the reviewer\'s case: a window placed at its 502 m head filling an opening whose only body is an unreadable Brep', () => {
    const loc = locate('window', { placement: placement(502), own: body('none'), filled: body('wholly unreadable') });
    expect(loc).toMatchObject({ level: 502, quality: 'upper-estimate' });
  });

  it('a window placed at its head: the readable hole\'s bottom is used, exactly', () => {
    const loc = locate('window', { placement: placement(502), own: body('none'), filled: body('readable', 500) });
    expect(loc).toMatchObject({ level: 500, basis: 'opening-body-bottom', quality: 'exact' });
  });

  it('a light well placed at 502 m whose body reaches 499 m: the body\'s bottom, exactly', () => {
    const loc = locate('light-well', { placement: placement(502), own: body('readable', 499) });
    expect(loc).toMatchObject({ level: 499, basis: 'opening-body-bottom', quality: 'exact' });
  });

  it('an exact filled-opening level cannot upgrade an equal clipped-body lower bound', () => {
    const clipped = { ...body('readable', 500), clipped: 1 };
    const loc = locate('door', { placement: placement(502), own: clipped, filled: body('readable', 500) });
    expect(loc).toMatchObject({ level: 500, quality: 'lower-bound', lowest: 500 });
  });

  it('a partly readable opening, alone or filled: an upper estimate', () => {
    expect(locate('opening', { placement: placement(500), own: body('partly readable', 502) })).toMatchObject({ level: 502, quality: 'upper-estimate' });
    expect(locate('window', { placement: placement(502), own: body('none'), filled: body('partly readable', 502) })).toMatchObject({ quality: 'upper-estimate' });
  });

  it('a door placed at its wall origin: at the hole it fills, 15 m along', () => {
    const loc = locate('door', { placement: placement(500, { x: 0, y: 0 }), own: body('none'), filled: body('readable', 500, 14.5) });
    expect(loc).toMatchObject({ quality: 'exact' });
    expect('refused' in loc ? null : loc.position.x).toBeCloseTo(15, 6);
    expect('refused' in loc ? '' : loc.notes.join()).toMatch(/hole it fills/);
  });

  it('a placement-only door or opening is an upper estimate (a placement alone is never exact)', () => {
    expect(locate('door', { placement: placement(500), own: body('none'), filled: null })).toMatchObject({ quality: 'upper-estimate' });
    expect(locate('door', { placement: placement(500), own: body('none'), filled: body('none') })).toMatchObject({ quality: 'upper-estimate' });
    expect(locate('opening', { placement: placement(500), own: body('none') })).toMatchObject({ quality: 'upper-estimate' });
  });
});

