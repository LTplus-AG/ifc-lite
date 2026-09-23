/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The built-in example graphs, ordered simplest first.
 *
 * They are real `*.flow.json` files under `./examples/`, imported as raw
 * text so that what the panel opens is byte-for-byte what `ifc-lite flow
 * run` executes — the same trick the script templates use, for the same
 * reason: an example that is a TypeScript literal drifts from the format
 * it claims to demonstrate. `examples.test.ts` parses, validates and wires
 * every one of them against the standard registry, and the CLI's
 * `flow.test.ts` runs all of them against a real model.
 *
 * Opening an example makes a *copy*: it lands in the saved graphs under a
 * fresh id, so editing one cannot corrupt the library, and the original
 * can be opened again from the same menu.
 */

import { parseFlowDocument, type FlowDocument } from '@ifc-lite/flow';
import countElements from './examples/01-count-elements.flow.json?raw';
import highlightExternal from './examples/02-highlight-external.flow.json?raw';
import quantityTakeoff from './examples/03-quantity-takeoff.flow.json?raw';
import elementsPerStorey from './examples/04-elements-per-storey.flow.json?raw';
import fireRatingAudit from './examples/05-fire-rating-audit.flow.json?raw';
import namingAudit from './examples/06-naming-audit.flow.json?raw';
import rankByQuantity from './examples/07-rank-by-quantity.flow.json?raw';
import columnGrid from './examples/08-column-grid.flow.json?raw';

const SOURCES: readonly string[] = [
  countElements,
  highlightExternal,
  quantityTakeoff,
  elementsPerStorey,
  fireRatingAudit,
  namingAudit,
  rankByQuantity,
  columnGrid,
];

let parsed: readonly FlowDocument[] | undefined;

/**
 * Parsed once per page. A malformed example is a build-time mistake, not a
 * user input, so `parseFlowDocument` is allowed to throw: `examples.test.ts`
 * is what keeps that from reaching a release.
 */
export function flowExamples(): readonly FlowDocument[] {
  parsed ??= SOURCES.map(parseFlowDocument);
  return parsed;
}
