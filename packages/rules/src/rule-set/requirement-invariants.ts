/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The subject invariants a `Requirement` must satisfy whichever authoring
 * path produced it (#5182). The JSON parser (`rule-set-io-requirement.ts`)
 * and the text parser (`requirement-text.ts`) both build requirements from
 * user input and must refuse the same shapes before `rule-engine-sets.ts`
 * sees them. Otherwise the text path accepts what the JSON path rejects, and
 * the difference only shows up at evaluation time.
 *
 * Each check returns a plain message (no `where`/position prefix) rather than
 * throwing, so each caller wraps it in its own error type: the JSON path's
 * `fail()` wants a `${where}: ` prefix, the text path's `TextError` wants
 * none.
 */
import type { AggregateRequirement, Subject } from './rule-set.js';
import { isSingleValuedSubject } from './rule-set-io-subject.js';

/** An `aggregate` needs a subject unless `fn` is `count`, and a numeric `fn`
 *  needs a single-valued one: summing a list of material names has no
 *  numeric meaning. Returns the violation, or `undefined`. */
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

/** Both sides of a `compare` must be single-valued. Returns the first
 *  offending side and its message, or `undefined`. */
export function checkCompareSubjects(
  left: Subject,
  right: Subject,
): { side: 'left' | 'right'; message: string } | undefined {
  for (const [side, subject] of [['left', left], ['right', right]] as const) {
    if (!isSingleValuedSubject(subject)) {
      return { side, message: `"compare" needs a single-valued subject, "${subject.kind}" is multi-valued` };
    }
  }
  return undefined;
}
