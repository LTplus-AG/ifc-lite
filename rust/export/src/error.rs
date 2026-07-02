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
}

impl ExportError {
    /// Stable machine-readable code, mirrored across the wasm boundary so TS
    /// callers can match on it without parsing prose.
    pub fn code(&self) -> &'static str {
        match self {
            ExportError::NoRenderGeometry => "NO_RENDER_GEOMETRY",
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
        }
    }
}

impl std::error::Error for ExportError {}
