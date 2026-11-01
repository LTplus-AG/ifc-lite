/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Off-main-thread placement identity (#7022). The pass itself is the shared
 * `hashSource`; this worker only supplies its reader: the loader's
 * SharedArrayBuffer (zero copy) when the source was streamed into one, else
 * the File, read slice by slice here.
 */

import { blobChunks, hashSource, memoryChunks } from './source-identity-hash';

export interface SourceIdentityRequest {
  file: File;
  shared?: SharedArrayBuffer;
}

self.onmessage = async (event: MessageEvent<SourceIdentityRequest>) => {
  const { file, shared } = event.data;
  const read = shared && shared.byteLength === file.size ? memoryChunks(new Uint8Array(shared)) : blobChunks(file);
  self.postMessage(await hashSource(file.size, read));
};
