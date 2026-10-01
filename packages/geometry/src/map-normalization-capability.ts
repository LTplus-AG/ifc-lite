/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcLiteBridge } from './ifc-lite-bridge.js';
import type { IPlatformBridge } from './platform-bridge.js';

/** Pack the existing native STEP merge request once; its byte contract is unchanged. */
export function exportMerged(bridge: IfcLiteBridge | null, buffers: Uint8Array[], schema: string): Uint8Array | null {
  if (!bridge?.isInitialized()) return null;
  let total = 0;
  for (const buffer of buffers) total += buffer.byteLength;
  const concatenated = new Uint8Array(total);
  const lengths = new Uint32Array(buffers.length);
  let offset = 0;
  for (let index = 0; index < buffers.length; index++) {
    concatenated.set(buffers[index], offset);
    lengths[index] = buffers[index].byteLength;
    offset += buffers[index].byteLength;
  }
  return bridge.exportMerged(concatenated, lengths, schema);
}

/** Native platforms explicitly refuse until they expose the canonical backend. */
export function planMapConversionNormalization(
  bridge: IfcLiteBridge | null, platform: IPlatformBridge | null, content: Uint8Array,
): string {
  if (platform) {
    if (!platform.planMapConversionNormalization) throw new Error('Map geometry normalization is not supported by this platform bridge.');
    return platform.planMapConversionNormalization(content);
  }
  if (!bridge?.isInitialized()) throw new Error('GeometryProcessor is not initialized.');
  return bridge.planMapConversionNormalization(content);
}
