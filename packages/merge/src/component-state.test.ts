/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `componentKeyForAttribute` must agree with the producer side of the
 * pipe: `packages/mutations/src/change-set-to-ops.ts` builds
 * `pset:<name>` / `qset:<name>` component keys unconditionally from the
 * mutation type, for ANY author-chosen set name — not only names
 * starting with `Pset_`/`Qto_`. `@ifc-lite/collab`'s structured-attribute
 * inflation (packages/collab/src/snapshot/structured-attrs.ts) already
 * disambiguates a custom v5a set name by value shape (typed record →
 * pset, plain finite number → quantity) and documents that convention as
 * "already shared" by the merge engine's componentKey vocabulary — this
 * pins that this package actually holds up its end.
 */

import { describe, expect, it } from 'vitest';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { componentKeyForAttribute, extractStackState } from './component-state.js';

describe('componentKeyForAttribute', () => {
  it('buckets a custom (non-Pset_) set name as pset:<name> when the value is a typed property record', () => {
    const key = componentKeyForAttribute('bsi::ifc::v5a::MyCustomSet::FireRating', {
      type: 'IfcLabel',
      value: 'REI60',
    });
    expect(key).toBe('pset:MyCustomSet');
  });

  it('buckets a custom (non-Qto_) set name as qset:<name> when the value is a plain finite number', () => {
    const key = componentKeyForAttribute('bsi::ifc::v5a::MyMetrics::Height', 3.2);
    expect(key).toBe('qset:MyMetrics');
  });

  it('still buckets the standard Pset_/Qto_ prefixes the same as before, value or no value', () => {
    expect(componentKeyForAttribute('bsi::ifc::v5a::Pset_FireSafety::FireRating', { type: 'IfcLabel', value: 'REI60' })).toBe(
      'pset:Pset_FireSafety',
    );
    expect(componentKeyForAttribute('bsi::ifc::v5a::Pset_FireSafety::FireRating', null)).toBe('pset:Pset_FireSafety');
    expect(componentKeyForAttribute('bsi::ifc::v5a::Qto_WallBaseQuantities::Height', 3)).toBe(
      'qset:Qto_WallBaseQuantities',
    );
    expect(componentKeyForAttribute('bsi::ifc::v5a::Qto_WallBaseQuantities::Height', null)).toBe(
      'qset:Qto_WallBaseQuantities',
    );
  });
});

describe('extractStackState + a whole-pset tombstone lookup on a custom-named set (the buildDeltaNodes path)', () => {
  it('finds the custom-named pset members under pset:<name>, not a one-off attr:<key> bucket', () => {
    const base: IfcxFile = {
      header: { id: 'base', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: 't' },
      imports: [],
      schemas: {},
      data: [
        {
          path: 'wall-guid-1',
          attributes: {
            'bsi::ifc::v5a::MyCustomSet::FireRating': { type: 'IfcLabel', value: 'REI60' },
          },
        },
      ],
    };
    const state = extractStackState([base]);
    const entity = state.get('wall-guid-1');
    // Before the fix this component simply didn't exist under
    // `pset:MyCustomSet` — every member fell into its own
    // `attr:<full key>` bucket instead, so a whole-component tombstone
    // lookup (`buildDeltaNodes`'s `tombstone-component` case) found
    // nothing to null and silently deleted zero attributes.
    expect(entity?.components.get('pset:MyCustomSet')).toEqual({
      'bsi::ifc::v5a::MyCustomSet::FireRating': { type: 'IfcLabel', value: 'REI60' },
    });
  });
});
