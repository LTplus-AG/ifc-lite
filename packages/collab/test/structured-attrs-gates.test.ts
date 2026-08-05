/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import {
  flattenStructuredBranches,
  inflateStructuredAttributes,
} from '../src/snapshot/structured-attrs.js';

/**
 * `[].every(...)` is vacuously true, so an explicitly-empty
 * `classifications` / `materials` attribute used to pass the shape gate
 * in `inflateStructuredAttributes`, get pulled out of the flat
 * attributes into the (now-empty) structured branch, and then never get
 * re-emitted by `flattenStructuredBranches` (which only re-emits
 * non-empty branches). Net effect: a peer that explicitly clears
 * classifications/materials to `[]` has that clearing silently dropped
 * on a snapshot -> seed round trip.
 */
describe('structured-attrs empty-array gate (#1031 regression)', () => {
  it('round-trips an explicitly empty classifications array', () => {
    const inflated = inflateStructuredAttributes({
      [IFCLITE_ATTR.CLASSIFICATIONS]: [],
    });

    // The key must stay in `flat` — an empty array never inflates into
    // the structured branch.
    expect(inflated.attributes[IFCLITE_ATTR.CLASSIFICATIONS]).toEqual([]);
    expect(inflated.classifications).toEqual([]);

    const flattened = flattenStructuredBranches({
      attributes: inflated.attributes,
      psets: inflated.psets,
      quantities: inflated.quantities,
      classifications: inflated.classifications,
      materials: inflated.materials,
      geometryRefs: inflated.geometryRefs,
    });

    expect(flattened[IFCLITE_ATTR.CLASSIFICATIONS]).toEqual([]);
  });

  it('round-trips an explicitly empty materials array', () => {
    const inflated = inflateStructuredAttributes({
      [IFCLITE_ATTR.MATERIALS]: [],
    });

    expect(inflated.attributes[IFCLITE_ATTR.MATERIALS]).toEqual([]);
    expect(inflated.materials).toEqual([]);

    const flattened = flattenStructuredBranches({
      attributes: inflated.attributes,
      psets: inflated.psets,
      quantities: inflated.quantities,
      classifications: inflated.classifications,
      materials: inflated.materials,
      geometryRefs: inflated.geometryRefs,
    });

    expect(flattened[IFCLITE_ATTR.MATERIALS]).toEqual([]);
  });
});
