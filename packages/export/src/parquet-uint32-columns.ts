/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Column names whose domain is an unsigned 32-bit integer, shared between
 * `ParquetExporter` (`parquet-exporter.ts`) and its on-demand property/
 * quantity writers (`parquet-exporter-ondemand.ts`) — one list, not two that
 * could disagree on which columns need the u32 guard.
 *
 * Every one carries an IFC EXPRESS ID or an index into a geometry buffer,
 * and both are `u32` everywhere else in this codebase - `Uint32Array` in
 * the parser's entity index and its transports, `u32` in the Rust crates.
 * Arrow's content inference reaches for Int32 on any whole number, so an
 * express id at or above 2_147_483_648 came out NEGATIVE: an id-shaped
 * number that joins to nothing. STEP puts no upper bound on an entity id
 * below the `u32` the readers use, so that is reachable input rather than a
 * hypothetical.
 *
 * NOT in this set, deliberately: `BuildingId`, `SiteId` and `SpaceId` in
 * `SpatialHierarchy.parquet` carry **-1 as "none"** (see
 * `writeSpatialHierarchy` - a storey directly under the project has no
 * building). Declaring those unsigned turned that sentinel into
 * 4294967295: an id-shaped number where an obviously-absent marker used to
 * be, which is the exact failure this class of change exists to prevent.
 *
 * The residual gap is the narrower one: a building or site id at or above
 * 2^31 still wraps negative in those three columns. Fixing that properly
 * means writing NULL rather than -1 for "none", which changes what every
 * consumer reads for an absent parent and is a separate decision from the
 * id width.
 */
export const PARQUET_UINT32_COLUMNS: ReadonlySet<string> = new Set([
    'ExpressId', 'EntityId', 'SourceId', 'TargetId', 'RelId',
    'ElementId', 'StoreyId',
    'Index0', 'Index1', 'Index2',
    'VertexStart', 'VertexCount', 'IndexStart', 'IndexCount',
]);
