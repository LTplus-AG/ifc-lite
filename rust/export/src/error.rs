// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Typed export failures, so callers can fail closed instead of shipping an
//! empty artifact.

use std::fmt;

/// A failure the caller must handle; completion of a `try_export_*` function
/// implies a non-empty artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportError {
    /// The visible mesh set was empty: the model has no render geometry (or the
    /// caller's visibility filters removed all of it). The export would not be a
    /// valid file: an empty GLB has empty `accessors`, `bufferViews`, `meshes`
    /// and `nodes` arrays (glTF schema `minItems: 1`) and a zero
    /// `buffers[0].byteLength` (schema `minimum: 1`), and an empty COLLADA
    /// document has empty libraries its schema requires children in. Some
    /// downstream tools still accept such a file silently, so this is surfaced
    /// as an error rather than an artifact.
    NoRenderGeometry,
    /// The projected single-GLB output exceeds the glTF 32-bit (4 GiB) container
    /// / buffer limit — the model is too large for one GLB and must be exported
    /// as a multi-buffer glTF instead. Carries the projected total container size
    /// in bytes (from pass 1), so a caller can log it or size a buffer split
    /// without re-meshing. Replaces the historical 4 GiB `panic!` on the checked
    /// export paths (issue #1516).
    TooLarge {
        /// Projected total GLB container size in bytes (may be a lower bound once
        /// oversize; see [`crate::GlbSizeProjection::total_bytes`]).
        bytes: u64,
    },
    /// A downstream encoder (Arrow/Parquet columnar writer, ZIP container, or
    /// JSON serializer) rejected the data it was handed. This is an I/O/library
    /// failure rather than a business-logic outcome — replaces panicking
    /// `.unwrap()`/`.expect()` calls on writer/serializer results so a malformed
    /// or resource-exhausted encode returns an error instead of unwinding the
    /// whole export (see the `parquet_bos` exporter).
    Serialization {
        /// What was being serialized/written (e.g. "entities batch", "zip write_all").
        stage: &'static str,
        /// The underlying error's `Display` output.
        detail: String,
    },
    /// A from-meshes writer was handed inconsistent inputs. Two shapes, and
    /// they fail differently:
    ///
    /// * a COUNT that runs past a buffer — the per-mesh `vertex_counts` /
    ///   `index_counts` sum past the end of the flattened `positions` /
    ///   `normals` / `indices`. The crate-private infallible GLB assembler
    ///   silently drops the un-backed tail (a valid GLB missing part of the
    ///   model, reported as success);
    /// * an index BLOCK that is not whole triangles, or an index VALUE that is
    ///   not a vertex of its own mesh. The GLB assembler copies the index
    ///   buffer verbatim, so either reaches the file and glTF-Validator rejects
    ///   the result (glTF 2.0 3.7.2.1).
    ///
    /// `try_export_glb_from_meshes` and `try_export_collada_from_meshes` surface
    /// both, through one index-block predicate (#4684), so a caller bug can't
    /// ship truncated or invalid geometry from either.
    MalformedMeshInput {
        /// Which buffer was too short (expected vs actual lengths), or which
        /// mesh carried which out-of-range index.
        detail: String,
    },
}

impl ExportError {
    /// Stable machine-readable code, mirrored across the wasm boundary so TS
    /// callers can match on it without parsing prose.
    pub fn code(&self) -> &'static str {
        match self {
            ExportError::NoRenderGeometry => "NO_RENDER_GEOMETRY",
            ExportError::TooLarge { .. } => "TOO_LARGE",
            ExportError::Serialization { .. } => "SERIALIZATION_FAILED",
            ExportError::MalformedMeshInput { .. } => "MALFORMED_MESH_INPUT",
        }
    }
}

impl fmt::Display for ExportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ExportError::NoRenderGeometry => write!(
                f,
                "{}: export produced no render geometry (empty model or all meshes filtered out)",
                self.code()
            ),
            ExportError::TooLarge { bytes } => write!(
                f,
                "{}: projected GLB is {bytes} bytes, over the glTF 32-bit (4 GiB) limit; \
                 export as a multi-buffer glTF instead",
                self.code()
            ),
            ExportError::Serialization { stage, detail } => {
                write!(f, "{}: failed to serialize {stage}: {detail}", self.code())
            }
            ExportError::MalformedMeshInput { detail } => {
                write!(f, "{}: from-meshes inputs are inconsistent: {detail}", self.code())
            }
        }
    }
}

impl std::error::Error for ExportError {}

/// The one empty-export rule (#7695). Every render-geometry writer (GLB, the
/// multi-buffer glTF, COLLADA, KMZ, OBJ, USD) calls this with the number of
/// meshes it actually wrote, after the caller's visibility filters and its own
/// emittable-mesh gate, before it hands out an artifact.
///
/// What counts as exportable depends on the format:
///
/// * **Render geometry** (the formats above): at least one emitted mesh. With
///   none, every one of them is either schema-invalid (glTF `minItems: 1`,
///   empty COLLADA libraries) or a file with nothing to look at (a header-only
///   OBJ, a `/World`-only USD stage), so it is [`ExportError::NoRenderGeometry`].
///   A model that has only non-geometric data is empty here.
/// * **Data** (CSV, JSON, JSON-LD, IFCX, STEP, BOS, HBJSON, DFJSON): a row,
///   node, entity or room. Zero of them is still a valid empty document (a
///   header-only table, an empty `@graph`, a model without rooms), so these
///   never call this; they report the count instead (the TS `count*`
///   helpers, `HbjsonStats::rooms`, `StepStats`), and a caller that wants a
///   non-empty result checks that count.
///
/// The cross-language vectors are `tests/fixtures/empty_export_vectors.json`.
pub(crate) fn require_render_geometry(meshes_written: usize) -> Result<(), ExportError> {
    if meshes_written == 0 {
        return Err(ExportError::NoRenderGeometry);
    }
    Ok(())
}
