/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a FULL export nominates the two NAMED-ATTRIBUTE modification kinds.
 *
 * `attribute` and `georeferencing` are both applied by writing a named slot on
 * the host's own source line, and both used to be nominated where the edit was
 * COLLECTED — before any pass had asked whether the write landed. Two reachable
 * edits write nothing: `setAttribute(id, 'Name', v)` with `v` already in the
 * slot, and `setAttribute(id, name, v)` naming an attribute the class declares
 * no slot for (which `applyAttributeMutations` discards). Either one put
 * "1 modification" in the header of a file byte-identical to its input — the
 * same shape #2462 / #2469 / #2474 removed from the other kinds, and the last
 * member of that family (#2483).
 *
 * The signal already existed: the mutation pipeline reports `attributed` by
 * comparing the line across the named-attribute write, so it is an EFFECT and
 * not an intent. What was missing is a nomination that waits for it.
 *
 * ## Why the nomination moves rather than the count
 *
 * The other direction — nominate at collection, then withdraw — cannot be used
 * here without taking the nomination away from `deltaOnly`, whose per-kind
 * warning exists precisely to NAME an edit the delta format could not carry.
 * There, an undeliverable edit is the one that most needs nominating, so that
 * mode keeps counting intent and settles delivery at the end. A full export has
 * no such warning and no delta format to blame, so the honest report is the
 * count alone: zero modifications over a file this export did not change.
 *
 * So the collection sites keep the eligibility rules (an overlay-CREATED host
 * is already in `newEntityCount`; a host with no emittable source bytes never
 * gets its line rewritten) and record WHO would be nominated, and the emit
 * sites decide WHETHER. {@link InPlaceNominees} is that handoff.
 */

import type { ModificationLedger, SourceLineDelivery } from './delta-modification-ledger.js';

/**
 * The hosts whose in-place named-attribute edits are eligible to count, per
 * kind, as decided by the collection pass.
 *
 * Two sets rather than one, because the two kinds are queued into the SAME
 * `modifiedAttributes` map and applied by the SAME call: `attributed` alone
 * cannot say which of them a rewritten line delivered. A host can be in both
 * (an `IfcProjectedCRS` the session also renamed through `setAttribute`), and
 * then both are nominated — `modifiedEntityCount` counts entities, so that is
 * still one modification.
 */
export interface InPlaceNominees {
  /** Hosts carrying a `setAttribute` edit the source-line pass could apply. */
  readonly attribute: ReadonlySet<number>;
  /** Hosts carrying a georeferencing edit queued as named attributes. */
  readonly georeferencing: ReadonlySet<number>;
}

/**
 * Nominate the named-attribute kinds a rewritten SOURCE LINE actually
 * delivered for `entityId`.
 *
 * Call this wherever a full export writes a rewritten source line — the
 * source-iteration pass, and the type-object `HasPropertySets` rewrite that
 * REPLACES it for the hosts that pass skips. Per site, not per feature: a host
 * whose line only ever comes out of the rewrite path would otherwise stop
 * counting a rename that genuinely landed.
 *
 * `retype` and `positional` are not here. They are nominated inline by the pass
 * that measures them and have never had an earlier intent site to move.
 */
export function nominateDeliveredInPlaceEdits(
  ledger: ModificationLedger,
  entityId: number,
  mutated: SourceLineDelivery,
  nominees: InPlaceNominees,
): void {
  // The one gate: a line the named-attribute write left byte-identical carries
  // no modification, whether the edit was a no-op value or a discarded name.
  if (!mutated.attributed) return;
  if (nominees.attribute.has(entityId)) ledger.nominate(entityId, 'attribute');
  if (nominees.georeferencing.has(entityId)) ledger.nominate(entityId, 'georeferencing');
}
