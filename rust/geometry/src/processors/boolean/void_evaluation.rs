// SPDX-License-Identifier: MPL-2.0
//! Numerical intermediates produced from owned shell definitions, never stored
//! in a source plan. Unit discovery remains the caller's final admission step.
use crate::processors::boolean::{BooleanClippingProcessor, NumericalEffects};
use crate::{BoolFailureReason, BoolOp, GroupCut, GroupReject, Mesh};
use ifc_lite_core::IfcType;

pub(crate) struct ReadyVoids {
    meshes: Vec<Mesh>,
}
impl ReadyVoids {
    pub(crate) fn new(meshes: Vec<Mesh>) -> Self {
        Self { meshes }
    }
    pub(crate) fn subtract(
        self,
        outer: Mesh,
        length_unit_scale: f64,
        recorder: &NumericalEffects,
        op: BoolOp,
        operand_type: &IfcType,
    ) -> (Mesh, bool) {
        let clipper = crate::ClippingProcessor::with_unit_scale(length_unit_scale);
        let refs: Vec<&Mesh> = self.meshes.iter().collect();
        match clipper.subtract_mesh_many(&outer, &refs) {
            GroupCut::Rejected(GroupReject::NoOverlap | GroupReject::Unchanged) => (outer, false),
            GroupCut::Cut(hollow) | GroupCut::Retessellated(hollow) if !hollow.is_empty() => {
                recorder.absorb_failures(clipper.take_failures());
                (hollow, false)
            }
            GroupCut::Rejected(reject) => {
                let _ = clipper.take_failures();
                refuse(
                    recorder,
                    op,
                    operand_type,
                    &format!("subtract rejected ({reject:?})"),
                )
            }
            GroupCut::Cut(_) | GroupCut::Retessellated(_) => {
                let _ = clipper.take_failures();
                refuse(recorder, op, operand_type, "voids engulf the outer shell")
            }
        }
    }
}

pub(crate) fn refuse(
    recorder: &NumericalEffects,
    op: BoolOp,
    operand_type: &IfcType,
    why: &str,
) -> (Mesh, bool) {
    recorder.record_failure(
        op,
        BoolFailureReason::KernelError(format!("{operand_type} cutter voids: {why}")),
    );
    (Mesh::new(), true)
}

/// Source admission refusals publish directly to the selected processor.
pub(crate) fn refuse_source(
    recorder: &BooleanClippingProcessor, op: BoolOp, operand_type: &IfcType, why: &str,
) -> (Mesh, bool) {
    refuse(&recorder.effects, op, operand_type, why)
}
