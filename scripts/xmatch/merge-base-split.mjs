/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The base-side half of the `merged` mutation (issue #4989): the honest
 * inverse of `splitLength`. Split out of `mutate.mjs` for the module-size
 * house rule (AGENTS.md); the ONE caller there has the full story on why the
 * base file needs touching at all (it normally never does).
 */

import { indexModel } from './edits.mjs';
import { splitElementLength } from './rectangle-edits.mjs';
import { rng } from './mutate-support.mjs';
import { parseStepFile, quote, serializeStepFile, setArg } from './step-file.mjs';
import { generateIfcGuid } from '../../packages/encoding/dist/index.js';

/**
 * Split every `mergedPrimaries` element into two real base-side halves —
 * `splitElementLength`, the SAME construction `splitLength` uses on the
 * HEAD, applied here to a fresh parse of the pristine text so the normal
 * base (fingerprinted straight off disk for every other model) stays
 * untouched except for exactly the elements `merged` named. The primary's
 * own id becomes one half (edited in place, own GlobalId kept — nothing
 * here goes through the head's `reguidAll`); a NEW clone becomes the other,
 * with its own fresh GlobalId (`cloneElement` copies the source's verbatim,
 * so this is the one thing the caller must mint itself). Both real elements
 * tile the primary's UNEDITED, full-length HEAD shape exactly — the
 * engine's verified merge case (containment + volume sum), not a
 * coincidence of adjacency scanning.
 *
 * @param text            pristine source STEP text (never mutated)
 * @param mergedPrimaries express ids `mutate.mjs` assigned the `merged` role
 * @param seed            the model's seed, for a PRNG stream of its own —
 *                        never the caller's `random`: drawing from it here
 *                        would perturb the move/reshape/permutation streams
 *                        downstream, which `swapped`'s donor choice is
 *                        already documented as staying immune to.
 * @param freshName       `mutate.mjs`'s name generator, shared so no name
 *                        this call mints collides with one on the HEAD side
 * @param classes         id → geometry class, for the two new `key.elements`
 *                        rows per pair (the clone has no independently
 *                        computed class; it shares the primary's, honestly —
 *                        same shape family, just resized)
 * @returns `{ baseText, mergedEntries }`. `baseText` is `text` verbatim when
 *          `mergedPrimaries` is empty; `mergedEntries` is `[]` then too.
 */
export function splitBaseForMerge(text, mergedPrimaries, seed, freshName, classes) {
  if (mergedPrimaries.length === 0) return { baseText: text, mergedEntries: [] };

  const baseFile = parseStepFile(text);
  const baseIndex = indexModel(baseFile);
  const baseGuidRandom = rng(seed ^ 0x4d455247); // 'MERG'
  const mergedEntries = [];

  for (const primaryId of mergedPrimaries) {
    const cloneId = splitElementLength(baseFile, baseIndex, primaryId, [
      freshName('merged-base-a'),
      freshName('merged-base-b'),
    ]);
    if (cloneId === undefined) {
      // Eligibility (`ownsRectangle`) was checked, off this same pristine
      // text, before the role was assigned — this should not happen; if it
      // ever does, the pair is silently not merged rather than the key
      // describing a base split that never occurred.
      continue;
    }
    const clone = baseIndex.byId.get(cloneId);
    clone.args = setArg(clone, 0, quote(generateIfcGuid(baseGuidRandom))).args;
    const geometryClass = classes.get(primaryId);
    mergedEntries.push({ base: primaryId, kind: 'merged', class: geometryClass, head: [primaryId] });
    mergedEntries.push({ base: cloneId, kind: 'merged', class: geometryClass, head: [primaryId] });
  }

  return { baseText: serializeStepFile(baseFile), mergedEntries };
}
