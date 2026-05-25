/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Eval harness skeleton.
 *
 * Phase 0 deliverable. Today the harness:
 *   - Loads a bundle from disk.
 *   - Runs the static validator chain.
 *   - Records structured pass/fail per bundle.
 *
 * Phase 2 will extend the harness to:
 *   - Spin up a QuickJS sandbox with declared capabilities.
 *   - Execute the manifest's tests against fixtures.
 *   - Feed failures into the repair loop.
 *
 * The harness is exported so the future LLM-driven repair pipeline can
 * call it without re-implementing the validate-then-execute scaffolding.
 */

import { loadBundleFromDirectory } from '../../src/bundle/loader-node.js';
import type { ValidationError } from '../../src/types.js';

export interface EvalResult {
  bundlePath: string;
  passed: boolean;
  errors: ValidationError[];
}

export async function evalBundle(bundlePath: string): Promise<EvalResult> {
  const result = await loadBundleFromDirectory(bundlePath);
  if (result.ok) {
    return { bundlePath, passed: true, errors: [] };
  }
  return { bundlePath, passed: false, errors: result.errors };
}

export async function evalBundles(bundlePaths: readonly string[]): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const path of bundlePaths) {
    out.push(await evalBundle(path));
  }
  return out;
}

/** Human-readable summary used by CI scripts. */
export function summariseEvalResults(results: readonly EvalResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const lines: string[] = [`${passed}/${results.length} bundles passed`];
  for (const r of results) {
    if (r.passed) {
      lines.push(`  ✓ ${r.bundlePath}`);
    } else {
      lines.push(`  ✗ ${r.bundlePath}`);
      for (const err of r.errors) {
        lines.push(`      ${err.path || '<root>'}: ${err.message}`);
      }
    }
  }
  return `${lines.join('\n')}\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`}\n`;
}
