/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/site-context — the site around a georeferenced building as data:
 * swissALTI3D terrain and the cadastral parcel in one local frame stated in
 * EPSG:2056 / EPSG:5728, written as a self-describing GLB. Headless: the
 * viewer, the CLI and the MCP server share this core.
 */

export { buildSiteContext } from './build.js';
export { BUILDING_SET } from './buildings-layer.js';
export { SUBJECT_MIN_OVERLAP } from './buildings-footprint.js';
export { SiteContextCoverageError } from './frame.js';
export { encodeSiteContextGlb } from './glb-encode.js';
export { isAllowedSwisstopoUrl, SiteContextHostRefused, swisstopoOnlyFetch, SWISSTOPO_HOSTS } from './host-allowlist.js';
export { decodeSiteContextGlb, SiteContextFormatError } from './glb-decode.js';
export {
  summarizeSiteContext,
  type SiteContextBuildingsSummary,
  type SiteContextLayerSummary,
  type SiteContextParcelSummary,
  type SiteContextSummary,
} from './summary.js';
export type {
  BuildingsOptions,
  BuildingsReader,
  BuildSiteContextOptions,
  JsonValue,
  MapPoint,
  SiteContextDocument,
  SiteContextFeature,
  SiteContextGeodata,
  SiteContextIssue,
  SiteContextIssueSeverity,
  SiteContextLayer,
  SiteContextLayerKind,
  SiteContextMesh,
  SiteContextMeshPart,
  SiteContextOriginHeight,
  SiteContextProgress,
} from './types.js';
