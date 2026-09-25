/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * axe-core scan with a committed baseline of known violations (#5607).
 *
 * The viewer ships with accessibility violations today (no `main` landmark,
 * no `h1`, ...). Failing on all of them would be a big-bang fix; ignoring
 * them lets them grow. So each scanned screen state has a row in
 * `viewer-smoke.axe-baseline.json` mapping an axe rule id to its violating-
 * node count, compared with `compareToBaselineRow` from
 * `scripts/lib/count-ratchet.mjs` (unit-tested there): a new violation, of a
 * new rule or one more node of a known rule, fails; a fixed one fails until
 * its row is lowered; a missing file or row fails rather than reading as an
 * empty allowance.
 *
 * `region` alone is counted as present/absent (1), not by node. It flags
 * every block outside a landmark, so its node count follows how much UI is on
 * screen, not how many defects there are: the loaded view measured 65 nodes
 * locally in every run and 66 on CI's software WebGPU for the same commit,
 * while every other rule's count matched. Its defect is "no landmarks", which
 * presence captures.
 *
 * Re-record after a deliberate change with `AXE_BASELINE_UPDATE=1`; a
 * re-record that would RAISE a row also needs `AXE_BASELINE_ALLOW_RAISE=1`,
 * the same guard as `--allow-raise` on scripts/check-jsx-a11y.mjs.
 */

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareToBaseline, compareToBaselineRow } from '../../scripts/lib/count-ratchet.mjs';

const BASELINE_PATH = join(process.cwd(), 'tests', 'e2e', 'viewer-smoke.axe-baseline.json');
const BASELINE_REL = 'tests/e2e/viewer-smoke.axe-baseline.json';

/** Rules whose node count measures layout, not defects: counted as present (1). */
const PRESENCE_ONLY_RULES = new Set(['region']);

type Counts = Record<string, number>;

export interface AxeBaselineResult {
  /** Human-readable failure, or null when the scan matches its baseline row. */
  failure: string | null;
  counts: Counts;
}

/** `null` when the file is absent: only a re-record may start from nothing. */
function readBaseline(): Record<string, Counts> | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, Counts>;
}

/** Scan the page and compare with the baseline row for `state`. */
export async function checkAxeBaseline(page: Page, state: string): Promise<AxeBaselineResult> {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = [...results.violations].sort((a, b) => a.id.localeCompare(b.id));
  const counts: Counts = Object.fromEntries(
    violations.map((v) => [v.id, PRESENCE_ONLY_RULES.has(v.id) ? 1 : v.nodes.length]),
  );
  const detail = new Map(violations.map((v) => [
    v.id,
    `${v.help} (${v.impact ?? 'n/a'}, ${v.nodes.length} node(s))\n` +
      v.nodes.slice(0, 5).map((n) => `      ${n.target.join(' ')}`).join('\n'),
  ]));

  const baseline = readBaseline();
  if (process.env.AXE_BASELINE_UPDATE === '1') {
    const raised = compareToBaseline(counts, baseline?.[state] ?? {}).regressions;
    if (raised.length > 0 && process.env.AXE_BASELINE_ALLOW_RAISE !== '1') {
      return {
        failure: `refusing to raise the axe baseline for "${state}" (${raised
          .map(({ key, allowed, count }) => `${key}: ${allowed} -> ${count}`)
          .join(', ')}). Fix the violations, or re-run with AXE_BASELINE_ALLOW_RAISE=1 if the increase is deliberate. Nothing was written.`,
        counts,
      };
    }
    const next = { ...baseline, [state]: counts };
    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`[e2e] axe baseline for "${state}" re-recorded: ${JSON.stringify(counts)}`);
    return { failure: null, counts };
  }

  const cmp = compareToBaselineRow(counts, baseline, state);
  if (cmp.missing) {
    return {
      failure: `no axe baseline row for "${state}" in ${BASELINE_REL}. Record one with AXE_BASELINE_UPDATE=1.`,
      counts,
    };
  }
  const lines = [
    ...cmp.regressions.map(({ key, count, allowed }) => `  NEW   ${key}: ${count}, baseline ${allowed} - ${detail.get(key) ?? ''}`),
    ...cmp.improvements.map(({ key, count, allowed }) => `  FIXED ${key}: ${count}, baseline ${allowed} - lower its row in the baseline`),
  ];
  const failure = lines.length === 0
    ? null
    : `axe scan of "${state}" differs from ${BASELINE_REL}:\n${lines.join('\n')}\n` +
      'Fix new violations. For fixed ones (or a deliberate change) re-record with AXE_BASELINE_UPDATE=1.';
  return { failure, counts };
}
