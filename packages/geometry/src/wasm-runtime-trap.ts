/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classify WebAssembly runtime traps and, for the one case that genuinely
 * cannot be recovered in-document, broadcast it so the host can offer a reload
 * (#1898).
 *
 * A trap is what reaches JS when the engine executes `unreachable`: with
 * `panic = "abort"` (rust/Cargo.toml) a Rust panic, a failed `assert!` and an
 * allocator abort are ALL indistinguishable from here — see the same caveat in
 * `huge-file-error.ts`. What a trap can damage is bounded: the wasm instance's
 * linear memory keeps whatever the aborted call leaked, and any Rust state the
 * call was mutating is left mid-flight. It does NOT invalidate the module, and
 * it says nothing about other engine handles in the realm, let alone about
 * other realms (each Worker instantiates its own `@ifc-lite/wasm`).
 *
 * So the recovery contract is:
 *
 *  - a trap taken inside an *operation* is the caller's failure. The bridge
 *    that took it drops (and frees) its `IfcAPI` handle — that is where the
 *    wedgeable per-load caches live — and the original trap propagates
 *    unchanged. A later `init()`, on that bridge or any other, builds a fresh
 *    handle and works.
 *  - a trap taken while *initializing* means this realm could not produce a
 *    working engine at all, and neither half of that is retryable in practice:
 *    if the trap came from `new IfcAPI()` the module singleton is already built
 *    and wasm-bindgen's `init()` will keep returning it, and if it came from
 *    instantiation itself it is a deterministic module-level failure that
 *    recurs. That is the only case that earns
 *    {@link WASM_RUNTIME_UNRECOVERABLE_EVENT} — the user is told to reload,
 *    which is the one thing that really does get a new instance.
 *
 * Even then nothing is latched: a later `init()` still tries, so the
 * "unrecoverable" verdict is a diagnosis for the user, never a lock that could
 * disable an unrelated consumer. Recovery is lazy — it happens on the next
 * `init()` a consumer asks for — so there is no retry loop to bound either.
 *
 * Detection lives here as a pure, unit-testable predicate; the host app owns
 * the reload policy and subscribes to the event. This library never reloads
 * the page on its own — same division of labour as `wasm-asset-error.ts`.
 */

/**
 * Stable marker in the message of the error thrown when the engine cannot be
 * initialized after a trap. Kept in the message (not only in a field) so it
 * survives the string-only round trip through error tracking, and so the host
 * app can classify it without importing this package.
 */
export const WASM_RUNTIME_UNRECOVERABLE_CODE = 'WASM_RUNTIME_UNRECOVERABLE';

/**
 * Dispatched on `globalThis` when the WebAssembly geometry engine trapped
 * while initializing and therefore cannot be rebuilt in this document.
 * `detail.message` carries the originating trap text. Hosts that opt in tell
 * the user to reload; unlike the version-skew event this must NOT trigger an
 * automatic reload — a crash mid-session would discard the user's work.
 */
export const WASM_RUNTIME_UNRECOVERABLE_EVENT = 'ifclite:wasm-runtime-unrecoverable';

function messageOf(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

/**
 * True when `err` is a WebAssembly runtime trap.
 *
 * `instanceof WebAssembly.RuntimeError` alone is not enough: an error thrown
 * inside a Worker/iframe realm and re-raised here fails the identity check
 * because each realm has its own `WebAssembly.RuntimeError` constructor. The
 * `.name` fallback is the cross-realm-safe half — `RuntimeError` is the class
 * name the spec fixes for wasm traps, and structured-cloned errors keep it.
 */
export function isWasmRuntimeTrap(err: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) return true;
  if (typeof err !== 'object' || err === null) return false;
  return (err as { name?: unknown }).name === 'RuntimeError';
}

/**
 * True for the typed error {@link wasmRuntimeUnrecoverableError} produces —
 * matched on the message marker so it also works on an error that only
 * survived as text (an analytics payload, a `postMessage` hop).
 */
export function isWasmRuntimeUnrecoverableError(err: unknown): boolean {
  return messageOf(err).includes(WASM_RUNTIME_UNRECOVERABLE_CODE);
}

/**
 * Build the error thrown when the engine trapped while initializing.
 *
 * Constructed FRESH at every throw site on purpose. The bug this replaces
 * stored one Error object in a module global and rethrew it forever, so the
 * stack shipped to error tracking pointed at whichever call first trapped —
 * the production report for #1898 showed a `exportGlb` stack captured under a
 * model-load context, which made it undiagnosable. The underlying trap is kept
 * verbatim in the message tail (for triage from text alone) and as `.cause`
 * (for programmatic inspection), mirroring `largeFilePrepassError`.
 */
export function wasmRuntimeUnrecoverableError(cause: unknown, operation: string): Error {
  const raw = messageOf(cause) || String(cause);
  return new Error(
    `${WASM_RUNTIME_UNRECOVERABLE_CODE}: the IFC-Lite WebAssembly geometry engine trapped during ` +
      `${operation}, so this document has no working engine instance. Reload the page to get a ` +
      `fresh one. (underlying wasm trap: ${raw})`,
    { cause },
  );
}

interface DomDispatcher {
  dispatchEvent: (event: Event) => boolean;
}

function domDispatcher(): DomDispatcher | null {
  const g = globalThis as unknown as Partial<DomDispatcher> & { CustomEvent?: unknown };
  return typeof g.dispatchEvent === 'function' && typeof g.CustomEvent === 'function'
    ? (g as DomDispatcher)
    : null;
}

/**
 * Broadcast {@link WASM_RUNTIME_UNRECOVERABLE_EVENT} on `globalThis` so an
 * opted-in host can tell the user the engine is gone and offer a reload.
 * No-op in non-DOM hosts such as Node (CLI/MCP), where the thrown error is the
 * whole story.
 */
export function notifyWasmRuntimeUnrecoverable(err: unknown): void {
  const target = domDispatcher();
  if (!target) return;
  try {
    target.dispatchEvent(
      new CustomEvent(WASM_RUNTIME_UNRECOVERABLE_EVENT, { detail: { message: messageOf(err) } }),
    );
  } catch {
    /* CustomEvent unavailable — best effort, nothing more to do */
  }
}
