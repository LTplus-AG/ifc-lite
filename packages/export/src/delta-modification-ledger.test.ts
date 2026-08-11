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
 * 3. Which kinds settle from EFFECT. A property/quantity-set nomination is made
 *    from a set NAME the mutation history mentions and has to wait for a pass
 *    to report content written or content withheld — in BOTH modes, since a
 *    full export can leave a set edit resolving to nothing just as easily
 *    (#2474). The in-place kinds are written by the pass that nominates them
 *    and settle themselves.
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

  it('full export: distinct hosts each count once their kind is settled', () => {
    const ledger = createModificationLedger(false);
    ledger.nominate(1, 'attribute');
    ledger.nominate(2, 'property-set');
    ledger.nominate(3, 'quantity-set');
    // An in-place kind is written by the pass that nominates it, so #1 needs no
    // emission. The two SET kinds do: their nomination site sees a set NAME,
    // not whether it resolves to content (#2474).
    ledger.recordEmitted(2, 'property-set');
    ledger.recordWithheld(3, 'quantity-set');

    expect(ledger.settle()).toEqual({ modifiedEntityCount: 3, warnings: [] });
  });

  it('full export: a set nomination nothing delivered does not count', () => {
    const ledger = createModificationLedger(false);
    // `deletePropertySet(id, 'AName')` on a host that owns no such set: the
    // name is affected, nothing matches, nothing is generated and nothing is
    // withheld. This used to be `modifiedEntityCount: 1` over a byte-identical
    // file, and the header claimed it (#2474).
    ledger.nominate(2, 'property-set');
    ledger.nominate(3, 'quantity-set');

    // Silent, deliberately: a full export has no delta format to blame and the
    // caller has nothing to do about an edit that resolved to nothing.
    expect(ledger.settle()).toEqual({ modifiedEntityCount: 0, warnings: [] });
  });

  it('full export: a WITHHELD set is a change - a deletion generates nothing', () => {
    const ledger = createModificationLedger(false);
    ledger.nominate(2, 'property-set');
    ledger.recordWithheld(2, 'property-set');

    // Without this half, converting the set kinds to effect would silently zero
    // the count for every real DELETION, which produces no replacement lines to
    // record an emission for.
    expect(ledger.settle()).toEqual({ modifiedEntityCount: 1, warnings: [] });
  });

  it('full export: content emitted for a host nobody nominated still does not count', () => {
    const ledger = createModificationLedger(false);
    // The pset generator records what it wrote without asking whether the host
    // was countable. An overlay-CREATED host's psets are already in
    // `newEntityCount`, which is why its nomination site skips it - and why
    // delivery alone must never be enough.
    ledger.recordEmitted(2, 'property-set');
    ledger.recordWithheld(3, 'quantity-set');

    expect(ledger.settle()).toEqual({ modifiedEntityCount: 0, warnings: [] });
  });

  it('deltaOnly: withholding delivers nothing - a delta has no lines to leave out', () => {
    const ledger = createModificationLedger(true);
    ledger.nominate(2, 'property-set');
    ledger.recordWithheld(2, 'property-set');

    // The deletion is genuinely not in the delta, and the warning that says so
    // must survive the full-export path learning to count withheld content.
    const { modifiedEntityCount, warnings } = ledger.settle();
    expect(modifiedEntityCount).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('property-set changes');
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
