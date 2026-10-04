/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Delay the owned copy until a consumer cannot accept shared model bytes.
 * Each load owns this closure; its source is immutable during that load.
 * Ordinary IFC parsing and geometry must keep using the original source. */
export function arrayBufferForConsumer(source: ArrayBuffer | SharedArrayBuffer): () => ArrayBuffer {
  let owned = source instanceof ArrayBuffer ? source : undefined;
  return () => {
    owned ??= new Uint8Array(source).slice().buffer;
    return owned;
  };
}
