/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IDSNamespace } from './ids.js';

const ids = new IDSNamespace();

describe('IDSNamespace.summarize', () => {
  it('derives spec pass/fail from entity results when no status is present', () => {
    const summary = ids.summarize({
      specificationResults: [
        { entityResults: [{ passed: true }, { passed: false }] },
        { entityResults: [{ passed: true }] },
      ],
    });

    expect(summary.totalSpecifications).toBe(2);
    expect(summary.failedSpecifications).toBe(1);
    expect(summary.passedSpecifications).toBe(1);
    expect(summary.totalEntities).toBe(3);
    expect(summary.failedEntities).toBe(1);
  });

  it('prefers the validator spec status — cardinality-only failures count as failed', () => {
    // A required spec matching zero entities has no entity results at
    // all, yet the validator marks it failed. Deriving purely from
    // entity results used to report it as passed, making this summary
    // disagree with the validator's own report.summary (and the CLI's
    // text-mode verdict).
    const summary = ids.summarize({
      specificationResults: [
        { entityResults: [], status: 'fail' },
        { entityResults: [{ passed: true }], status: 'pass' },
        { entityResults: [], status: 'not_applicable' },
      ],
    });

    expect(summary.totalSpecifications).toBe(3);
    expect(summary.failedSpecifications).toBe(1);
    // Legacy shape invariant: passed + failed = total, so a
    // not-applicable spec counts as non-failed here.
    expect(summary.passedSpecifications).toBe(2);
  });

  it('prohibited spec violated by passing entities counts as failed when status says so', () => {
    const summary = ids.summarize({
      specificationResults: [
        // maxOccurs=0 spec: the matched entity "passes" its (empty)
        // requirements but the spec itself fails on cardinality.
        { entityResults: [{ passed: true }], status: 'fail' },
      ],
    });

    expect(summary.failedSpecifications).toBe(1);
    expect(summary.passedSpecifications).toBe(0);
    expect(summary.failedEntities).toBe(0);
  });
});
