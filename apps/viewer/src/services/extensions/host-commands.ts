/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Command-dispatch helpers extracted from `host.ts`.
 *
 * `runExtensionCommand` finds the owning extension for a commandId,
 * activates it, fires the matching `onCommand:<id>` event, loads the
 * handler source, wraps it via `wrapEntrySource`, and runs the entry
 * inside the activation's sandbox. Throws if no extension owns the
 * command or the bundle is missing the entry path.
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
import type { BimContext } from '@ifc-lite/sdk';
import type { IdbExtensionStorage } from './idb-storage.js';

export interface RunCommandDeps {
  storage: IdbExtensionStorage;
  loader: ExtensionLoader;
  runtime: ExtensionRuntime;
  dispatcher: ActivationDispatcher;
  sdk: BimContext;
}

/**
 * Dispatch an extension command end-to-end. Pure function — no
 * `this`. Callers (host service) inject the dependencies.
 */
export async function runExtensionCommand(
  deps: RunCommandDeps,
  commandId: string,
): Promise<RuntimeRunResult | undefined> {
  const records = await deps.storage.listExtensions();
  for (const record of records) {
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

    // Pure command tools (promoted scripts) have no `entry.activate`,
    // so there is no per-extension state worth preserving across runs.
    // Give each run a brand-new sandbox: nothing carried over from a
    // prior run, a flavor switch, a model reload, or an authoring
    // dry-run can leave a half-disposed QuickJS realm behind.
    const hasActivateEntry = !!bundle.manifest.entry.activate;

    const runOnce = async (isRetry: boolean): Promise<RuntimeRunResult> => {
      try {
        // Force a fresh sandbox for command-only tools (always), and
        // for anything on a retry. The runtime's activate() then
        // rebuilds from scratch instead of handing back a cached —
        // possibly dead — record.
        if (!hasActivateEntry || isRetry) {
          await deps.runtime.deactivate(record.id);
        }
        const activation = await deps.runtime.activate(record.id, grants, bundle);
        // Set ctx via setGlobal. The BimSandboxHandle special-cases
        // `__ifclite_ctx__` to synthesize from the bridge-installed
        // `globalThis.bim` (the wrapped SDK is cyclic and would crash
        // JSON.stringify). The wrap also falls back to globalThis.bim
        // if ctx is somehow unset.
        const ctx: ExtensionContextV1 = { bim: deps.sdk };
        await activation.sandbox.setGlobal('__ifclite_ctx__', ctx);
        // Nothing runs between activate and run except setGlobal — so
        // no listener can dispose the sandbox mid-flight. The
        // `onCommand:` activation event fires AFTER the handler (it
        // only wakes other listeners; the command itself already ran)
        // and is non-fatal so a listener failure can't fail the run.
        const result = await activation.sandbox.run(wrappedSource, { filename: entry });
        deps.dispatcher.fire(`onCommand:${commandId}` as const).catch((err) => {
          console.warn(`[ext-host] onCommand:${commandId} listeners failed:`, err);
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Any signal that the sandbox realm died — QuickJS use-after-
        // free, our own teardown guard, or a setGlobal on a disposed
        // handle. One retry rebuilds a genuinely fresh sandbox.
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
  throw new Error(`No installed, enabled extension owns command "${commandId}".`);
}
