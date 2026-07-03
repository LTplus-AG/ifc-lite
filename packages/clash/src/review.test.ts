/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { Clash, ClashElementRef, ClashReviewStatus } from './types.js';
import {
  clashReviewKey,
  aggregateReviewStatus,
  reviewStatusToBcfTopicStatus,
} from './review.js';

function ref(key: string, model = 'm'): ClashElementRef {
  return { key, ref: key.length, model, tag: 'IfcWall' };
}

function clashLike(rule: string, aKey: string, bKey: string, model = 'm'): Pick<Clash, 'rule' | 'a' | 'b'> {
  return { rule, a: ref(aKey, model), b: ref(bKey, model) };
}

describe('clashReviewKey', () => {
  it('is order-independent in the two element keys', () => {
    // The same physical clash reported A<->B or B<->A must key identically, so a
    // review re-attaches regardless of which side the detector labelled first.
    expect(clashReviewKey(clashLike('r', 'GUID_A', 'GUID_B'))).toBe(
      clashReviewKey(clashLike('r', 'GUID_B', 'GUID_A')),
    );
  });

  it('is model-independent (survives an ephemeral runtime modelId change)', () => {
    // #1468: the durable key must NOT embed the per-load modelId, so a review
    // survives a page reload / re-load where the modelId is regenerated.
    expect(clashReviewKey(clashLike('r', 'GUID_A', 'GUID_B', 'model-load-1'))).toBe(
      clashReviewKey(clashLike('r', 'GUID_A', 'GUID_B', 'model-load-2')),
    );
  });

  it('distinguishes different rules on the same element pair', () => {
    expect(clashReviewKey(clashLike('hard', 'GUID_A', 'GUID_B'))).not.toBe(
      clashReviewKey(clashLike('clearance', 'GUID_A', 'GUID_B')),
    );
  });

  it('distinguishes different element pairs', () => {
    expect(clashReviewKey(clashLike('r', 'GUID_A', 'GUID_B'))).not.toBe(
      clashReviewKey(clashLike('r', 'GUID_A', 'GUID_C')),
    );
  });
});

describe('aggregateReviewStatus', () => {
  it('defaults an empty set to open', () => {
    expect(aggregateReviewStatus([])).toBe('open');
  });

  it('lets a single open member keep the whole group open', () => {
    expect(aggregateReviewStatus(['accepted', 'resolved', 'open'])).toBe('open');
  });

  it('is resolved when the least-resolved member is resolved', () => {
    expect(aggregateReviewStatus(['accepted', 'resolved', 'accepted'])).toBe('resolved');
  });

  it('is accepted only when every member is accepted', () => {
    expect(aggregateReviewStatus(['accepted', 'accepted'])).toBe('accepted');
  });
});

describe('reviewStatusToBcfTopicStatus', () => {
  it('maps open to Open and both terminal states to Closed (max-interop)', () => {
    const map: Record<ClashReviewStatus, string> = {
      open: reviewStatusToBcfTopicStatus('open'),
      resolved: reviewStatusToBcfTopicStatus('resolved'),
      accepted: reviewStatusToBcfTopicStatus('accepted'),
    };
    expect(map).toEqual({ open: 'Open', resolved: 'Closed', accepted: 'Closed' });
  });
});
