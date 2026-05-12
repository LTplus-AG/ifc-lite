// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @ifc-lite/server-client
 *
 * TypeScript client SDK for IFC-Lite Server.
 *
 * @example
 * ```typescript
 * import { IfcServerClient } from '@ifc-lite/server-client';
 *
 * const client = new IfcServerClient({
 *   baseUrl: 'https://your-server.railway.app'
 * });
 *
 * // Full parse
 * const result = await client.parse(file);
 * console.log(`Processed ${result.stats.total_meshes} meshes`);
 *
 * // Streaming parse
 * for await (const event of client.parseStream(file)) {
 *   if (event.type === 'batch') {
 *     renderer.addMeshes(event.meshes);
 *   }
 * }
 * ```
 */

export * from './client.js';
export * from './types.js';
export { decodeParquetGeometry, decodeOptimizedParquetGeometry, isParquetAvailable } from './parquet-decoder.js';
export { decodeDataModel, type DataModel, type Quantity, type QuantitySet } from './data-model-decoder.js';
