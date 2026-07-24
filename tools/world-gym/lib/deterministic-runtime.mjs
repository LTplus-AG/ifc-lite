/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Byte-identical determinism shim for @ifc-lite/create.
 *
 * GAP (documented, not fixed here — out of tools/world-gym's own path):
 * `IfcCreator` calls `Date.now()` / `new Date()` twice per file
 * (packages/create/src/ifc-creator.ts: buildHeader's FILE_NAME timestamp,
 * buildPreamble's IfcOwnerHistory timestamp), and every GlobalId comes from
 * `@ifc-lite/encoding#generateIfcGuid()` -> `generateUuid()`, which calls
 * `crypto.randomUUID()` with no seed hook at all. Both are genuine
 * wall-clock/CSPRNG entropy sources with no way to inject a seed through the
 * public API. Two calls to `new IfcCreator(...).toIfc()` with otherwise
 * identical inputs are NOT byte-identical today.
 *
 * Workaround (this file, world-gym only): temporarily replace
 * `globalThis.Date` and `globalThis.crypto.randomUUID` for the duration of
 * a synchronous build callback, backed by our own seeded RNG. This makes
 * generation reproducible from world-gym's side without touching
 * packages/create or packages/encoding. If GlobalId/timestamp seeding is
 * ever added upstream, this shim becomes unnecessary and should be deleted.
 *
 * IMPORTANT: `fn` must be synchronous. The patched globals are restored in
 * a `finally` immediately after `fn()` returns, so any `await` inside `fn`
 * would leak the patched globals into unrelated concurrent code.
 */

import { Rng } from './rng.mjs';

/** Arbitrary fixed instant baked into every generated file's header/owner-history. */
const FIXED_EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

function hexUuidFrom(rng) {
  let hex = '';
  for (let i = 0; i < 32; i++) {
    hex += Math.floor(rng.float() * 16).toString(16);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Run `fn()` with Date and crypto.randomUUID pinned to a deterministic
 * stream derived from `seed`. Returns fn()'s return value.
 */
export function withDeterministicRuntime(seed, fn) {
  const guidRng = new Rng(`guid:${seed}`);
  const OrigDate = globalThis.Date;

  class FrozenDate extends OrigDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED_EPOCH_MS);
      else super(...args);
    }
    static now() {
      return FIXED_EPOCH_MS;
    }
  }

  const origRandomUUID = globalThis.crypto.randomUUID;
  const origMathRandom = Math.random;

  globalThis.Date = FrozenDate;
  globalThis.crypto.randomUUID = () => hexUuidFrom(guidRng);
  // Defensive: encoding's generateUuid() falls back to Math.random() when
  // crypto is unavailable. Pin it too so the fallback path (if ever taken)
  // stays deterministic rather than silently reintroducing entropy.
  Math.random = () => guidRng.float();

  try {
    return fn();
  } finally {
    globalThis.Date = OrigDate;
    globalThis.crypto.randomUUID = origRandomUUID;
    Math.random = origMathRandom;
  }
}
