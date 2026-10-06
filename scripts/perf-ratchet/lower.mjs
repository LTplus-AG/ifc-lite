/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lowering, the only automatic way a ceiling moves (#6959). Given a family's
 * ceilings and a measurement of `main`, return the ceilings with every entry
 * that `shouldLower` admits rewritten DOWN to the measured value and its
 * provenance re-stamped with the measured commit.
 *
 * It never raises. That is structural rather than a convention: an entry is
 * only rewritten when `shouldLower` says the value is strictly below the
 * ceiling, and the result is re-checked before it is returned, so a bug in
 * either rule throws instead of writing a higher ceiling. Raising a ceiling is
 * a human PR with a justification (docs/guide/performance.md), never this job.
 *
 * It never adds or removes entries either: a measured id with no ceiling, or a
 * ceiling with no measurement, is left exactly as it was for `check` to fail.
 */

import { shouldLower, relativeDelta } from './compare.mjs';

/**
 * @param {{ family: string, entries: Array<object> }} ceilings validated ceiling file
 * @param {{ family: string, commit: string, measuredAt: string, metrics: Array<{ id: string, value: number }> }} measured
 * @returns {{ next: object, changes: Array<{ id: string, unit?: string, from: number, to: number, delta: number }> }}
 */
export function lowerFamily(ceilings, measured) {
  if (ceilings.family !== measured.family) {
    throw new Error(`family mismatch: ceilings are \`${ceilings.family}\`, measurement is \`${measured.family}\``);
  }
  const values = new Map(measured.metrics.map((m) => [m.id, m.value]));
  const changes = [];
  const entries = ceilings.entries.map((entry) => {
    const value = values.get(entry.id);
    if (value === undefined || !shouldLower(entry, value)) return entry;
    changes.push({ id: entry.id, unit: entry.unit, from: entry.ceiling, to: value, delta: relativeDelta(value, entry.ceiling) });
    return { ...entry, ceiling: value, provenance: { commit: measured.commit, measuredAt: measured.measuredAt } };
  });
  ceilings.entries.forEach((before, i) => {
    if (entries[i].ceiling > before.ceiling) {
      throw new Error(`refusing to raise ${ceilings.family}/${before.id} from ${before.ceiling} to ${entries[i].ceiling}`);
    }
  });
  return { next: { ...ceilings, entries }, changes };
}

function fmt(n) {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : String(n);
}

/**
 * Markdown changelog for one lowering run: one bullet per changed metric
 * (old -> new), which is the record #6955 asks every lowering PR to carry.
 *
 * @param {Array<{ family: string, changes: Array<object> }>} families
 * @param {{ commit: string }} source
 */
export function formatChangelog(families, source) {
  const lines = [];
  for (const { family, changes } of families) {
    for (const c of changes) {
      const pct = (c.delta * 100).toFixed(2);
      lines.push(`- \`${family}/${c.id}\`: ${fmt(c.from)} -> ${fmt(c.to)}${c.unit ? ` ${c.unit}` : ''} (${pct}%)`);
    }
  }
  if (lines.length === 0) return `No ceiling lowered: nothing measured at \`${source.commit}\` cleared its band.\n`;
  return `Ceilings lowered to the values measured on \`main\` at \`${source.commit}\`:\n\n${lines.join('\n')}\n`;
}
