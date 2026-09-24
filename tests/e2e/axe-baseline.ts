/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * axe-core scan with a committed baseline of known violations (#5607).
 *
 * The viewer ships with accessibility violations today (unnamed icon
 * buttons, no `main` landmark, ...). Failing on all of them would be a
 * big-bang fix; ignoring them lets the count grow. So each scanned screen
 * state has a row in `viewer-smoke.axe-baseline.json` mapping an axe rule id
 * to its violating-node count, and the scan is compared with
 * `scripts/lib/count-ratchet.mjs`, the same two-way comparison the jsx-a11y
 * lint ratchet uses: a new violation (or more nodes for a known rule) fails,
 * and a fixed one fails until its row is lowered, so the baseline cannot
 * keep slack for the next regression to spend.
 *
 * Re-record after a deliberate change with `AXE_BASELINE_UPDATE=1` on the
 * smoke run; the file is rewritten with the measured counts.
 */

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareToBaseline } from '../../scripts/lib/count-ratchet.mjs';

const BASELINE_PATH = join(process.cwd(), 'tests', 'e2e', 'viewer-smoke.axe-baseline.json');

/**
 * The toast stack (`apps/viewer/src/components/ui/toast.tsx`) is left out of
 * the scan. Its contents are transient and environment-dependent: under
 * software WebGPU it fills with "graphics device was lost" notices whose
 * number depends on timing, so its unnamed close buttons made `button-name`
 * range from 0 to 14 nodes across identical runs. The smoke already treats
 * those device errors as runner noise (`E2E_GPU_STRICT=0`); a baseline that
 * counted them would fail at random.
 */
const TOAST_STACK = '[role="status"][aria-live="polite"].fixed.bottom-4.right-4';

type Counts = Record<string, number>;

export interface AxeBaselineResult {
  /** Human-readable failure, or null when the scan matches its baseline row. */
  failure: string | null;
  counts: Counts;
}

function readBaseline(): Record<string, Counts> {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, Counts>;
}

/** Scan the page and compare with the baseline row for `state`. */
export async function checkAxeBaseline(page: Page, state: string): Promise<AxeBaselineResult> {
  const results = await new AxeBuilder({ page }).exclude(TOAST_STACK).analyze();
  const counts: Counts = {};
  const detail = new Map<string, string>();
  for (const v of [...results.violations].sort((a, b) => a.id.localeCompare(b.id))) {
    counts[v.id] = v.nodes.length;
    const targets = v.nodes.slice(0, 5).map((n) => `      ${n.target.join(' ')}`).join('\n');
    detail.set(v.id, `${v.help} (${v.impact ?? 'n/a'})\n${targets}`);
  }

  const baseline = readBaseline();
  if (process.env.AXE_BASELINE_UPDATE === '1') {
    baseline[state] = counts;
    const sorted = Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`[e2e] axe baseline for "${state}" re-recorded: ${JSON.stringify(counts)}`);
    return { failure: null, counts };
  }

  const { regressions, improvements } = compareToBaseline(counts, baseline[state] ?? {});
  const lines: string[] = [];
  for (const { key, count, allowed } of regressions) {
    lines.push(`  NEW  ${key}: ${count} node(s), baseline ${allowed} - ${detail.get(key) ?? ''}`);
  }
  for (const { key, count, allowed } of improvements) {
    lines.push(`  FIXED ${key}: ${count} node(s), baseline ${allowed} - lower its row in the baseline`);
  }
  const failure = lines.length === 0
    ? null
    : `axe scan of "${state}" differs from tests/e2e/viewer-smoke.axe-baseline.json:\n${lines.join('\n')}\n` +
      'Fix new violations. For fixed ones (or a deliberate change) re-record with AXE_BASELINE_UPDATE=1.';
  return { failure, counts };
}
