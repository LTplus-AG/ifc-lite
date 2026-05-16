/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SDK-update revalidation flow.
 *
 * When the host detects that the installed SDK version has changed,
 * it runs every affected extension's declared tests against the new
 * runtime. The output is a queue of repair items: extensions whose
 * tests pass remain healthy; failures land in the repair queue for
 * the user to authorise an AI-assisted fix.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §5.
 */

import type { Bundle, Capability } from '../types.js';
import type { ExtensionRuntime } from './runtime.js';
import { runBundleTests, type TestRunSummary } from '../testing/runner.js';
import {
  evaluateCompatibility,
  findAffected,
  type CompatibilityResult,
  type InstalledForCompatCheck,
} from './sdk-version.js';

export interface RevalidationItem {
  extensionId: string;
  compatibility: CompatibilityResult;
  tests?: TestRunSummary;
  outcome: 'pass' | 'fail' | 'skipped';
  reason?: string;
}

export interface RevalidationSummary {
  sdk: string;
  items: RevalidationItem[];
  /** Items the repair UI should surface. */
  needsRepair: RevalidationItem[];
}

export interface RevalidateOptions {
  /** SDK version we're moving TO. */
  sdk: string;
  /** Installed records to evaluate. */
  installed: readonly (InstalledForCompatCheck & { grants: readonly Capability[] })[];
  /** Resolve an installed extension's bundle. Return undefined to skip. */
  resolveBundle: (extensionId: string) => Bundle | undefined;
  runtime: ExtensionRuntime;
  /**
   * Optional fixture resolver passed through to the test runner so
   * tests that depend on a fixture run against real model data.
   */
  loadFixture?: (name: string) => Promise<unknown>;
}

/**
 * Walk every installed extension, evaluate engine-range compatibility,
 * and (for non-compatible rows) run the manifest tests. Compatible
 * extensions are still recorded with `outcome: 'pass'` so the UI can
 * show a "skipped — still compatible" line.
 */
export async function revalidateAgainstSdk(
  opts: RevalidateOptions,
): Promise<RevalidationSummary> {
  const compat = findAffected(opts.installed, opts.sdk);
  const items: RevalidationItem[] = [];

  for (const result of compat) {
    const installed = opts.installed.find((i) => i.id === result.extensionId);
    if (!installed) continue;

    if (result.status === 'compatible') {
      items.push({
        extensionId: result.extensionId,
        compatibility: result,
        outcome: 'pass',
        reason: 'Engine range still matches; skipped test run.',
      });
      continue;
    }

    const bundle = opts.resolveBundle(result.extensionId);
    if (!bundle) {
      items.push({
        extensionId: result.extensionId,
        compatibility: result,
        outcome: 'skipped',
        reason: 'Bundle bytes not available.',
      });
      continue;
    }
    if (!bundle.manifest.tests || bundle.manifest.tests.length === 0) {
      items.push({
        extensionId: result.extensionId,
        compatibility: result,
        outcome: 'skipped',
        reason: 'Manifest declares no tests; cannot self-verify.',
      });
      continue;
    }

    const summary = await runBundleTests({
      runtime: opts.runtime,
      bundle,
      grants: installed.grants,
      loadFixture: opts.loadFixture,
    });
    items.push({
      extensionId: result.extensionId,
      compatibility: result,
      tests: summary,
      outcome: summary.failed === 0 ? 'pass' : 'fail',
    });
  }

  const needsRepair = items.filter((i) => i.outcome === 'fail' || (i.outcome === 'skipped' && i.compatibility.status === 'outdated'));
  return { sdk: opts.sdk, items, needsRepair };
}

export { evaluateCompatibility };
