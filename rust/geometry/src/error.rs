// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use thiserror::Error;

/// Result type for geometry operations
pub type Result<T> = std::result::Result<T, Error>;

/// Errors that can occur during geometry processing
#[derive(Error, Debug)]
pub enum Error {
    #[error("Retained contract refused: {0}")]
    RetainedContract(#[from] crate::document::RetainedRefusal),

    #[error(transparent)]
    ProgramStopped(#[from] crate::resource::ProgramStop),

    #[error("Triangulation failed: {0}")]
    TriangulationError(String),

    #[error("Invalid profile: {0}")]
    InvalidProfile(String),

    #[error("Invalid extrusion parameters: {0}")]
    InvalidExtrusion(String),

    #[error("Empty mesh: {0}")]
    EmptyMesh(String),

    #[error("Geometry processing error: {0}")]
    GeometryError(String),

    #[error("Core parser error: {0}")]
    CoreError(#[from] ifc_lite_core::Error),
}

impl Error {
    /// Create a geometry processing error
    pub fn geometry(msg: impl Into<String>) -> Self {
        Self::GeometryError(msg.into())
    }
}
