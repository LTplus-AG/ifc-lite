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
    /// `-parquet-v6`: occurrences of one shape share a block of vertices,
    /// placed by `world = origin + R * p` via the `rot0..rot8` columns.
    #[serde(rename = "shared-shapes")]
    SharedShapes,
}

impl ParquetLayout {
    /// Whether the mesh table carries `rot0..rot8`.
    ///
    /// Follows the LAYOUT, not the plan: the streaming route shares nothing
    /// (its sharing could only be batch-local) yet still emits the columns as
    /// identity when the client asked for this layout, so that everything
    /// stored under the v6 key is a v6 payload.
    pub(crate) fn has_rotation(self) -> bool {
        self == Self::SharedShapes
    }

    /// The cache-key suffix naming this layout.
    pub(crate) fn cache_suffix(self) -> &'static str {
        match self {
            Self::Flat => "parquet-v5",
            Self::SharedShapes => "parquet-v6",
        }
    }
}
