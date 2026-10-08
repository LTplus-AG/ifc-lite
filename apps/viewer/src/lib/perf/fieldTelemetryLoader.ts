/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * On-demand loader for the field telemetry module (#6961). Everything that
 * builds field properties (the long-frame log, the load summary, the sampled
 * inspect/navigate/boot events) lives in `fieldTelemetry.ts`, a separate
 * chunk, so the viewer entry chunk carries only this import.
 *
 * The first load starts the import; the long-frame observer is created as
 * soon as it resolves and reads back the frames it missed through the
 * observer's `buffered` replay, filtered to the load's start.
 */

type FieldTelemetry = typeof import('./fieldTelemetry.js');

let pending: Promise<FieldTelemetry> | null = null;

/**
 * The loaded module, or null until it has loaded. Per-frame and per-click call
 * sites read this live binding (`fieldTelemetry?.noteX(...)`) instead of
 * awaiting: no promise per frame, and nothing at all before the first load.
 */
export let fieldTelemetry: FieldTelemetry | null = null;

export function loadFieldTelemetry(): Promise<FieldTelemetry> {
  pending ??= import('./fieldTelemetry.js').then(
    (mod) => { mod.startLongFrameLog(); fieldTelemetry = mod; return mod; },
    (error: unknown) => { pending = null; throw error; },
  );
  return pending;
}

/** Run `use` once the module has loaded; a chunk that cannot load only warns. */
export function onFieldTelemetry(use: (field: FieldTelemetry) => void): void {
  loadFieldTelemetry().then(use).catch((error: unknown) => console.warn('[perf] field telemetry unavailable', error));
}
