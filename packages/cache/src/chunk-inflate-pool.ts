/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `@ifc-lite/cache/chunk-inflate-pool`: a separate entry, so a viewer can import the pool lazily. */
export { ChunkInflatePool, CorruptChunkError, type ChunkInflatePoolOptions } from './workers/chunk-inflate-pool.js';
