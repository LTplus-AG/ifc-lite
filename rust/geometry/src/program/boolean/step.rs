// SPDX-License-Identifier: MPL-2.0
//! Reached step source admissions. Every numerical decision returns to polling.
use super::{BooleanState, Frame, Services, Steps, work};
use crate::processors::boolean::{operand, half_space_plan::HalfSpacePlan, solid_execution};
use crate::{BoolFailureReason, BoolOp, Mesh, Result};
use ifc_lite_core::{DecodedEntity, IfcType};

impl BooleanState {
    pub(super) fn begin_step(&mut self, entity: DecodedEntity, mesh: Mesh,
        mut steps: Steps, services: &mut Services<'_, '_>,
    ) -> Result<()> {
        crate::resource::check_current()?;
        let operator = match operand::boolean_operator(&entity) {
            Ok(op @ (BoolOp::Difference | BoolOp::Union | BoolOp::Intersection)) => op,
            other => {
                let keyword = other.map_or_else(str::to_string, |op| op.to_string());
                services.recorder.record_failure(BoolOp::Unknown,
                    BoolFailureReason::UnknownBooleanOperator(keyword));
                steps.accept((mesh, false));
                self.frames.push(Frame::Steps(steps));
                return Ok(());
            }
        };
        let second = services.recorder.second_operand_or_record(operator, &entity, services.decoder);
        crate::resource::check_current()?;
        let Some(second) = second else {
            steps.accept(if operator == BoolOp::Intersection { (Mesh::new(), true) } else { (mesh, false) });
            self.frames.push(Frame::Steps(steps));
            return Ok(());
        };
        if operator == BoolOp::Difference {
            let polygonal = second.ifc_type == IfcType::IfcPolygonalBoundedHalfSpace;
            if polygonal || second.ifc_type.is_subtype_of(IfcType::IfcHalfSpaceSolid) {
                self.frames.push(Frame::PlaneSource { steps, host: mesh, operand: second });
                return Ok(());
            }
        }
        let depth = steps.depth;
        self.frames.push(Frame::AfterStep { steps, operator, host: mesh });
        self.frames.push(Frame::Operand { entity: second, operator, depth });
        Ok(())
    }
    pub(super) fn plane_source(&mut self, mut steps: Steps, host: Mesh,
        operand: DecodedEntity, services: &mut Services<'_, '_>,
    ) -> Result<()> {
        let resolved = services.recorder.half_space_plane_or_record(&operand, services.decoder);
        crate::resource::check_current()?;
        let Some((point, normal, agreement)) = resolved else {
            steps.accept((host, false));
            self.frames.push(Frame::Steps(steps));
            return Ok(());
        };
        let plane = HalfSpacePlan { point, normal, agreement };
        if operand.ifc_type == IfcType::IfcPolygonalBoundedHalfSpace {
            self.frames.push(Frame::Numerical(work::Ready::Kept(work::KeptSide { host, plane }),
                work::Continuation::Kept { steps, operand, plane }));
        } else { self.plane(steps, host, plane, false); }
        Ok(())
    }
    pub(super) fn plane(&mut self, steps: Steps, host: Mesh, plane: HalfSpacePlan, fallback: bool) {
        self.frames.push(Frame::Numerical(work::Ready::Plane(work::Plane { host, plane, fallback }),
            work::Continuation::Step(steps)));
    }
    pub(super) fn prism_source(&mut self, mut steps: Steps, host: Mesh,
        operand: DecodedEntity, plane: HalfSpacePlan, services: &mut Services<'_, '_>,
    ) -> Result<()> {
        let admitted = crate::resource::observe(services.recorder.lower_bounded_prism(
            &operand, services.decoder, self.quality));
        match admitted {
            Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
            Ok(Some(plan)) => self.frames.push(Frame::Numerical(
                work::Ready::Prism(work::Prism { plan, host, plane }),
                work::Continuation::Prism { steps, plane })),
            Ok(None) => {
                steps.accept((host, false));
                self.frames.push(Frame::Steps(steps));
            }
            Err(_) => self.plane(steps, host, plane, true),
        }
        Ok(())
    }
    pub(super) fn solid(&mut self, steps: Steps, operator: BoolOp, first: Mesh) {
        let (second, loss_recorded) = self.value.take().expect("operand continuation value");
        let plan = solid_execution::SolidBooleanPlan { operator, length_unit_scale: 1.,
            quality: self.quality, skip_small_cuts: self.skip_small_cuts };
        self.frames.push(Frame::Numerical(work::Ready::SolidAdmission(work::SolidCheck {
            plan, first, second, loss_recorded }), work::Continuation::SolidAdmission(steps)));
    }
}

#[cfg(test)]
#[path = "step_tests.rs"]
mod tests;
