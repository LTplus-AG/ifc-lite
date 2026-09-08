// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One boolean operand -> one mesh.
//!
//! Split out of `boolean/mod.rs` (module-size ratchet) when the unsupported-
//! operand arm gained its diagnostic record (#3821).

use super::{
    BlockProcessor, BooleanClippingProcessor, CsgSolidProcessor, ExtrudedAreaSolidProcessor,
    FacetedBrepProcessor, OperandPath, RevolvedAreaSolidProcessor, SweptDiskSolidProcessor,
    TriangulatedFaceSetProcessor,
};
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::router::GeometryProcessor;
use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

impl BooleanClippingProcessor {
    /// Process a solid operand with depth tracking. The mesh only; callers
    /// that must not double-record an unsupported operand's consequence use
    /// [`Self::process_operand_checked`].
    ///
    /// Records an unsupported operand under [`BoolOp::Unknown`]: every caller
    /// here is meshing the BASE solid at the bottom of a left spine, which is
    /// read before any node's operator is, and whose loss empties the chain
    /// under every operator alike. Naming one node's operator would claim an
    /// attribution this path does not have.
    pub(super) fn process_operand_with_depth(
        &self,
        operand: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
    ) -> Result<Mesh> {
        Ok(self
            .process_operand_checked(BoolOp::Unknown, operand, decoder, depth, quality, visited)?
            .0)
    }

    /// Process a solid operand, reporting whether its type had NO meshing
    /// branch here.
    ///
    /// The flag exists because one dropped operand must produce ONE record. An
    /// unsupported SECOND operand meshes empty, so the `EmptyOperand` arm at
    /// the caller would fire straight after the `UnsupportedOperand` record
    /// below, counting the same step twice — and since the reason breakdown
    /// breaks ties alphabetically, the viewer's "top failure reason" would name
    /// `EmptyOperand`, the CONSEQUENCE, over `UnsupportedOperand`, the cause.
    /// Callers pass this to [`Self::record_empty_second_operand`].
    ///
    /// `op` is the operation whose operand this is, and it goes into the
    /// `UnsupportedOperand` record. Since that record is then the ONLY one for
    /// the dropped step, recording `Unknown` for an operand of an authored
    /// `.DIFFERENCE.` would render "UNKNOWN failed" as the whole story a
    /// consumer of `take_csg_failures` ever gets for it.
    pub(super) fn process_operand_checked(
        &self,
        op: BoolOp,
        operand: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
    ) -> Result<(Mesh, bool)> {
        let mut unsupported = false;
        let mesh = match operand.ifc_type {
            IfcType::IfcExtrudedAreaSolid => {
                let processor = ExtrudedAreaSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcFacetedBrep => {
                let processor = FacetedBrepProcessor::new();
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcTriangulatedFaceSet => {
                let processor = TriangulatedFaceSetProcessor::new();
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcSweptDiskSolid => {
                let processor = SweptDiskSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcRevolvedAreaSolid => {
                let processor = RevolvedAreaSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcBlock => {
                BlockProcessor::new().process(operand, decoder, &self.schema, quality)
            }
            // `CsgSolidProcessor::process` builds a FRESH BooleanClippingProcessor
            // for a boolean TreeRootExpression, so routing through it used to reset
            // both `depth` and the cycle guard. `#10 IfcBooleanResult -> FirstOperand
            // #20 IfcCsgSolid -> TreeRootExpression #10` then recursed forever with
            // depth never passing 1, and a Rust stack overflow ABORTS (#2866).
            // `depth` restarts at 0 here, as it did before this guard existed
            // (the hop built a fresh processor). Carrying it would tighten
            // MAX_BOOLEAN_DEPTH, which #960 calibrated against a per-processor
            // reset: 8 booleans + a CsgSolid + 8 more is valid, resolves on
            // main, and would error as "depth 11 exceeds limit 10", dropping
            // the element. MAX_OPERAND_PATH_NODES bounds the stack across the
            // hop instead, counting frames of both kinds.
            IfcType::IfcCsgSolid => {
                // Transient, like the `ClippingProcessor`s below: it is not on
                // any router, so its log has to come back here or it dies with
                // it. `self` IS router-held, so this is the whole route out
                // (#3821) — no thread-local, no cross-router leak.
                let csg = CsgSolidProcessor::with_skip_small_cuts(self.skip_small_cuts);
                let out = csg.process_with_boolean_cycle_guard(
                    operand,
                    decoder,
                    &self.schema,
                    0,
                    quality,
                    visited,
                );
                self.absorb_failures(csg.take_failures());
                out
            }
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                // Recursive case with depth tracking
                self.process_with_depth(operand, decoder, &self.schema, depth + 1, quality, visited)
            }
            // No meshing branch for this operand type: the operand resolves to
            // an EMPTY mesh. As a FIRST operand that empties the whole boolean
            // result and the element's item renders nothing; as a SECOND
            // operand it means an unsupported cutter and the host renders
            // un-cut. Returning `Err` here would be wrong for the second case
            // — it would delete the host as well — so the arm keeps returning
            // an empty mesh and RECORDS the loss instead (#3821). Before this,
            // the only base-operand drop in the whole boolean path left no
            // trace at all, not even in a debug build.
            other => {
                self.record_failure(op, BoolFailureReason::UnsupportedOperand(other.to_string()));
                unsupported = true;
                Ok(Mesh::new())
            }
        }?;
        Ok((mesh, unsupported))
    }
}
