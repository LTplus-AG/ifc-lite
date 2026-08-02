/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Command-dispatch helpers extracted from `host.ts`.
 *
 * `runExtensionCommand` resolves the named extension, activates it, fires
 * the matching `onCommand:<id>` event, loads the handler source, wraps it
 * via `wrapEntrySource`, and runs the entry inside the activation's
 * sandbox. Throws if that extension does not own an enabled command with
 * that id, or the bundle is missing the entry path.
 *
 * Factored out so `ExtensionHostService` stays focused on lifecycle.
 */

import {
  parseCapabilities,
  wrapEntrySource,
  type ActivationDispatcher,
  type ExtensionContextV1,
  type ExtensionLoader,
  type ExtensionRuntime,
  type RuntimeRunResult,
} from '@ifc-lite/extensions';
import type { IdbExtensionStorage } from './idb-storage.js';

/**
 * Structural picks, not the full classes, matching `RunExporterDeps` in
 * `host-exporters.ts`: `ExtensionLoader` carries a private `bundleCache`
 * field, which makes a plain object literal (as every test fixture is)
 * structurally incompatible with it — the object literal has no private
 * member to match against. Picking only the methods this module actually
 * calls keeps `RunCommandDeps` satisfiable by a fixture without a cast,
 * while `ExtensionHostService.runCommand` still passes its full
 * `storage`/`loader`/`runtime`/`dispatcher` instances unchanged (a wider
 * type is always assignable to a narrower structural pick).
 */
export interface RunCommandDeps {
  storage: Pick<IdbExtensionStorage, 'listExtensions'>;
  loader: Pick<ExtensionLoader, 'getBundle'>;
  runtime: Pick<ExtensionRuntime, 'activate' | 'deactivate'>;
  dispatcher: Pick<ActivationDispatcher, 'fire'>;
  /**
   * Typed as `ExtensionContextV1['bim']` (currently `unknown`), not
   * `BimContext`: this module never calls a `BimContext` method, it only
   * forwards the value into `ExtensionContextV1.bim` for the sandboxed
   * handler to use. `BimContext` would overstate the contract and force
   * every fixture to satisfy a surface this code never touches.
   */
  sdk: ExtensionContextV1['bim'];
}

/**
 * Dispatch an extension command end-to-end. Pure function — no
 * `this`. Callers (host service) inject the dependencies.
 *
 * `extensionId` pins the run to a specific contributing extension and is
 * required. Command ids are namespaced only BY CONVENTION — the manifest
 * validator (`packages/extensions/src/manifest/contributions.ts`) checks
 * that `contributes.commands[].id` is a string and nothing more, and no
 * install-time check rejects an id another installed extension already
 * declares. Without the owner id this function ran the FIRST enabled
 * extension in storage order that declared the id, so a second extension
 * declaring a popular id could serve someone else's toolbar button,
 * context-menu item or palette entry. Same defect class as
 * `runExtensionExporter` (#1930); every call site already has the owning
 * `SlotContribution.extensionId` in scope, so making the parameter
 * required closes off the unscoped scan entirely rather than merely
 * leaving it unused.
 *
 * Note this is NOT the `command.invoke:<id-pattern>` capability from the
 * capability catalogue (`packages/extensions/src/capability/catalogue.ts`,
 * spec `docs/architecture/ai-customization/02-security.md` §3.1). That
 * capability is declared and parseable but nothing in this tree consults
 * it — `host/permissions.ts` records it as "handled by host dispatcher"
 * and the dispatcher has no such check. Cross-extension invocation stays
 * out of reach here until that grant is actually enforced.
 */
export async function runExtensionCommand(
  deps: RunCommandDeps,
  commandId: string,
  extensionId: string,
): Promise<RuntimeRunResult | undefined> {
  const records = await deps.storage.listExtensions();
  for (const record of records) {
    if (record.id !== extensionId) continue;
    if (!record.enabled) continue;
    const bundle = deps.loader.getBundle(record.id);
    if (!bundle) continue;
    const entry = bundle.manifest.entry.commands?.[commandId];
    const declared = bundle.manifest.contributes?.commands?.some((c) => c.id === commandId);
    if (!entry || !declared) continue;

    const grantsResult = parseCapabilities(record.grantedCapabilities);
    if (!grantsResult.ok) {
      throw new Error(`Cannot run ${commandId}: stored capabilities for ${record.id} are invalid.`);
    }
    const grants = grantsResult.value;

    const file = bundle.files.get(entry);
    if (!file) {
      throw new Error(`Command handler "${entry}" missing from bundle ${record.id}.`);
    }
    const source = file.text ?? new TextDecoder().decode(file.bytes);
    const wrapResult = wrapEntrySource(source, {
      entryFnName: 'run',
      filename: entry,
    });
    if (!wrapResult.ok) {
      throw new Error(
        `Failed to prepare command "${commandId}": ${wrapResult.errors[0]?.message ?? 'wrap error'}`,
      );
    }
    const wrappedSource = wrapResult.value;

    // Reuse the cached activation across runs — that is the behaviour
    // command tools shipped with originally and it works. Forcing a
    // brand-new sandbox per run (an earlier experiment) regressed it:
    // the dispose→recreate cycle is what surfaced "Lifetime not alive".
    // The single retry below is kept purely as a safety net for a
    // genuinely dead sandbox; it does NOT pre-emptively tear anything
    // down.
    const runOnce = async (isRetry: boolean): Promise<RuntimeRunResult> => {
      try {
        const activation = await deps.runtime.activate(record.id, grants, bundle);
        await deps.dispatcher.fire(`onCommand:${commandId}` as const);
        // Set ctx via setGlobal. The BimSandboxHandle special-cases
        // `__ifclite_ctx__` to synthesize from the bridge-installed
        // `globalThis.bim` (the wrapped SDK is cyclic and would crash
        // JSON.stringify). The wrap also falls back to globalThis.bim
        // if ctx is somehow unset. setGlobal is inside the try so a
        // "Sandbox disposed" on a dead handle also triggers the retry.
        const ctx: ExtensionContextV1 = { bim: deps.sdk };
        await activation.sandbox.setGlobal('__ifclite_ctx__', ctx);
        return await activation.sandbox.run(wrappedSource, { filename: entry });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only on an actual failure that looks like a dead realm do we
        // tear down and retry once — never pre-emptively.
        const isDeadSandbox =
          /Lifetime not alive|QuickJSUseAfterFree|Sandbox was torn down|Sandbox disposed|not initialized/i.test(msg);
        if (isDeadSandbox && !isRetry) {
          await deps.runtime.deactivate(record.id);
          return runOnce(true);
        }
        throw err;
      }
    };
    return runOnce(false);
  }
  // Deliberately vague about WHICH of the loop's guards rejected it. Reaching
  // here means no enabled record with this id had a loaded bundle declaring the
  // command with an entry, and naming one of those specifically would be wrong
  // for the others: an installed, enabled extension that does declare the
  // command still lands here when `getBundle` has not loaded it yet.
  throw new Error(
    `Extension "${extensionId}" has no enabled, loaded command "${commandId}" to run.`,
  );
}
