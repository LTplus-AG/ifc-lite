// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The flat-Parquet mesh-table layout a request asked for.
//!
//! Its own module because it is the WIRE CONTRACT, not an implementation
//! detail of the writer: the route reads it off the query, the cache key is
//! built from it, the schema is chosen by it, and the client sends it. One
//! definition keeps those four in step.

/// Which flat-Parquet mesh-table layout a request asked for.
///
/// OPT-IN, defaulting to [`Self::Flat`], and that default is the whole point.
/// The flat wire carries no version byte (unlike `/optimized`), so a client
/// that predates the shared layout cannot fail loud on one — it decodes a
/// shared blob without error and draws every occurrence of a shared shape at
/// the template's placement. A server cannot tell those clients apart, so it
/// must not produce the new layout unless the client says it understands it.
/// Serving a smaller payload is not worth silently drawing the wrong building.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
pub enum ParquetLayout {
    /// `-parquet-v5`: one block of vertices per mesh row, no rotation columns.
    /// Byte-identical to what the route emitted before issue #3888.
    #[default]
    #[serde(rename = "flat")]
    Flat,
    /// `-parquet-v7`: occurrences of one shape share a block of vertices,
    /// placed by `world = origin + R * p` via the `rot0..rot8` columns. `v7` =
    /// `v6`'s schema plus a second, content-hash sharing stage
    /// (`ShapePlan::shared_shapes`, issue #5130): `v6` only ran the
    /// rotation-aware collator, so a model whose repeats are bit-identical but
    /// not `IfcMappedItem`/`IfcRepresentationMap` occurrences (the common case
    /// on models with no instancing metadata at all) shared nothing and paid
    /// for nine all-identity `rot*` columns on every row for nothing.
    #[serde(rename = "shared-shapes")]
    SharedShapes,
}

impl ParquetLayout {
    /// Whether the mesh table carries `rot0..rot8`.
    ///
    /// Follows the LAYOUT, not the plan: the streaming route shares nothing
    /// unless the client also sent [`StreamShapes::CrossBatch`], yet still
    /// emits the columns as identity when the client asked for this layout,
    /// so that everything stored under the v7 key is a v7 payload.
    pub(crate) fn has_rotation(self) -> bool {
        self == Self::SharedShapes
    }

    /// The cache-key suffix naming this layout.
    pub(crate) fn cache_suffix(self) -> &'static str {
        match self {
            Self::Flat => "parquet-v5",
            Self::SharedShapes => "parquet-v7",
        }
    }
}

/// How the streaming route's batches may reference shapes (#5407). Read only by
/// `POST /api/v1/parse/parquet-stream`, and only meaningful on the
/// shared-shapes layout.
///
/// OPT-IN for the same reason [`ParquetLayout`] is, one level down. A client
/// that sends `parquet_layout=shared-shapes` today decodes every batch on its
/// own, against that batch's own vertex table; a mesh row pointing into an
/// EARLIER batch's vertices would read as out of range at best, or as a
/// different shape's vertices at worst. So the stream shares across batches
/// only for a client that says it keeps earlier batches' shapes, and every
/// batch it sends that way states its `vertex_base` / `index_base` in the
/// event, which is how the client knows the server honoured the request.
///
/// Not part of the cache identity: a cross-batch stream fills the SAME v7
/// entry a batch-local one does, because both are valid whole-model v7 blobs
/// (whole-stream offsets, one row group per batch). What differs is how a
/// cached replay may split one back into batches; see `split_into_batches`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
pub enum StreamShapes {
    /// Every batch is self-contained: its mesh rows index its own vertex and
    /// index tables. The only behaviour before #5407.
    #[default]
    #[serde(rename = "batch-local")]
    BatchLocal,
    /// A batch carries only the shapes no earlier batch emitted, and its mesh
    /// rows index the whole stream's vertex/index tables.
    #[serde(rename = "cross-batch")]
    CrossBatch,
}
