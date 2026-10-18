// SPDX-License-Identifier: MPL-2.0
//! Production step admission; numerical builders consume owned inputs.
use super::work::{self, Execute};
use crate::processors::boolean::{BooleanClippingProcessor, operand, polygonal_prism,
    solid_execution, half_space_plan::HalfSpacePlan};
use crate::{BoolFailureReason, BoolOp, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

#[derive(Debug)]
pub(super) enum StepAdmission {
    Done((Mesh, bool)),
    Solid { operator: BoolOp, first: Mesh, operand: DecodedEntity },
}

impl BooleanClippingProcessor {
    /// Admit one step before a continuation evaluates its solid operand.
    /// `solo_step` identifies a true sole cutter; a sequential step with
    /// siblings must retain the existing stricter gate-rejection recovery.
    pub(super) fn begin_boolean_step(
        &self,
        entity: &DecodedEntity,
        mut mesh: Mesh,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        solo_step: bool,
    ) -> Result<StepAdmission> {
        crate::resource::check_current()?;
        // An unknown or unreadable operator is recorded BEFORE SecondOperand is
        // resolved: that operand is unused, and a `$` there must not turn the
        // record into an `Err` that drops the parent's host.
        let operator = match operand::boolean_operator(entity) {
            Ok(op @ (BoolOp::Difference | BoolOp::Union | BoolOp::Intersection)) => op,
            other => {
                let keyword = other.map_or_else(str::to_string, |op| op.to_string());
                self.record_failure(BoolOp::Unknown, BoolFailureReason::UnknownBooleanOperator(keyword));
                return Ok(StepAdmission::Done((mesh, false)));
            }
        };

        // Operand resolution follows operator admission. Half-space and
        // polygonal cutters retain their specialized production policies.
        let second_operand = self.second_operand_or_record(operator, entity, decoder);
        crate::resource::check_current()?;
        let Some(second_operand) = second_operand else {
            // INTERSECTION with nothing is nothing; the loss is on record.
            let dropped = operator == BoolOp::Intersection;
            return Ok(StepAdmission::Done(if dropped { (Mesh::new(), true) } else { (mesh, false) }));
        };

        if operator == BoolOp::Difference {
            let polygonal = second_operand.ifc_type == IfcType::IfcPolygonalBoundedHalfSpace;
            if polygonal || second_operand.ifc_type.is_subtype_of(IfcType::IfcHalfSpaceSolid) {
                let resolved = self.half_space_plane_or_record(&second_operand, decoder);
                crate::resource::check_current()?;
                let Some((point, normal, agreement)) = resolved
                    else { return Ok(StepAdmission::Done((mesh, false))) };
                let plane = HalfSpacePlan { point, normal, agreement };
                if !polygonal {
                    return crate::resource::observe(work::Plane { host: mesh, plane, fallback: false }
                        .execute(&self.effects).assemble(self)).map(StepAdmission::Done);
                }
                // No Position/contour/unit discovery before this numerical test.
                if polygonal_prism::host_stays_on_kept_side(&mesh, point, normal, agreement) {
                    return Ok(StepAdmission::Done((mesh, false)));
                }
                let admitted = crate::resource::observe(self.lower_bounded_prism(&second_operand, decoder, quality));
                if let Err(error @ crate::Error::ProgramStopped(_)) = admitted { return Err(error); }
                if let Ok(plan) = admitted {
                    let Some(plan) = plan else { return Ok(StepAdmission::Done((mesh, false))) };
                    let (host, built) = work::Prism { plan, host: mesh, plane }.execute(&self.effects).assemble(self);
                    mesh = host;
                    let built = crate::resource::observe(built);
                    if let Err(error @ crate::Error::ProgramStopped(_)) = built { return Err(error); }
                    if let Ok(cutter) = built {
                        // Unit lookup is reached only after the prism succeeds.
                        let units = decoder.length_unit_scale();
                        crate::resource::check_current()?;
                        let result = (work::Single { host: mesh, cutter, plane, solo_step,
                            length_unit_scale: units }).execute(&self.effects).assemble_single(self)?;
                        match result {
                            work::SingleResult::Done(value) => return Ok(StepAdmission::Done(value)),
                            work::SingleResult::Fallback(host) => mesh = host,
                        }
                    }
                }
                crate::resource::check_current()?;
                return crate::resource::observe(work::Plane { host: mesh, plane, fallback: true }
                    .execute(&self.effects).assemble(self)).map(StepAdmission::Done);
            }
        }

        Ok(StepAdmission::Solid { operator, first: mesh, operand: second_operand })
    }

    /// Finish only after the continuation has evaluated the solid operand.
    /// Empty and intentionally skipped cuts retain lazy unit discovery.
    pub(super) fn finish_solid_step(
        &self, operator: BoolOp, first: Mesh, second: (Mesh, bool),
        decoder: &mut EntityDecoder, quality: TessellationQuality,
    ) -> Result<(Mesh, bool)> {
        crate::resource::check_current()?;
        let (second_mesh, loss_recorded) = second;
        let mut plan = solid_execution::SolidBooleanPlan {
            operator,
            length_unit_scale: 1.,
            quality,
            skip_small_cuts: self.skip_small_cuts,
        };
        let admission = plan.admit(&first, &second_mesh);
        if admission == solid_execution::SolidAdmission::Kernel {
            // Preserve lazy unit discovery: skipped/empty cuts never needed it.
            plan.length_unit_scale = decoder.length_unit_scale();
            crate::resource::check_current()?;
        }
        crate::resource::observe(work::Solid { plan, first, second: second_mesh, loss_recorded, admission }
            .execute(&self.effects).assemble(self))
    }
}

#[cfg(test)]
#[path = "step_tests.rs"]
mod tests;
