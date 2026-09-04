// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The [`GeometryProcessor`] trait: one IFC representation-item family in,
//! one mesh out, plus the diagnostics a processor accumulated while doing it.
//!
//! Split out of `router/mod.rs` so the drain hook below has room to carry its
//! own rationale (module-size ratchet).

use crate::tessellation::TessellationQuality;
use crate::{BoolFailure, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

/// Geometry processor trait
/// Each processor handles one type of IFC representation
pub trait GeometryProcessor {
    /// Process entity into mesh.
    ///
    /// `quality` selects tessellation detail; processors that approximate
    /// curves derive their segment counts from it via
    /// [`crate::tessellation::scale_segments`]. Processors with no curved
    /// geometry ignore it. [`TessellationQuality::Medium`] reproduces the
    /// engine's historical hardcoded behavior.
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh>;

    /// Get supported IFC types
    fn supported_types(&self) -> Vec<IfcType>;

    /// Drain the boolean / CSG failures this processor recorded while meshing.
    ///
    /// Default: none — most processors record nothing. Overridden by
    /// [`crate::processors::BooleanClippingProcessor`], whose failure log had
    /// no route out of the router at all before #3821: `take_failures` was
    /// called from tests only, so an unsupported operand, an
    /// `EmptyOperand` cutter and an unknown operator were recorded into a
    /// buffer that nothing ever read, and the pipeline reported a clean load.
    ///
    /// Drained by `GeometryRouter::drain_processor_failures`, which
    /// `take_csg_failures` calls, so every consumer of the router's CSG
    /// diagnostics — the native pipeline and the wasm batch path alike — sees
    /// these without a second opt-in.
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        Vec::new()
    }
}
