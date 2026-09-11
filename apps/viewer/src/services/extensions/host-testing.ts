/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manifest-test execution for `ExtensionHostService`: "Run tests" in
 * ExtensionsPanel (`runInstalledExtensionTests`) and the repair queue's
 * "Run check" / "Re-run" (`revalidateInstalledForSdk`). Both funnel through
 * `runBundleTests`, with the host's regex evaluator plugged in as
 * `evaluateRegex` (#4482 — see `host-regex.ts`). Split out of `host.ts` the
 * way `host-commands.ts`/`host-exporters.ts` are, so the host stays within
 * its module-size budget.
 */

import {
  CANONICAL_FIXTURES,
  parseCapabilities,
  revalidateAgainstSdk,
  runBundleTests,
  syntheticFixtureLoader,
  type ExtensionLoader,
  type ExtensionRuntime,
  type RegexEvaluator,
  type RevalidationSummary,
  type TestRunSummary,
} from '@ifc-lite/extensions';
import type { IdbExtensionStorage } from './idb-storage.js';

export interface ExtensionTestingDeps {
  storage: Pick<IdbExtensionStorage, 'getExtension' | 'listExtensions'>;
  loader: Pick<ExtensionLoader, 'getBundle'>;
  runtime: ExtensionRuntime;
  evaluateRegex: RegexEvaluator;
}

/**
 * Run an installed extension's declared tests against its bundle.
 * Throws if the extension is not installed or its bundle is missing.
 */
export async function runInstalledExtensionTests(
  deps: ExtensionTestingDeps,
  id: string,
): Promise<TestRunSummary> {
  const record = await deps.storage.getExtension(id);
  if (!record) throw new Error(`No installed extension with id "${id}".`);
  const bundle = deps.loader.getBundle(id);
  if (!bundle) throw new Error(`Bundle for ${id} not loaded.`);
  const grants = parseCapabilities(record.grantedCapabilities);
  if (!grants.ok) {
    throw new Error(`Stored capabilities for ${id} are invalid.`);
  }
  return runBundleTests({
    runtime: deps.runtime,
    bundle,
    grants: grants.value,
    // Plug the canonical synthetic fixtures so tests declaring
    // `fixture: "residential-small"` get a working ctx.bim. Hosts
    // that ship their own fixture loader can override via a
    // custom factory.
    loadFixture: syntheticFixtureLoader(CANONICAL_FIXTURES),
    evaluateRegex: deps.evaluateRegex,
  });
}

/**
 * Re-run every installed extension's tests against the supplied SDK
 * version. The result feeds the repair queue UI: outdated or
 * permissive ranges with failing tests land in `needsRepair`.
 */
export async function revalidateInstalledForSdk(
  deps: ExtensionTestingDeps,
  sdkVersion: string,
): Promise<RevalidationSummary> {
  const records = await deps.storage.listExtensions();
  const installed = records.map((rec) => {
    const grants = parseCapabilities(rec.grantedCapabilities);
    const bundle = deps.loader.getBundle(rec.id);
    return {
      id: rec.id,
      engines: { ifcLiteSdk: bundle?.manifest.engines.ifcLiteSdk ?? '*' },
      grants: grants.ok ? grants.value : [],
    };
  });
  return revalidateAgainstSdk({
    sdk: sdkVersion,
    installed,
    resolveBundle: (id) => deps.loader.getBundle(id),
    runtime: deps.runtime,
    evaluateRegex: deps.evaluateRegex,
  });
}
