// SPDX-License-Identifier: MPL-2.0
//! Ordered owned void-shell source inputs for a `*BrepWithVoids` cutter and
//! the numerical subtraction they feed. Production admits one shell at a time
//! (an earlier empty shell stops before any later shell is read); the opt-in
//! construction graph lowers every shell eagerly through the same plans.
use super::super::{advanced_plan, brep::faceted_plan, diagnostic_capture};
use super::BooleanClippingProcessor;
use crate::{
    construction::ConstructionReports, BoolFailureReason, BoolOp, ClippingProcessor, GroupCut,
    GroupReject, Mesh, Result, TessellationQuality,
};
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

/// The plain-brep type whose shell is given as attribute 0, for a
/// `*BrepWithVoids` type.
#[derive(Debug, Clone, Copy)]
pub(crate) enum ShellKind {
    Faceted,
    Advanced,
}
impl ShellKind {
    pub(crate) fn from_type(ty: &IfcType) -> Option<Self> {
        match ty {
            IfcType::IfcFacetedBrep => Some(Self::Faceted),
            IfcType::IfcAdvancedBrep => Some(Self::Advanced),
            _ => None,
        }
    }
    fn ifc_type(self) -> IfcType {
        match self {
            Self::Faceted => IfcType::IfcFacetedBrep,
            Self::Advanced => IfcType::IfcAdvancedBrep,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) enum ShellPlan {
    Faceted(faceted_plan::FacetedBrepPlan),
    Advanced(advanced_plan::AdvancedBrepPlan),
}
impl ShellPlan {
    /// The plain brep type over this shell: the processors read the shell
    /// from attribute 0 and nothing else.
    pub(crate) fn lower(
        id: u32,
        kind: ShellKind,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<Self> {
        let entity = DecodedEntity::new(id, kind.ifc_type(), vec![AttributeValue::EntityRef(id)]);
        match kind {
            ShellKind::Faceted => faceted_plan::lower(&entity, decoder, None).map(Self::Faceted),
            ShellKind::Advanced => {
                advanced_plan::lower_brep(&entity, decoder, quality, None).map(Self::Advanced)
            }
        }
    }
    pub(crate) fn evaluate(self) -> Result<Mesh> {
        match self {
            Self::Faceted(plan) => Ok(plan.evaluate()),
            Self::Advanced(plan) => plan.evaluate(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VoidFault {
    NoShellProcessor,
    NotReference,
    ShellDidNotMesh,
}
impl VoidFault {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::NoShellProcessor => "no shell processor",
            Self::NotReference => "void is not a shell reference",
            Self::ShellDidNotMesh => "void shell did not mesh",
        }
    }
}

/// Ordered `Voids` of a `*BrepWithVoids` operand, or `None` when it has no (or
/// an empty) list: its cutter is its Outer shell as is.
pub(crate) fn void_refs(operand: &DecodedEntity) -> Option<&[AttributeValue]> {
    operand
        .get(slot::IfcFacetedBrepWithVoids::VOIDS.index())
        .and_then(|attr| attr.as_list())
        .filter(|voids| !voids.is_empty())
}

#[derive(Debug, Clone)]
struct Entry {
    shell: std::result::Result<ShellPlan, VoidFault>,
    reports: ConstructionReports,
}

/// All shell definitions of one operand, owned for later execution.
#[derive(Debug, Clone)]
pub(crate) struct VoidShellPlan {
    entries: Vec<Entry>,
    operand_type: IfcType,
}

pub(crate) enum VoidPreparation {
    Bypass,
    Ready(ReadyVoids),
    Refused,
}

impl VoidShellPlan {
    /// Own all shell definitions for later execution. This eager opt-in path
    /// can decode later shells before an earlier shell evaluates empty.
    pub(crate) fn lower(
        operand: &DecodedEntity,
        shell_kind: ShellKind,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Self {
        let mut entries = Vec::new();
        for value in void_refs(operand).unwrap_or_default() {
            let (shell, reports) = diagnostic_capture::capture(|| {
                let id = value.as_entity_ref().ok_or(VoidFault::NotReference)?;
                ShellPlan::lower(id, shell_kind, decoder, quality)
                    .map_err(|_| VoidFault::ShellDidNotMesh)
            });
            let terminal = shell.is_err();
            entries.push(Entry { shell, reports });
            if terminal {
                break;
            }
        }
        Self { entries, operand_type: operand.ifc_type.clone() }
    }

    pub(crate) fn source_reports(&self) -> ConstructionReports {
        let mut reports = ConstructionReports::default();
        for entry in &self.entries {
            reports.merge(entry.reports.clone());
        }
        reports
    }

    /// Evaluate only after the caller has established a nonempty Outer mesh.
    /// Prior shell reports are replayed before a terminal source refusal.
    pub(crate) fn evaluate_shells(
        self,
        recorder: &BooleanClippingProcessor,
        op: BoolOp,
    ) -> VoidPreparation {
        if self.entries.is_empty() {
            return VoidPreparation::Bypass;
        }
        let mut meshes = Vec::with_capacity(self.entries.len());
        for entry in self.entries {
            diagnostic_capture::restore(&entry.reports);
            let mesh = match entry.shell {
                Ok(plan) => plan.evaluate().map_err(|_| VoidFault::ShellDidNotMesh),
                Err(fault) => Err(fault),
            };
            match mesh {
                Ok(mesh) if !mesh.is_empty() => meshes.push(mesh),
                result => {
                    let fault = result.err().unwrap_or(VoidFault::ShellDidNotMesh);
                    refuse(recorder, op, &self.operand_type, fault.message());
                    return VoidPreparation::Refused;
                }
            }
        }
        VoidPreparation::Ready(ReadyVoids { meshes })
    }
}

/// Numerical intermediates produced from owned shell definitions, never stored
/// in a source plan. Unit discovery remains the caller's final admission step.
pub(crate) struct ReadyVoids {
    meshes: Vec<Mesh>,
}
impl ReadyVoids {
    pub(crate) fn new(meshes: Vec<Mesh>) -> Self {
        Self { meshes }
    }

    /// Subtract the ordered void meshes from `outer`. The kernel orients each
    /// operand outward itself, so either authored winding works. Rejections
    /// refuse with ONE record: the kernel's own failures are dropped.
    pub(crate) fn subtract(
        self,
        outer: Mesh,
        length_unit_scale: f64,
        recorder: &BooleanClippingProcessor,
        op: BoolOp,
        operand_type: &IfcType,
    ) -> (Mesh, bool) {
        let clipper = ClippingProcessor::with_unit_scale(length_unit_scale);
        let refs: Vec<&Mesh> = self.meshes.iter().collect();
        match clipper.subtract_mesh_many(&outer, &refs) {
            // No void reaches the Outer solid: the cutter IS its Outer shell.
            GroupCut::Rejected(GroupReject::NoOverlap | GroupReject::Unchanged) => (outer, false),
            GroupCut::Cut(hollow) | GroupCut::Retessellated(hollow) if !hollow.is_empty() => {
                recorder.absorb_failures(clipper.take_failures());
                (hollow, false)
            }
            GroupCut::Rejected(reject) => {
                let _ = clipper.take_failures();
                refuse(recorder, op, operand_type, &format!("subtract rejected ({reject:?})"))
            }
            // The voids engulf the Outer: nothing is left to cut with.
            GroupCut::Cut(_) | GroupCut::Retessellated(_) => {
                let _ = clipper.take_failures();
                refuse(recorder, op, operand_type, "voids engulf the outer shell")
            }
        }
    }
}

pub(crate) fn refuse(
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
