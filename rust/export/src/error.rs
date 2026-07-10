// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Typed export failures, so callers can fail closed instead of shipping a
//! structurally valid but empty artifact.

use std::fmt;

/// A failure the caller must handle; completion of a `try_export_*` function
/// implies a non-empty artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportError {
    /// The visible mesh set was empty: the model has no render geometry (or the
    /// caller's visibility filters removed all of it). The export would be a
    /// valid but empty file, which downstream tools accept silently, so this is
    /// surfaced as an error rather than an artifact.
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
}

impl ExportError {
    /// Stable machine-readable code, mirrored across the wasm boundary so TS
    /// callers can match on it without parsing prose.
    pub fn code(&self) -> &'static str {
        match self {
            ExportError::NoRenderGeometry => "NO_RENDER_GEOMETRY",
            ExportError::TooLarge { .. } => "TOO_LARGE",
            ExportError::Serialization { .. } => "SERIALIZATION_FAILED",
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
        }
    }
}

impl std::error::Error for ExportError {}
