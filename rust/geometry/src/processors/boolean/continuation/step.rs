// SPDX-License-Identifier: MPL-2.0
//! One spine node's operator and SecondOperand, split at the only point that
//! needs another operand meshed: the solid/solid case suspends here and
//! resumes in [`BooleanClippingProcessor::finish_solid_step`].
//!
//! `solo_step`: true when this is the ONLY node the spine walk deferred to (a
//! genuine single-PBHS-cutter DIFFERENCE, #3923's target shape); false when it
//! is one of several nodes from a longer authored chain that could not be
//! batched and is applied one cutter at a time. It gates the
//! accept-gate-rejection fallback (see `single_cutter_gate.rs`).
use super::super::half_space_plan::HalfSpacePlan;
use super::super::single_cutter_gate::SingleCutterSubtract;
use super::super::solid_execution::SolidBooleanPlan;
use super::super::{boolean_operator, polygonal_prism, BooleanClippingProcessor};
use super::state::Value;
use crate::{BoolFailureReason, BoolOp, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

/// The outcome of admitting one step's source.
pub(super) enum StepAdmission {
    /// The step resolved without meshing another operand.
    Done(Value),
    /// Solid/solid: mesh `operand`, then call `finish_solid_step`.
    Solid { operator: BoolOp, first: Mesh, operand: DecodedEntity },
}

impl BooleanClippingProcessor {
    pub(super) fn begin_boolean_step(
        &self,
        entity: &DecodedEntity,
        mesh: Mesh,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        solo_step: bool,
    ) -> Result<StepAdmission> {
        // An unknown or unreadable operator is recorded BEFORE SecondOperand is
        // resolved: that operand is unused, and a `$` there must not turn the
        // record into an `Err` that drops the parent's host.
        let operator = match boolean_operator(entity) {
            Ok(op @ (BoolOp::Difference | BoolOp::Union | BoolOp::Intersection)) => op,
            other => {
                let keyword = other.map_or_else(str::to_string, |op| op.to_string());
                self.record_failure(BoolOp::Unknown, BoolFailureReason::UnknownBooleanOperator(keyword));
                return Ok(StepAdmission::Done((mesh, false)));
            }
        };

        // Sequential, one step per spine node (web-ifc's behaviour): the
        // per-step cutter is always a single closed manifold prism, so the
        // non-manifold-cutter artefacts of mesh-merged batching (#583) cannot
        // arise. Grouped batching of provably safe PBHS chains is the walk's
        // `cut_polygonal_chain` (#960).
        let Some(second_operand) = self.second_operand_or_record(operator, entity, decoder) else {
            // INTERSECTION with nothing is nothing; the loss is on record.
            let dropped = operator == BoolOp::Intersection;
            return Ok(StepAdmission::Done(if dropped { (Mesh::new(), true) } else { (mesh, false) }));
        };

        if operator == BoolOp::Difference {
            let polygonal = second_operand.ifc_type == IfcType::IfcPolygonalBoundedHalfSpace;
            // Any other IfcHalfSpaceSolid is a plane clip: an IfcBoxedHalfSpace's
            // Enclosure is only a computation hint (#7688 PROC-S19).
            if !polygonal && second_operand.ifc_type.is_subtype_of(IfcType::IfcHalfSpaceSolid) {
                let Some((point, normal, agreement)) =
                    self.half_space_plane_or_record(&second_operand, decoder)
                else {
                    return Ok(StepAdmission::Done((mesh, false)));
                };
                let clipped = HalfSpacePlan::new(point, normal, agreement).clip(&mesh)?;
                return Ok(StepAdmission::Done((
                    self.guard_against_full_host_removal(mesh, clipped, point, normal),
                    false,
                )));
            }
            if polygonal {
                return self
                    .polygonal_step(&second_operand, mesh, decoder, quality, solo_step)
                    .map(StepAdmission::Done);
            }
            // Solid-solid difference on the exact kernel (no operand-size
            // cap); see `solid_execution.rs` for the admission policy.
        }
        // UNION (a real CSG union, overlap removed) and INTERSECTION (the
        // overlap volume) on the pure-Rust exact kernel.
        Ok(StepAdmission::Solid { operator, first: mesh, operand: second_operand })
    }

    fn polygonal_step(
        &self,
        second_operand: &DecodedEntity,
        mesh: Mesh,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        solo_step: bool,
    ) -> Result<Value> {
        let Some((point, normal, agreement)) =
            self.half_space_plane_or_record(second_operand, decoder)
        else {
            return Ok((mesh, false));
        };
        if polygonal_prism::host_stays_on_kept_side(&mesh, point, normal, agreement) {
            return Ok((mesh, false));
        }
        if let Ok(built) = self.build_polygonal_bounded_half_space_mesh(
            second_operand, decoder, &mesh, (point, normal, agreement), quality)
        {
            // `None`: boundary over the vertex cap, refused on record (#7786).
            let Some(bound_mesh) = built else { return Ok((mesh, false)) };
            // `single_cutter_gate.rs`: the #3919/#3923 gate and `solo_step`.
            match self.resolve_single_cutter_subtract(
                &mesh, &bound_mesh, solo_step, decoder.length_unit_scale())
            {
                SingleCutterSubtract::Clipped(clipped) => {
                    return Ok((self.guard_against_full_host_removal(mesh, clipped, point, normal), false));
                }
                SingleCutterSubtract::KeepUncut => return Ok((mesh, false)),
                SingleCutterSubtract::FallThrough => {}
            }
        }
        // The bounded prism subtract (or its build) failed. The unbounded
        // plane clip IS applied, but it is a strict superset of the bounded
        // cut: the polygonal boundary is silently dropped. Flag the loss.
        self.record_failure(BoolOp::Difference, BoolFailureReason::PolygonalBoundedHalfSpaceFallback);
        let clipped = HalfSpacePlan::new(point, normal, agreement).clip(&mesh)?;
        Ok((self.guard_against_full_host_removal(mesh, clipped, point, normal), false))
    }

    /// Resume a suspended solid/solid step with its meshed operand.
    pub(super) fn finish_solid_step(
        &self,
        operator: BoolOp,
        host: Mesh,
        (second, loss_recorded): Value,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<Value> {
        // The unit scale is read after the operand: it can be discovered late.
        SolidBooleanPlan {
            operator,
            length_unit_scale: decoder.length_unit_scale(),
            quality,
            skip_small_cuts: self.skip_small_cuts,
        }
        .evaluate(self, host, second, loss_recorded)
    }
}
