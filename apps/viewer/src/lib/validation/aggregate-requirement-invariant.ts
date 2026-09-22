/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one invariant an `aggregate` `Requirement` must satisfy regardless of
 * which authoring path produced it (#5182) — the JSON parser
 * (`rule-set-io-requirement.ts`) and the text parser (`requirement-text.ts`)
 * both build an `AggregateRequirement` from user input and must refuse the
 * same shapes before `rule-engine-sets.ts` ever sees them, or the text path
 * accepts what the JSON path rejects and the difference only shows up as a
 * `TypeError` at evaluation time.
 *
 * This returns a plain message (no `where`/position prefix) rather than
 * throwing, so each caller can wrap it in its own error type and phrasing:
 * the JSON path's `fail()` wants a `${where}: ` prefix, the text path's
 * `TextError` wants none. A shared thrower would force one of those shapes
 * on the other.
 */
import type { AggregateRequirement, Subject } from './rule-set.js';
import { isSingleValuedSubject } from './rule-set-io-subject.js';

/** Checks the two invariants the plan §3 aggregate requirement must
 *  satisfy: a subject is required unless `fn` is `count`, and a present
 *  subject must be single-valued unless `fn` is `count`. Returns the
 *  violation message, or `undefined` if `subject` is acceptable for `fn`. */
export function checkAggregateSubject(fn: AggregateRequirement['fn'], subject: Subject | undefined): string | undefined {
  if (subject === undefined) {
    if (fn !== 'count') return `"subject" is required unless fn is "count"`;
    return undefined;
  }
  if (fn !== 'count' && !isSingleValuedSubject(subject)) {
    return `"${fn}" needs a single-valued subject, "${subject.kind}" is multi-valued`;
  }
  return undefined;
}
