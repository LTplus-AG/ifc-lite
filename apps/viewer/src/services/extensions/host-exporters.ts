/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exporter dispatch, the sibling of `host-commands.ts`.
 *
 * `runExtensionExporter` finds the extension owning an exporter id,
 * activates it, fires `onExporter:<id>`, loads the handler source, wraps it
 * via `wrapEntrySource`, and runs the entry inside the activation's sandbox.
 *
 * Unlike commands, an exporter's handler is NOT looked up in `manifest.entry`
 * — `ManifestEntry` has no `exporters` map. The path lives directly on the
 * contribution as `handler`, and `validate/cross-ref.ts` already guarantees it
 * resolves to a file in the bundle. Same shape as `lenses[].evaluator`.
 *
 * The declared contribution used to be unreachable: it validated, loaded, and
 * registered to the `exportMenu` slot, but nothing in the viewer consumed that
 * slot, so a third-party exporter installed cleanly and then did nothing
 * (#1907).
 */

import {
  parseCapabilities,
  wrapEntrySource,
  type ActivationDispatcher,
  type ExtensionContextV1,
  type ExtensionLoader,
  type ExtensionRuntime,
  type ExporterContribution,
  type RuntimeRunResult,
} from '@ifc-lite/extensions';
import type { BimContext } from '@ifc-lite/sdk';
import type { IdbExtensionStorage } from './idb-storage.js';

export interface RunExporterDeps {
  storage: IdbExtensionStorage;
  loader: ExtensionLoader;
  runtime: ExtensionRuntime;
  dispatcher: ActivationDispatcher;
  sdk: BimContext;
}

/** What an exporter produced, normalised for the download path. */
export interface ExporterOutput {
  contribution: ExporterContribution;
  /** Raw handler return value, coerced to something `Blob` accepts. */
  data: string | Uint8Array;
  /** The full run result, so callers can surface logs on failure. */
  result: RuntimeRunResult;
}

/**
 * Coerce whatever the sandboxed handler returned into blob-ready bytes.
 *
 * Sandbox boundaries flatten typed arrays, so a handler that returns a
 * `Uint8Array` can arrive as a plain object with numeric keys. Accepting only
 * `Uint8Array` would reject perfectly valid extensions for a reason the author
 * cannot see or fix.
 */
export function coerceExporterOutput(value: unknown): string | Uint8Array | null {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((n) => typeof n === 'number')) {
    return Uint8Array.from(value);
  }
  // A structured-cloned Uint8Array: { "0": 12, "1": 34, ... }.
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 0 && entries.every(([k, v]) => /^\d+$/.test(k) && typeof v === 'number')) {
      const bytes = new Uint8Array(entries.length);
      for (const [k, v] of entries) bytes[Number(k)] = v as number;
      return bytes;
    }
  }
  return null;
}

/**
 * Run an extension-contributed exporter end-to-end. Pure function — no
 * `this`; the host service injects its primitives.
 *
 * Throws when no installed, enabled extension owns the id, when the stored
 * capabilities are unreadable, when the handler file is missing from the
 * bundle, or when the handler returns something that cannot be written to a
 * file. Never returns a silent empty result — a user who clicks Export and
 * gets nothing has no way to tell a broken extension from a broken viewer.
 */
export async function runExtensionExporter(
  deps: RunExporterDeps,
  exporterId: string,
): Promise<ExporterOutput> {
  const records = await deps.storage.listExtensions();
  for (const record of records) {
    if (!record.enabled) continue;
    const bundle = deps.loader.getBundle(record.id);
    if (!bundle) continue;
    const contribution = bundle.manifest.contributes?.exporters?.find((e) => e.id === exporterId);
    if (!contribution) continue;

    const grantsResult = parseCapabilities(record.grantedCapabilities);
    if (!grantsResult.ok) {
      throw new Error(
        `Cannot run exporter ${exporterId}: stored capabilities for ${record.id} are invalid.`,
      );
    }
    const grants = grantsResult.value;

    const file = bundle.files.get(contribution.handler);
    if (!file) {
      throw new Error(
        `Exporter handler "${contribution.handler}" missing from bundle ${record.id}.`,
      );
    }
    const source = file.text ?? new TextDecoder().decode(file.bytes);
    const wrapResult = wrapEntrySource(source, {
      entryFnName: 'run',
      filename: contribution.handler,
    });
    if (!wrapResult.ok) {
      throw new Error(
        `Failed to prepare exporter "${exporterId}": ${wrapResult.errors[0]?.message ?? 'wrap error'}`,
      );
    }
    const wrappedSource = wrapResult.value;

    // Mirrors runExtensionCommand: reuse the cached activation, and only tear
    // down and retry when the failure actually looks like a dead realm. See
    // the note there — pre-emptive dispose→recreate is what caused
    // "Lifetime not alive".
    const runOnce = async (isRetry: boolean): Promise<RuntimeRunResult> => {
      try {
        const activation = await deps.runtime.activate(record.id, grants, bundle);
        await deps.dispatcher.fire(`onExporter:${exporterId}` as const);
        const ctx: ExtensionContextV1 = { bim: deps.sdk };
        await activation.sandbox.setGlobal('__ifclite_ctx__', ctx);
        return await activation.sandbox.run(wrappedSource, { filename: contribution.handler });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isDeadSandbox =
          /Lifetime not alive|QuickJSUseAfterFree|Sandbox was torn down|Sandbox disposed|not initialized/i.test(msg);
        if (isDeadSandbox && !isRetry) {
          await deps.runtime.deactivate(record.id);
          return runOnce(true);
        }
        throw err;
      }
    };

    const result = await runOnce(false);
    const data = coerceExporterOutput(await result.value);
    if (data === null) {
      throw new Error(
        `Exporter "${exporterId}" returned ${describeReturn(result.value)}; ` +
          `expected a string or byte array to write to the file.`,
      );
    }
    return { contribution, data, result };
  }
  throw new Error(`No installed, enabled extension owns exporter "${exporterId}".`);
}

function describeReturn(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}
