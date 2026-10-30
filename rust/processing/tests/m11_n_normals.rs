// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: executable Cargo target for the production hand-mesh regressions.
//! Like m11_presentation, this includes the actual algorithm and storage. The
//! small containers below supply only its private module context; they grant no
//! numerical receipt or publication authority. Native tests prove publication.
use ifc_lite_geometry::{program::transactions::Resources as OwnedResourceContext, resource::{self, Reservation}};
use ifc_lite_processing::element::retained_runtime::{RetainedExecutionError, ShapePart};
mod runtime { pub use ifc_lite_processing::element::retained_runtime::RuntimeFault; }
mod publication { pub(super) use super::ShapePart; }
#[allow(dead_code)]
#[path = "../src/element/session_retained/storage.rs"]
mod storage;
use storage::Storage;
mod error {
    pub(super) fn budget_checkpoint() -> Result<(), super::RetainedExecutionError> {
        super::resource::budget_checkpoint().map_err(super::RetainedExecutionError::Geometry)
    }
}
#[allow(dead_code)]
#[path = "support/m11_n_normals_module.rs"]
mod presentation;
