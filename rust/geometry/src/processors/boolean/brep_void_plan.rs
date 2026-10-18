// SPDX-License-Identifier: MPL-2.0
//! Ordered owned void-shell source inputs. Eager graph lowering is distinct
//! from production's conditional shell-by-shell admission.
use super::super::super::{advanced_plan, brep::faceted_plan, diagnostic_capture};
use super::BooleanClippingProcessor;
use crate::{construction::ConstructionReports, BoolOp, Mesh, Result, TessellationQuality};
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

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
    NoProcessor,
    NotReference,
    ShellDidNotMesh,
}
impl VoidFault {
    pub(super) fn message(self) -> &'static str {
        match self {
            Self::NoProcessor => "no shell processor",
            Self::NotReference => "void is not a shell reference",
            Self::ShellDidNotMesh => "void shell did not mesh",
        }
    }
}
#[derive(Debug, Clone)]
struct Entry {
    shell: std::result::Result<ShellPlan, VoidFault>,
    reports: ConstructionReports,
}

#[derive(Debug, Clone)]
pub(crate) struct VoidShellPlan {
    entries: Vec<Entry>,
    operand_type: IfcType,
}

pub(crate) enum VoidPreparation {
    Bypass,
    Ready(super::void_evaluation::ReadyVoids),
    Refused,
}

impl VoidShellPlan {
    /// Own all shell definitions for later execution. This eager opt-in path
    /// can decode later shells before an earlier shell evaluates empty; the
    /// production wrapper deliberately uses ShellPlan one shell at a time.
    pub(crate) fn lower(
        operand: &DecodedEntity,
        shell_kind: &IfcType,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Self {
        let mut entries = Vec::new();
        if let Some(voids) = void_refs(operand).filter(|voids| !voids.is_empty()) {
            if let Some(kind) = ShellKind::from_type(shell_kind) {
                for value in voids {
                    let (shell, reports) = diagnostic_capture::capture(|| {
                        let id = value.as_entity_ref().ok_or(VoidFault::NotReference)?;
                        ShellPlan::lower(id, kind, decoder, quality)
                            .map_err(|_| VoidFault::ShellDidNotMesh)
                    });
                    let terminal = shell.is_err();
                    entries.push(Entry { shell, reports });
                    if terminal {
                        break;
                    }
                }
            } else {
                entries.push(Entry {
                    shell: Err(VoidFault::NoProcessor),
                    reports: Default::default(),
                });
            }
        }
        Self {
            entries,
            operand_type: operand.ifc_type.clone(),
        }
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
                    super::void_evaluation::refuse(
                        recorder,
                        op,
                        &self.operand_type,
                        fault.message(),
                    );
                    return VoidPreparation::Refused;
                }
            }
        }
        VoidPreparation::Ready(super::void_evaluation::ReadyVoids::new(meshes))
    }
}

pub(super) fn void_refs(operand: &DecodedEntity) -> Option<&[AttributeValue]> {
    operand
        .get(slot::IfcFacetedBrepWithVoids::VOIDS.index())
        .and_then(|attr| attr.as_list())
}

#[cfg(test)]
#[path = "brep_void_plan_tests.rs"]
mod tests;
