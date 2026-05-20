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

    // Reuse the cached activation across runs — that is the behaviour
    // command tools shipped with originally and it works. Forcing a
    // brand-new sandbox per run (an earlier experiment) regressed it:
    // the dispose→recreate cycle is what surfaced "Lifetime not alive".
    // The single retry below is kept purely as a safety net for a
    // genuinely dead sandbox; it does NOT pre-emptively tear anything
    // down.
    const runOnce = async (isRetry: boolean): Promise<RuntimeRunResult> => {
      console.log(`[ext-diag] runExtensionCommand("${commandId}") — runOnce(isRetry=${isRetry}) START`);
      try {
        const activation = await deps.runtime.activate(record.id, grants, bundle);
        console.log(`[ext-diag] runExtensionCommand("${commandId}") — activated, firing onCommand event`);
        await deps.dispatcher.fire(`onCommand:${commandId}` as const);
        console.log(`[ext-diag] runExtensionCommand("${commandId}") — dispatcher.fire done, setting ctx`);
        // Set ctx via setGlobal. The BimSandboxHandle special-cases
        // `__ifclite_ctx__` to synthesize from the bridge-installed
        // `globalThis.bim` (the wrapped SDK is cyclic and would crash
        // JSON.stringify). The wrap also falls back to globalThis.bim
        // if ctx is somehow unset. setGlobal is inside the try so a
        // "Sandbox disposed" on a dead handle also triggers the retry.
        const ctx: ExtensionContextV1 = { bim: deps.sdk };
        await activation.sandbox.setGlobal('__ifclite_ctx__', ctx);
        console.log(`[ext-diag] runExtensionCommand("${commandId}") — ctx set, calling sandbox.run`);
        return await activation.sandbox.run(wrappedSource, { filename: entry });
      } catch (err) {
        console.error(`[ext-diag] runExtensionCommand("${commandId}") — runOnce(isRetry=${isRetry}) caught:`, err);
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
  throw new Error(`No installed, enabled extension owns command "${commandId}".`);
}
