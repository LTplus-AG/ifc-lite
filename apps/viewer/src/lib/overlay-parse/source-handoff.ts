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

import type { IfcSourceBytes, IfcSourceTransfer } from '@ifc-lite/parser';

/**
 * The minimum a caller must have. Structural on purpose: `IfcDataStore`
 * satisfies it, and so does the narrower prop shape `useDrawingGeneration`
 * takes, without either module importing the other's types.
 */
export interface WholeSourceStore {
  source: IfcSourceBytes;
}

/**
 * A description of the model's whole IFC source, ready to `postMessage`.
 *
 * An envelope, NOT bytes, and that is the point. A resident source describes
 * itself as its underlying view, so this stays exactly as cheap as it was:
 * the source is `SharedArrayBuffer`-backed on the paths that matter, and a SAB
 * posted without a transfer list is shared by reference, so neither realm pays
 * for the bytes. (Callers must still never put it in a transfer list — that
 * would detach the viewer's own copy.)
 *
 * A block-compressed source describes itself as its compressed blocks instead,
 * so the worker receives ~67 MB rather than 343 MB and the MAIN thread never
 * inflates anything. Materialising here would have been the single worst place
 * to do it: it would reintroduce, on the render thread, precisely the whole-
 * file allocation #2183 exists to remove.
 *
 * The receiving worker rebuilds with `sourceBytesFromTransferable`.
 */
export function getWholeSourceForWorker(store: WholeSourceStore): IfcSourceTransfer {
  return store.source.toTransferable();
}
