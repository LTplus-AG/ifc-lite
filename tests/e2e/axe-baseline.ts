/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * axe-core scan with a committed baseline of known violations (#5607).
 *
 * The viewer ships with accessibility violations today (no `main` landmark,
 * no `h1`, ...). Failing on all of them would be a big-bang fix; ignoring
 * them lets the list grow. So each scanned screen state has a row in
 * `viewer-smoke.axe-baseline.json` listing the axe rules it violates, and
 * the scan is compared with `scripts/lib/count-ratchet.mjs`, the same
 * two-way comparison the jsx-a11y lint ratchet uses: a newly violated rule
 * fails, and a rule no longer violated fails until its entry is removed, so
 * the baseline cannot keep slack for the next regression to spend.
 *
 * The ratchet is per RULE, not per violating node. Node counts follow how
 * much UI happens to be on screen, not how many defects there are: `region`
 * flags every block outside a landmark, and on CI's software WebGPU a lost
 * device changes what renders, so the loaded view measured 65 nodes locally
 * in every run and 66 on CI for the same commit. Per-file counts are the
 * jsx-a11y lint ratchet's job (scripts/check-jsx-a11y.mjs), which reads
 * source and cannot vary with runtime state.
 *
 * Re-record after a deliberate change with `AXE_BASELINE_UPDATE=1` on the
 * smoke run; the file is rewritten with the rules measured.
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
 * software WebGPU it fills with "graphics device was lost" notices, and
 * whether any is on screen at scan time is timing, so its unnamed close
 * buttons made `button-name` come and go across identical runs. The smoke
 * already treats those device errors as runner noise (`E2E_GPU_STRICT=0`).
 */
const TOAST_STACK = '[role="status"][aria-live="polite"].fixed.bottom-4.right-4';

export interface AxeBaselineResult {
  /** Human-readable failure, or null when the scan matches its baseline row. */
  failure: string | null;
  /** Violated rule ids, sorted. */
  rules: string[];
}

/** `null` when the file is absent: only a re-record may start from nothing. */
function readBaseline(): Record<string, string[]> | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, string[]>;
}

/** A rule set as the `{ key: count }` shape count-ratchet compares. */
const asCounts = (rules: string[]): Record<string, number> => Object.fromEntries(rules.map((r) => [r, 1]));

/** Scan the page and compare with the baseline row for `state`. */
export async function checkAxeBaseline(page: Page, state: string): Promise<AxeBaselineResult> {
  const results = await new AxeBuilder({ page }).exclude(TOAST_STACK).analyze();
  const violations = [...results.violations].sort((a, b) => a.id.localeCompare(b.id));
  const rules = violations.map((v) => v.id);
  const detail = new Map(violations.map((v) => [
    v.id,
    `${v.help} (${v.impact ?? 'n/a'}, ${v.nodes.length} node(s))\n` +
      v.nodes.slice(0, 5).map((n) => `      ${n.target.join(' ')}`).join('\n'),
  ]));

  const baseline = readBaseline();
  if (process.env.AXE_BASELINE_UPDATE === '1') {
    const next = { ...baseline, [state]: rules };
    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`[e2e] axe baseline for "${state}" re-recorded: ${rules.join(', ')}`);
    return { failure: null, rules };
  }

  // A missing file or row is not an empty allowance: it would read a scan
  // nobody recorded as clean, so it fails like any other mismatch.
  const row = baseline?.[state];
  if (row === undefined) {
    return {
      failure: `no axe baseline row for "${state}" in tests/e2e/viewer-smoke.axe-baseline.json. ` +
        'Record one with AXE_BASELINE_UPDATE=1.',
      rules,
    };
  }
  const { regressions, improvements } = compareToBaseline(asCounts(rules), asCounts(row));
  const lines = [
    ...regressions.map(({ key }) => `  NEW   ${key}: ${detail.get(key) ?? ''}`),
    ...improvements.map(({ key }) => `  FIXED ${key}: no longer violated - remove it from the baseline`),
  ];
  const failure = lines.length === 0
    ? null
    : `axe scan of "${state}" differs from tests/e2e/viewer-smoke.axe-baseline.json:\n${lines.join('\n')}\n` +
      'Fix new violations. For fixed ones (or a deliberate change) re-record with AXE_BASELINE_UPDATE=1.';
  return { failure, rules };
}
