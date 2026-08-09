/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bookkeeping behind the STEP header's `"Re-exported by ifc-lite, N
 * modification(s)"` claim, and behind `stats.modifiedEntityCount`.
 *
 * A full export counts at the INTENT sites, and that is sound there: the
 * source-iteration pass writes every modified host's own (rewritten) line, so
 * intending to modify an emittable host and emitting the modification are the
 * same event.
 *
 * `deltaOnly` breaks that identity. It skips the source-iteration pass
 * wholesale, so the only lines a source-backed host can contribute to a delta
 * are the ones the property-set generator, the quantity-set generator and the
 * type-object `HasPropertySets` rewrite produce for it. A modification with no
 * such line is simply not in the file:
 *
 *   - an in-place attribute edit (`setAttribute`) is applied by rewriting the
 *     entity's own line inside the skipped pass — the report in #2462;
 *   - a georeferencing edit to an EXISTING `IfcProjectedCRS` /
 *     `IfcMapConversion` is queued as exactly such attribute edits;
 *   - a property/quantity-set DELETION produces no replacement content, so
 *     there is nothing for the delta to carry either.
 *
 * All three used to count. The header then claimed a modification the DATA
 * section did not contain — for an attribute-only session, `"1 modification"`
 * over zero entity lines.
 *
 * So a delta's count is settled at the end, from what was actually emitted,
 * and what could not be delivered is reported rather than left silent. Retypes
 * and positional edits were never counted under `deltaOnly` (their count sites
 * live inside the skipped pass); they are equally undelivered, but they are not
 * nominated here either, so the warning cannot name them.
 *
 * NOTE this is about what a DELTA contains, not about what may reference a
 * source host. `willBeEmitted` / `hasEmittableHostBytes` deliberately answer
 * "yes" for a source record under `deltaOnly` — a generated
 * `IFCRELDEFINESBYPROPERTIES` may name a host whose line lives in the file
 * being patched. That carve-out is right, and orthogonal to this count.
 */

/**
 * How many expressIds the "deltaOnly dropped these edits" warning names before
 * it summarises the rest. A session can edit thousands of entities and this
 * string is read by a human, not parsed.
 */
const UNDELIVERED_IDS_IN_WARNING = 5;

export interface ModificationLedger {
  /** This host has an edit that would make it count as modified. */
  nominate(entityId: number): void;
  /** A pass wrote at least one line into the output for this host. */
  recordEmitted(entityId: number): void;
  /** Final count, plus a warning for every nominated host the file left out. */
  settle(): { modifiedEntityCount: number; warnings: string[] };
}

export function createModificationLedger(deltaOnly: boolean): ModificationLedger {
  // Full export: nothing to defer, the intent site IS the emit site.
  if (!deltaOnly) {
    let count = 0;
    return {
      nominate: () => { count++; },
      recordEmitted: () => {},
      settle: () => ({ modifiedEntityCount: count, warnings: [] }),
    };
  }

  const nominated = new Set<number>();
  const emitted = new Set<number>();
  return {
    nominate: (entityId) => { nominated.add(entityId); },
    recordEmitted: (entityId) => { emitted.add(entityId); },
    settle: () => {
      let modifiedEntityCount = 0;
      const undelivered: number[] = [];
      for (const entityId of nominated) {
        if (emitted.has(entityId)) modifiedEntityCount++;
        else undelivered.push(entityId);
      }
      const warnings = undelivered.length > 0 ? [undeliveredWarning(undelivered)] : [];
      return { modifiedEntityCount, warnings };
    },
  };
}

function undeliveredWarning(undelivered: number[]): string {
  const shown = undelivered
    .slice(0, UNDELIVERED_IDS_IN_WARNING)
    .map((id) => `#${id}`)
    .join(', ');
  const rest = undelivered.length - UNDELIVERED_IDS_IN_WARNING;
  const subject = undelivered.length === 1 ? 'entity' : 'entities';
  return (
    `deltaOnly export cannot carry in-place edits to ${undelivered.length} existing ${subject} `
    + `(${shown}${rest > 0 ? `, +${rest} more` : ''}): attribute, georeferencing and `
    + 'property-set-removal edits are applied by rewriting the entity\'s own line, which a delta '
    + 'does not contain. Export with deltaOnly disabled to apply them.'
  );
}
