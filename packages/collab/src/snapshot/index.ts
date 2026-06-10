/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {
  seedFromIfcx,
  parseIfcxInput,
  type SeedOptions,
  type IfcxInput,
} from './from-ifcx.js';
export { snapshotToIfcx, serializeIfcx, type SnapshotOptions } from './to-ifcx.js';
export {
  captureBaseline,
  extractUserLayer,
  filterUpdateByClient,
} from './layers.js';
export {
  extractMinimalLayer,
  type ExtractMinimalLayerOptions,
} from './minimal-layer.js';
export {
  publishLayer,
  type PublishLayerOptions,
  type PublishedLayer,
} from './publish-layer.js';
export {
  V5A_ATTR_PREFIX,
  structuredAttributeKey,
  flattenStructuredBranches,
  inflateStructuredAttributes,
  isPropertyValueShaped,
  geometryRecordLookup,
  type StructuredBranchesJSON,
  type InflatedAttributes,
  type GeometryRefCarrier,
  type FlattenOptions,
} from './structured-attrs.js';
export {
  runSnapshotWorker,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerScopeLike,
} from './worker.js';
