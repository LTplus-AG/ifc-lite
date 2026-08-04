/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinates freeing a `GeometryProcessor`'s WASM handle between the two
 * consumers a single `loadFile` hands it to.
 *
 * The geometry stream is the obvious one (`processAdaptive`). The other is the
 * data-model parser: on the main-thread fallback path `loadFile` passes the
 * processor's raw handle to `IfcParser.parseColumnar` via
 * `geometryProcessor.getApi()`. So a `finally { dispose() }` around the
 * geometry block alone would free a handle the parser is still reading — the
 * disposal has to wait for whichever consumer finishes last. That coupling is
 * why the site went unfixed while the rest of #1959 landed.
 *
 * The parser is an *opt-in* consumer (`parseScheduled`) rather than one assumed
 * to be pending, because a load can fail between constructing the processor and
 * scheduling the parse — engine init downloads the WASM binary, and the
 * `SharedArrayBuffer` allocation can throw. In that window there is no parser to
 * wait for and `release()` must free the handle immediately rather than defer
 * forever on a parse that will never run.
 */
export interface GeometryProcessorDisposer {
  /**
   * `loadFile` is done with the handle. Idempotent, and safe to call while the
   * parse is still in flight — the free is deferred until `parseSettled`.
   */
  release(): void;
  /**
   * The data-model parse chain has been scheduled and may take the raw handle.
   * Must be paired with a `parseSettled` on every path the chain can end.
   */
  parseScheduled(): void;
  /**
   * The parse chain ended — resolved, rejected, or abandoned as a stale
   * session. The parser no longer touches the handle.
   */
  parseSettled(): void;
}

/**
 * Builds the two-consumer gate described above. `dispose` runs at most once,
 * when `release()` has been called and no parse is outstanding — whichever of
 * the two comes last triggers it.
 */
export function createGeometryProcessorDisposer(
  dispose: () => void,
): GeometryProcessorDisposer {
  let released = false;
  let parsePending = false;
  let disposed = false;

  const disposeIfIdle = () => {
    if (disposed || !released || parsePending) return;
    disposed = true;
    dispose();
  };

  return {
    release() {
      released = true;
      disposeIfIdle();
    },
    parseScheduled() {
      parsePending = true;
    },
    parseSettled() {
      parsePending = false;
      disposeIfIdle();
    },
  };
}
