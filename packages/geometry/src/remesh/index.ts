/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/geometry/remesh`: re-mesh edited elements in a long-lived wasm
 * worker, in the frame and style of the model's load (#6232 WP1).
 */

export { RemeshClient, type RemeshClientOptions } from './remesh-client.js';
export {
  filterStyleWire,
  type RemeshConfig,
  type RemeshRequest,
  type RemeshResult,
  type StyleWire,
} from './remesh-core.js';
