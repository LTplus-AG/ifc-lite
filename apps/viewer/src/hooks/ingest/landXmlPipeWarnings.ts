/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LandXmlTinDocument } from './landXmlSemantics.js';

const MAX_PIPE_REFUSAL_WARNINGS = 1_000;

/** Preserve bounded parser diagnostics so a refused pipe is explainable in the UI. */
export function pipeRefusalWarnings(document: LandXmlTinDocument): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const refusal of document.pipeNetworks?.refusals ?? []) {
    const warning = `LandXML pipe refusal ${refusal.code} at ${refusal.sourcePath} (${refusal.sourceId}): ${refusal.message}`;
    if (seen.has(warning)) continue;
    seen.add(warning);
    warnings.push(warning);
    if (warnings.length === MAX_PIPE_REFUSAL_WARNINGS) break;
  }
  return warnings;
}
