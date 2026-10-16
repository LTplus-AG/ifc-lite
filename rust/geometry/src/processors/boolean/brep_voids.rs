// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcFacetedBrepWithVoids` / `IfcAdvancedBrepWithVoids` as a boolean
//! operand (#7786): the solid is its Outer shell minus its Voids.
//!
//! The brep processors mesh attribute 0 (Outer) only, which is right for the
//! item on its own but, as a CUTTER, removes the material the voids leave
//! out: an over-cut, silently. The kernel subtracts the void shells (it
//! orients each operand outward itself, so either authored winding works).

use super::BooleanClippingProcessor;
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::router::builtin_processor;
use crate::{GroupCut, GroupReject, Mesh, TessellationQuality};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};

/// The plain-brep type whose processor meshes one shell given as attribute 0,
/// for a `*BrepWithVoids` type; `None` for every other type.
pub(super) fn brep_with_voids_shell_kind(ty: &IfcType) -> Option<IfcType> {
    match ty {
        IfcType::IfcFacetedBrepWithVoids => Some(IfcType::IfcFacetedBrep),
        IfcType::IfcAdvancedBrepWithVoids => Some(IfcType::IfcAdvancedBrep),
        _ => None,
    }
}

impl BooleanClippingProcessor {
    /// `outer` minus the operand's Voids (attribute 1), as a cutter for `op`.
    ///
    /// A void that cannot be meshed, or a subtract the kernel rejects, REFUSES
    /// the operand (empty mesh, ONE record, so the host stays uncut) rather
    /// than falling back to the Outer shell: that is the over-cut this exists
    /// to prevent (D3, fail closed with a counter). Voids that miss the Outer
    /// solid leave it as is: nothing to subtract, nothing refused.
    pub(super) fn without_voids(
        &self,
        shell_kind: IfcType,
        op: BoolOp,
        operand: &DecodedEntity,
        outer: Mesh,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> (Mesh, bool) {
        let refuse = |why: &str| {
            self.record_failure(
                op,
                BoolFailureReason::KernelError(format!("{} cutter voids: {why}", operand.ifc_type)),
            );
            (Mesh::new(), true)
        };
        let Some(voids) = operand.get(1).and_then(|attr| attr.as_list()) else {
            return (outer, false);
        };
        if voids.is_empty() || outer.is_empty() {
            return (outer, false);
        }
        let Some(processor) = builtin_processor(shell_kind.clone(), &self.schema) else {
            return refuse("no shell processor");
        };
        let mut void_meshes = Vec::with_capacity(voids.len());
        for void in voids {
            let Some(shell_id) = void.as_entity_ref() else { return refuse("void is not a shell reference") };
            // The plain brep type over this shell: the processors read the
            // shell from attribute 0 and nothing else.
            let as_brep = DecodedEntity::new(shell_id, shell_kind.clone(), vec![AttributeValue::EntityRef(shell_id)]);
            match processor.process(&as_brep, decoder, &self.schema, quality) {
                Ok(mesh) if !mesh.is_empty() => void_meshes.push(mesh),
                _ => return refuse("void shell did not mesh"),
            }
        }
        let clipper = crate::ClippingProcessor::with_unit_scale(decoder.length_unit_scale());
        let refs: Vec<&Mesh> = void_meshes.iter().collect();
        match clipper.subtract_mesh_many(&outer, &refs) {
            // No void reaches the Outer solid: the cutter IS its Outer shell.
            GroupCut::Rejected(GroupReject::NoOverlap | GroupReject::Unchanged) => (outer, false),
            GroupCut::Cut(hollow) | GroupCut::Retessellated(hollow) if !hollow.is_empty() => {
                self.absorb_failures(clipper.take_failures());
                (hollow, false)
            }
            // A refused cutter is ONE record: the kernel's own (InvalidOutput,
            // GateRejected) is replaced by the refusal, not counted twice.
            GroupCut::Rejected(reject) => {
                let _ = clipper.take_failures();
                refuse(&format!("subtract rejected ({reject:?})"))
            }
            // The voids engulf the Outer: nothing is left to cut with.
            GroupCut::Cut(_) | GroupCut::Retessellated(_) => {
                let _ = clipper.take_failures();
                refuse("voids engulf the outer shell")
            }
        }
    }
}
