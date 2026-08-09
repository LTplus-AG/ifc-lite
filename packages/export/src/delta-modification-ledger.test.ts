/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit cover for the two properties the exporter cannot demonstrate on its own.
 *
 * 1. `modifiedEntityCount` counts ENTITIES. The ledger is keyed on
 *    (entity, kind), so the entity-level de-duplication now lives HERE and
 *    nowhere else — the exporter's nominate sites used to guard against each
 *    other by hand (`modifiedPsets`, `entityPropMutations` /
 *    `entityQuantMutations`, `modifiedEntities`) and those guards were removed
 *    precisely because they also suppressed the per-kind warning. An invariant
 *    that used to be spread across six call sites in a 2000-line method is one
 *    `Set` in `settle()`; this is the test that holds it.
 * 2. Delivery is per KIND. A host whose property set landed and whose rename
 *    did not is `count: 1` AND a warning naming the rename — the two are not in
 *    conflict, and no exporter scenario states that as plainly as this does.
 */

import { describe, expect, it } from 'vitest';
import { createModificationLedger } from './delta-modification-ledger.js';

describe('the modification ledger counts entities, not nominations', () => {
  it('full export: nominating one host twice counts it once', () => {
    const ledger = createModificationLedger(false);
    ledger.nominate(42, 'attribute');
    ledger.nominate(42, 'attribute');

    // `count++` gives 2 here.
    expect(ledger.settle()).toEqual({ modifiedEntityCount: 1, warnings: [] });
  });

  it('full export: two KINDS on one host still count once', () => {
    const ledger = createModificationLedger(false);
    ledger.nominate(42, 'attribute');
    ledger.nominate(42, 'property-set');
    ledger.nominate(42, 'retype');

    // The header claim is per entity and the per-kind keying must not inflate
    // it — this is the guard on the whole change.
    expect(ledger.settle()).toEqual({ modifiedEntityCount: 1, warnings: [] });
  });

  it('full export: distinct hosts each count, and emission is irrelevant', () => {
    const ledger = createModificationLedger(false);
    ledger.nominate(1, 'attribute');
    ledger.nominate(2, 'property-set');
    ledger.nominate(3, 'quantity-set');
    // The full path counts at the INTENT site — the source-iteration pass
    // writes every modified host's own line, so there is no emission to wait
    // for and `recordEmitted` stays a no-op. The count must not depend on it.
    ledger.recordEmitted(1, 'attribute');

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
    ledger.nominate(42, 'property-set');
    ledger.nominate(42, 'property-set');
    ledger.recordEmitted(42, 'property-set');

    expect(ledger.settle()).toEqual({ modifiedEntityCount: 1, warnings: [] });
  });

  it('deltaOnly: a nominated host with nothing emitted is named, not counted', () => {
    const ledger = createModificationLedger(true);
    ledger.nominate(7, 'attribute');
    ledger.nominate(8, 'property-set');
    ledger.recordEmitted(8, 'property-set');

    const { modifiedEntityCount, warnings } = ledger.settle();
    expect(modifiedEntityCount).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('#7');
    expect(warnings[0]).not.toContain('#8');
  });

  it('deltaOnly: a delivered kind does NOT deliver the host\'s other kinds', () => {
    const ledger = createModificationLedger(true);
    ledger.nominate(8, 'attribute');
    ledger.nominate(8, 'property-set');
    // Generated pset lines deliver the pset edit and nothing else.
    ledger.recordEmitted(8, 'property-set');

    const { modifiedEntityCount, warnings } = ledger.settle();
    // Still ONE modified entity: the delta really does carry a change for #8.
    expect(modifiedEntityCount).toBe(1);
    // ...and the rename it does NOT carry is named, with its kind. Keyed per
    // entity this was `warnings: []` — the shape Codex flagged on #2469.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('#8');
    expect(warnings[0]).toContain('attribute edits');
    expect(warnings[0]).not.toContain('property-set');
  });

  it('deltaOnly: each undelivered kind gets its own warning', () => {
    const ledger = createModificationLedger(true);
    ledger.nominate(8, 'attribute');
    ledger.nominate(40, 'georeferencing');
    ledger.nominate(8, 'quantity-set');

    const { modifiedEntityCount, warnings } = ledger.settle();
    expect(modifiedEntityCount).toBe(0);
    expect(warnings).toHaveLength(3);
    // Deterministic order, so `stats.warnings` is stable across runs.
    expect(warnings.map((w) => /carried no ([a-z-]+ [a-z-]+)/.exec(w)![1])).toEqual([
      'attribute edits',
      'georeferencing edits',
      'quantity-set changes',
    ]);
  });

  it('deltaOnly: an acknowledged drop is silent here, and still does not count', () => {
    const ledger = createModificationLedger(true);
    ledger.nominate(5, 'property-set');
    // The type-object rewrite could not repoint `HasPropertySets` and said so
    // in its own, more specific warning. Repeating it as "a delta cannot carry
    // property-set changes" would blame the format for an input defect.
    ledger.acknowledgeUndelivered(5, 'property-set');

    expect(ledger.settle()).toEqual({ modifiedEntityCount: 0, warnings: [] });
  });

  it('deltaOnly: an emission outranks an acknowledgement of the same pair', () => {
    const ledger = createModificationLedger(true);
    ledger.nominate(5, 'property-set');
    ledger.recordEmitted(5, 'property-set');
    ledger.acknowledgeUndelivered(5, 'property-set');

    expect(ledger.settle()).toEqual({ modifiedEntityCount: 1, warnings: [] });
  });

  it('deltaOnly: acknowledging one kind leaves the host\'s other kinds reported', () => {
    const ledger = createModificationLedger(true);
    ledger.nominate(5, 'property-set');
    ledger.nominate(5, 'attribute');
    ledger.acknowledgeUndelivered(5, 'property-set');

    const { modifiedEntityCount, warnings } = ledger.settle();
    expect(modifiedEntityCount).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('attribute edits');
  });

  it('recording an emission nobody nominated changes nothing', () => {
    for (const deltaOnly of [false, true]) {
      const ledger = createModificationLedger(deltaOnly);
      ledger.recordEmitted(99, 'attribute');
      expect(ledger.settle()).toEqual({ modifiedEntityCount: 0, warnings: [] });
    }
  });

  it('the warning summarises past the first five ids rather than growing forever', () => {
    const ledger = createModificationLedger(true);
    for (let id = 1; id <= 8; id++) ledger.nominate(id, 'attribute');

    const [warning] = ledger.settle().warnings;
    expect(warning).toContain('8 existing entities');
    expect(warning).toContain('#1, #2, #3, #4, #5, +3 more');
    expect(warning).not.toContain('#6');
  });
});
