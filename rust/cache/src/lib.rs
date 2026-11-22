// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native writer for the browser-readable `.ifclite` cache, format v28
//! (`@ifc-lite/cache`, `packages/cache/src/types.ts` `FORMAT_VERSION`), so a
//! server or function can build the cache a browser then only reads (#9584).
//!
//! Two entry points with one output: [`build_cache`] builds the cache in
//! memory, [`build_cache_to_path`] streams it to a file without holding the
//! mesh set, and the two are byte-identical for the same input and options
//! (`tests/streamed_matches_in_memory.rs`). The `ifc-build-cache` binary is a
//! thin CLI over the second. Both run the canonical pipeline and add no
//! ingest or geometry of their own: the scalar sections come from
//! `ifc_lite_processing::data_model::extract_data_model_with` (rooted
//! entities; property and quantity tables off), the geometry from
//! `ifc_lite_processing::process`. Each section module mirrors its TS
//! serializer field for field and names it.
//!
//! # Determinism
//!
//! The output is a pure function of the source bytes and [`CacheOptions`]:
//! meshes are chunked in the pipeline's emit order (pinned by the
//! mesh-determinism contract, independent of thread count), the data model's
//! tables are ordered, and deflate is `miniz_oxide` at a fixed level. The
//! stored chunk bytes therefore differ from the TS writer's (node zlib), which
//! moves directory `byteOffset`/`byteLength` and can flip a chunk's
//! `DeflateRaw` flag; the inflated payloads are what the two writers share.
//! `scripts/cache-native-conformance.mjs` checks both properties.
//!
//! # What the native pipeline does not produce
//!
//! Each is a value the format and the TS reader accept; none is faked:
//!
//! - **Properties / Quantities** are written empty, as the TS writer does for
//!   a STEP-parsed store (`packages/cache/README.md`).
//! - **Selection coverage** (the v28 EntityIndex trailer, #9947) is written
//!   absent: it is computed by the TS parser alone
//!   (`selection-relationship-index.ts`), and porting it would be a second
//!   ingest implementation.
//! - **InstancedShards** (IFNS) are never written: native `process` has no
//!   GPU-instancing partition, so every occurrence is a flat mesh.
//! - **Appearance provenance** (v19) is mode 0 on every mesh and the source
//!   pool is empty: canonical-item source indices are a browser-batch output.
//! - **`shadingColor`** (v25) is never present: the native pass reports one
//!   colour per mesh and no distinct authored DiffuseColour.
//! - **Mesh frame.** Native `process` meshes with its own per-mesh origins
//!   (zero for most meshes; the browser path stores local-frame origins) and
//!   in its own frame tier. Its translation is recorded as `wasmRtcOffset`;
//!   when the `IfcSite`-local tier also removed the site rotation, which
//!   `CoordinateInfo` cannot express, the writer puts that rotation back into
//!   the stored origins, positions and normals (`pipeline.rs`), so every
//!   vertex reads back at `MeshFrame::to_world` of its pass-frame point.
//!   `wasmRtcFrame`, `buildingRotation` and `boundsRecoveryFallbackCount` are
//!   left absent (each is producer provenance of the browser path;
//!   `buildingRotation` orients camera presets and is never applied to
//!   geometry).
//! - **Entity rows** are the data model's rooted table and naming rules (an
//!   explicit `''` Name and the own-Representation flag are re-read from the
//!   source, which the data model does not carry: `row_facts.rs`), not the
//!   TS parser's row selection, so the scalar sections encode the same model
//!   the TS writer would be handed for this data, not the bytes a TS parse of
//!   the same file produces. `scripts/cache-native-conformance.mjs` states
//!   and checks the row-set difference against a TS parse.

mod buf;
mod build;
mod entities;
mod entity_index;
mod format;
mod geometry;
mod pipeline;
mod relationships;
mod row_facts;
mod stream;
mod strings;
mod type_enum;

use std::path::Path;

pub use format::FORMAT_VERSION;

/// What to write. [`Default`] matches the TS writer's defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheOptions {
    /// Run the geometry pass and write the Geometry section (`includeGeometry`).
    pub include_geometry: bool,
    /// Store `sourceHash = 0` and set `HeaderFlags.SourceHashUnset` instead of
    /// hashing the whole source (`omitSourceHash`).
    pub omit_source_hash: bool,
    /// Deflate-raw chunks of 64 KiB and up when that is smaller
    /// (`compressGeometryChunks`).
    pub compress_geometry_chunks: bool,
}

impl Default for CacheOptions {
    fn default() -> Self {
        Self { include_geometry: true, omit_source_hash: false, compress_geometry_chunks: true }
    }
}

/// What a build produced. Both entry points report the same values for the
/// same input and options.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    /// STEP instances in the source: the header's `entityCount`.
    pub entity_count: u64,
    /// Rows in the Entities section.
    pub entity_rows: u64,
    pub mesh_count: u64,
    /// Meshes the TS `validateMeshes` rules drop (absurd counts, unpaired normals).
    pub skipped_meshes: u64,
    pub chunk_count: u64,
    pub total_vertices: u64,
    pub total_triangles: u64,
    pub cache_bytes: u64,
    /// Distinct chunk grid cells. A cell's chunk stays open until the 8 MiB
    /// soft cap or the end of the pass closes it, and each holds under the
    /// cap plus at most one more mesh of any size, so the geometry a build
    /// holds at once is bounded per cell: this times the cap, plus one mesh
    /// per cell.
    pub chunk_cells: u64,
    /// The most serialized record bytes the open chunks held at once: the
    /// measured side of that bound.
    pub peak_open_chunk_bytes: u64,
}

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CacheError {
    /// Section and chunk offsets and lengths are u32, so a cache this large
    /// cannot be addressed. Refused, never wrapped; the streaming writer
    /// refuses as soon as the geometry it has spooled crosses the bound.
    #[error("cache would be at least {0} bytes; the format addresses at most 4 GiB")]
    TooLarge(u64),
    /// EntityIndex spans are u32 offsets into the source: a larger source
    /// cannot be indexed without wrapping.
    #[error("source is {0} bytes; the entity index addresses at most 4 GiB")]
    SourceTooLarge(u64),
    /// EntityIndex type indices are u16 (the TS writer refuses the same).
    #[error("source has {0} distinct entity type names; the entity index holds at most 65536")]
    TooManyTypeNames(usize),
    /// Writing the output or its staging files.
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
}

/// The length of `payload` under the writer's own chunk compressor. For
/// `scripts/cache-native-conformance.mjs` only: a chunk stored raw above the
/// compression floor must not have been strictly smaller compressed, and only
/// the writer's compressor can say so.
#[doc(hidden)]
pub fn deflate_raw_len(payload: &[u8]) -> usize {
    geometry::chunks::deflate_raw(payload).len()
}

/// Build a complete `.ifclite` cache for `source` (the IFC STEP bytes), in
/// memory: the pipeline retains every mesh.
pub fn build_cache(source: &[u8], options: CacheOptions) -> Result<(Vec<u8>, CacheStats), CacheError> {
    build::build(source, &options, format::Limits::FORMAT)
}

/// Build the same cache straight to `output`: byte-identical to
/// [`build_cache`] for the same input and options, without holding the mesh
/// set. The pipeline runs with `retain_meshes` off; each chunk is serialized
/// when it closes and appended to a spool file beside `output`, so only the
/// open chunks and the 44-byte directory entries stay in memory.
///
/// `output` appears complete or not at all: the cache is written to a
/// temporary file in the same directory, synced, then renamed over it. On
/// any error before the rename, the temporary file and the spool are removed
/// and an existing `output` is left untouched. An error from syncing the
/// parent directory after the rename (Unix) means `output` already holds the
/// complete new cache, but the rename may not survive a crash.
pub fn build_cache_to_path(source: &[u8], output: &Path, options: CacheOptions) -> Result<CacheStats, CacheError> {
    stream::build_to_path(source, output, &options, format::Limits::FORMAT, stream::BATCH_JOBS)
}
