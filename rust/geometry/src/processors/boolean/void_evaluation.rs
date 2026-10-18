// SPDX-License-Identifier: MPL-2.0
//! Numerical intermediates produced from owned shell definitions, never stored
//! in a source plan. Unit discovery remains the caller's final admission step.
use super::BooleanClippingProcessor;
use crate::{BoolFailureReason, BoolOp, GroupCut, GroupReject, Mesh};
use ifc_lite_core::IfcType;

pub(crate) struct ReadyVoids {
    meshes: Vec<Mesh>,
}
impl ReadyVoids {
    pub(super) fn new(meshes: Vec<Mesh>) -> Self {
        Self { meshes }
    }
    pub(crate) fn subtract(
        self,
        outer: Mesh,
        length_unit_scale: f64,
        recorder: &BooleanClippingProcessor,
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

pub(super) fn refuse(
    recorder: &BooleanClippingProcessor,
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
