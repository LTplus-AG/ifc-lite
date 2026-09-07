// SPDX-License-Identifier: MPL-2.0
//! `GeometryProcessor` wiring for `BooleanClippingProcessor`.
//!
//! Split out of `mod.rs` so that file stays inside its module-size ratchet
//! budget. Pure move: no behaviour change.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::super::super::diagnostics::BoolFailure;
use super::BooleanClippingProcessor;
use super::OperandPath;
use crate::router::GeometryProcessor;
use crate::{Mesh, Result, TessellationQuality};

impl GeometryProcessor for BooleanClippingProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        let mut visited = OperandPath::default();
        self.process_with_depth(entity, decoder, schema, 0, quality, &mut visited)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBooleanResult, IfcType::IfcBooleanClippingResult]
    }

    /// Hand the log to the router (#3821); rationale on the trait method.
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        self.take_failures()
    }
}

impl Default for BooleanClippingProcessor {
    fn default() -> Self {
        Self::new()
    }
}
