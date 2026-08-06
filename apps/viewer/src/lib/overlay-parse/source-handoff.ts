/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place the viewer turns a loaded model into the bytes a worker parse
 * receives (#2183).
 *
 * Today this is `store.source` and nothing more, so the function looks
 * pointless. It exists because the assumption underneath it — that a model's
 * bytes are ONE contiguous `Uint8Array` the main thread can hand over whole —
 * is exactly the assumption that is under pressure. The moment a source
 * becomes chunked, streamed, or only partly resident (the 342 MB class of
 * model this issue is about), every site that reaches for `store.source` has
 * to learn how to reassemble it. Routing them through here means that change
 * lands in this function, once, instead of in each parse call site.
 *
 * So: never pass `store.source` straight to `postMessage`. Call this.
 */

/**
 * The minimum a caller must have. Structural on purpose: `IfcDataStore`
 * satisfies it, and so does the narrower prop shape `useDrawingGeneration`
 * takes, without either module importing the other's types.
 */
export interface WholeSourceStore {
  source: Uint8Array;
}

/**
 * The model's whole IFC source, as one contiguous view, ready to hand to a
 * worker.
 *
 * Not a copy. The source is normally `SharedArrayBuffer`-backed on the paths
 * that matter, so the worker shares it by reference and neither realm pays for
 * the bytes — which is also why callers must never put the returned view in a
 * `postMessage` transfer list (that would detach the viewer's own copy).
 */
export function getWholeSourceForWorker(store: WholeSourceStore): Uint8Array {
  return store.source;
}
