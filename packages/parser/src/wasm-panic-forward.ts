/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Forward a worker realm's wasm panic-location stash to the main thread
 * (#2527 follow-up).
 *
 * The Rust panic hook (`rust/wasm-bindings/src/utils.rs`) stashes
 * `{ location, at }` on whichever realm's JS global it runs in — `self` in a
 * worker, `window` on the main thread. #2527 taught the main thread to read
 * its OWN global's stash and attach it to a trap's exception event
 * (`apps/viewer/src/lib/analytics-scrub.ts`'s `attachWasmPanicLocation`), but
 * a worker-realm trap leaves that stash stranded in the worker's global,
 * which the main thread can never see across the realm boundary.
 *
 * `takeWasmPanicStash` reads + consumes the stash worker-side so it can ride
 * the worker's own `{type:'error'}` message; `restashWasmPanicLocation`
 * re-plants it on the main thread's global so the EXISTING #2527 gate (same
 * key, same TTL, same consume-once semantics) picks it up unmodified.
 *
 * Location only, never the panic's message — the message can embed
 * model-derived text (see `utils.rs`'s privacy contract); the location alone
 * travels on the error message and through this module.
 *
 * NOTE: this file is intentionally byte-identical to
 * `packages/geometry/src/wasm-panic-forward.ts` — both `@ifc-lite/geometry`
 * and `@ifc-lite/parser` need the exact same realm-forwarding contract, and
 * neither package depends on the other (nor is `@ifc-lite/wasm`, the one
 * package both DO depend on, a safe home: it ships only the wasm-pack build
 * output, with no TypeScript build step of its own, and `test`/`typecheck`
 * for either consumer already runs its build via turbo's `^build` — adding a
 * hand-written TS module there would make every geometry/parser test run
 * gate on a full Rust→wasm rebuild). Keep any change to one copy in lockstep
 * with the other; `wasm-panic-forward.test.ts` is duplicated the same way.
 */

/** Kept in lockstep with `PANIC_STASH_KEY` in `rust/wasm-bindings/src/utils.rs`,
 *  `WASM_PANIC_STASH_KEY` in `apps/viewer/src/lib/analytics-scrub.ts`, and this
 *  module's twin at `packages/geometry/src/wasm-panic-forward.ts`. */
export const WASM_PANIC_STASH_KEY = '__ifclite_wasm_panic';

/**
 * Trap-shape text match, kept in lockstep with `WASM_TRAP_TEXT` in
 * `apps/viewer/src/lib/analytics-scrub.ts` and this module's twin at
 * `packages/geometry/src/wasm-panic-forward.ts`. Deliberately excludes bare
 * "unreachable" inside network-failure phrasing ("network is unreachable",
 * "host unreachable") — those are not wasm traps.
 */
const WASM_TRAP_TEXT =
  /(?<!network is |host |destination |address )\bunreachable\b|\bRuntimeError\b|memory access out of bounds|index out of bounds|indirect call to null|integer (?:overflow|divide by zero)|call stack exhausted/i;

function looksLikeWasmTrap(message: string): boolean {
  return WASM_TRAP_TEXT.test(message);
}

export interface WasmPanicStash {
  location: string;
  at: number;
}

/** Validate + narrow an unknown stash value read off a realm global. */
function readStashShape(value: unknown): WasmPanicStash | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { location, at } = value as { location?: unknown; at?: unknown };
  if (typeof location !== 'string' || location === '') return undefined;
  // Reject non-finite (`NaN`/`Infinity`) and future timestamps — both pass
  // the analytics TTL gate's `Date.now() - at <= TTL` check trivially
  // (`Infinity` makes the delta `-Infinity`; a future `at` makes it
  // negative), which would let a malformed stash label a later trap.
  if (typeof at !== 'number' || !Number.isFinite(at) || at > Date.now()) return undefined;
  return { location, at };
}

/**
 * Worker-side: read and CONSUME this realm's panic stash so it can be
 * forwarded on the worker's own error message. Consume-once regardless of
 * shape validity — an unconsumed malformed stash must not linger to
 * mislabel a later trap, mirroring the main-thread gate's own rule.
 */
export function takeWasmPanicStash(realm: object): WasmPanicStash | undefined {
  const g = realm as Record<string, unknown>;
  const raw = g[WASM_PANIC_STASH_KEY];
  delete g[WASM_PANIC_STASH_KEY];
  return readStashShape(raw);
}

/**
 * Main-side: re-plant a worker-forwarded stash on this realm's global so the
 * existing #2527 `attachWasmPanicLocation` gate consumes it unmodified.
 *
 * Gated on `errorMessage` looking like a wasm trap: the worker forwards
 * `wasmPanicLocation`/`wasmPanicAt` on ANY `{type:'error'}` message (a stale
 * stash from an earlier suppressed panic can ride out on an ordinary,
 * non-trap worker error), and re-planting unconditionally would let that
 * stale location sit on `globalThis` until an unrelated trap-shaped
 * exception consumed it — mislabeling that trap. Only a message that itself
 * looks like a wasm trap is allowed to re-plant.
 *
 * Never clobbers an existing, unconsumed stash — a genuine main-thread trap
 * that hasn't been captured yet must win over a worker trap that merely
 * arrived first (the older-looking stash, if stale, is simply dropped later
 * by the TTL check at attach time; this function never overwrites either
 * way).
 */
export function restashWasmPanicLocation(
  realm: object,
  location: unknown,
  at: unknown,
  errorMessage: string,
): void {
  const stash = readStashShape({ location, at });
  if (!stash) return;
  if (!looksLikeWasmTrap(errorMessage)) return;
  const g = realm as Record<string, unknown>;
  if (g[WASM_PANIC_STASH_KEY] !== undefined) return;
  g[WASM_PANIC_STASH_KEY] = stash;
}
