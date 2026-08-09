/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `modifiedEntityCount` counts ENTITIES. The `deltaOnly` ledger has always
 * enforced that with a `Set`; the full-export ledger used a bare `count++`, so
 * two nominations of one host counted twice — the same over-counted header this
 * whole change exists to remove, surviving on the other branch.
 *
 * No double count is reachable through the exporter today: all six nominate
 * sites are guarded against each other by hand (`modifiedEntities`,
 * `modifiedPsets`, `entityPropMutations`/`entityQuantMutations`), including the
 * two georeferencing branches, whose hosts land in `modifiedEntities` at the
 * attribute-collection step before either branch is reached. That guard set is
 * an invariant spread across six call sites in a 2000-line method, which is
 * exactly the kind a seventh site added later cannot be expected to rediscover.
 *
 * So this is a UNIT test against the ledger, not an exporter scenario: it pins
 * the property the exporter's guards currently happen to provide, at the one
 * place that can guarantee it.
 */

import { describe, expect, it } from 'vitest';
import { createModificationLedger } from './delta-modification-ledger.js';

describe('the modification ledger counts entities, not nominations', () => {
  it('full export: nominating one host twice counts it once', () => {
    const ledger = createModificationLedger(false);
    ledger.nominate(42);
    ledger.nominate(42);

    // `count++` gives 2 here.
    expect(ledger.settle()).toEqual({ modifiedEntityCount: 1, warnings: [] });
  });

  it('full export: distinct hosts each count, and emission is irrelevant', () => {
    const ledger = createModificationLedger(false);
    ledger.nominate(1);
    ledger.nominate(2);
    ledger.nominate(3);
    // The full path counts at the INTENT site — the source-iteration pass
    // writes every modified host's own line, so there is no emission to wait
    // for and `recordEmitted` stays a no-op. The count must not depend on it.
    ledger.recordEmitted(1);

    expect(ledger.settle()).toEqual({ modifiedEntityCount: 3, warnings: [] });
  });

  it('full export: no nominations, no count and no warnings', () => {
    expect(createModificationLedger(false).settle()).toEqual({
      modifiedEntityCount: 0,
      warnings: [],
    });
  });

  it('deltaOnly: nominating one host twice and emitting it once counts it once', () => {
    const ledger = createModificationLedger(true);
    ledger.nominate(42);
    ledger.nominate(42);
    ledger.recordEmitted(42);

    expect(ledger.settle()).toEqual({ modifiedEntityCount: 1, warnings: [] });
  });

  it('deltaOnly: a nominated host with nothing emitted is named, not counted', () => {
    const ledger = createModificationLedger(true);
    ledger.nominate(7);
    ledger.nominate(8);
    ledger.recordEmitted(8);

    const { modifiedEntityCount, warnings } = ledger.settle();
    expect(modifiedEntityCount).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('#7');
    expect(warnings[0]).not.toContain('#8');
  });

  it('recording an emission nobody nominated changes nothing', () => {
    for (const deltaOnly of [false, true]) {
      const ledger = createModificationLedger(deltaOnly);
      ledger.recordEmitted(99);
      expect(ledger.settle()).toEqual({ modifiedEntityCount: 0, warnings: [] });
    }
  });
});
