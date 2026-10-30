/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * F2 (#8341): how many type records a load's prepass left out because the
 * full decoder rejects them, so their type geometry was never planned.
 *
 * The count is the additive `omittedTypeRecords` key of the WASM
 * `getPipelineDiagnostics()` report (schema v1), kept on the IfcAPI that RAN
 * the prepass. That report resets on the next content install
 * (`setSourceBytes`, `setEntityIndex`, another prepass) and survives
 * `clearPrePassCache`, so it is read from the prepass instance itself: right
 * after `buildPrePassOnce` on the main-thread paths, and inside the streaming
 * prepass's `complete` callback on the dedicated prepass worker, which carries
 * it to the host on that event (the host terminates that worker as soon as
 * `complete` arrives, so a later message could be lost).
 *
 * `undefined` means unknown, never zero: a WASM build without the getter, a
 * report without the field (built before #8350), or no report at all. A
 * current build also returns no report when nothing at all was recorded, and
 * that cannot be told apart from an older build, so a clean prepass-only load
 * reads as unknown too. Consumers show nothing for unknown, as for 0.
 */

/** A non-negative integer count, else `undefined` (unknown). */
export function parseOmittedTypeRecords(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Read the count from the IfcAPI that ran the prepass; `undefined` when unknown. */
export function readOmittedTypeRecords(api: unknown): number | undefined {
  const getter = (api as { getPipelineDiagnostics?: unknown } | null | undefined)?.getPipelineDiagnostics;
  if (typeof getter !== 'function') return undefined;
  let report: unknown;
  try {
    report = getter.call(api);
  } catch (err) {
    // A diagnostics read must not fail the load it describes.
    console.warn('[prepass] getPipelineDiagnostics failed; omitted type records unknown', err);
    return undefined;
  }
  if (typeof report !== 'object' || report === null) return undefined;
  return parseOmittedTypeRecords((report as { omittedTypeRecords?: unknown }).omittedTypeRecords);
}

/**
 * Copy the count onto a streaming prepass `complete` event before the worker
 * posts it. Rust emits `complete` after the type plan has noted its omissions,
 * and every streaming prepass entry point borrows the IfcAPI shared, so the
 * getter may be called from inside the callback. Other events are untouched.
 */
export function annotatePrepassComplete(api: unknown, event: unknown): void {
  if (typeof event !== 'object' || event === null || (event as { type?: unknown }).type !== 'complete') return;
  const count = readOmittedTypeRecords(api);
  if (count !== undefined) (event as { omittedTypeRecords?: number }).omittedTypeRecords = count;
}

/** Spread onto a stream `complete` event: the key only when the count is known. */
export function omittedTypeRecordsField(count: number | undefined): { omittedTypeRecords?: number } {
  return count === undefined ? {} : { omittedTypeRecords: count };
}
